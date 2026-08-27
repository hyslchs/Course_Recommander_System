#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly PROJECT_NAME="${COMPOSE_PROJECT_NAME:-crs-production}"
readonly BUNDLE_DIR="${CRS_ARTIFACT_BUNDLE_DIR:-/home/hyslchs/crs-artifact-bundles/1151-embeddinggemma-768-r57c266a-c9935a9392ab}"
readonly LIVE_URL="${CRS_LIVE_URL:-http://127.0.0.1:8080/health/live}"
readonly READY_URL="${CRS_READY_URL:-http://127.0.0.1:8080/health/ready}"
readonly PUBLIC_READY_URL="${CRS_PUBLIC_READY_URL:-https://crs.sixhuang.com/health/ready}"
readonly HEALTH_TIMEOUT_SECONDS="${CRS_HEALTH_TIMEOUT_SECONDS:-240}"

readonly APP_CONTAINER="${PROJECT_NAME}-crs-app-1"

cutover_started=0
previous_legacy_container=""
previous_container_was_running=0

cd -- "$SCRIPT_DIR"

die() {
  printf 'deploy.sh: %s\n' "$*" >&2
  exit 1
}

rollback_on_error() {
  local exit_code=$?
  local failed_container
  local failed_name

  if [ "$exit_code" -eq 0 ] || [ "$cutover_started" -eq 0 ]; then
    return "$exit_code"
  fi

  printf 'deploy.sh: deployment failed; preserving failed container and restoring previous container\n' >&2

  failed_container="$(docker inspect "$APP_CONTAINER" 2>/dev/null || true)"
  if [ -n "$failed_container" ]; then
    docker stop "$APP_CONTAINER" >/dev/null 2>&1 || true
    failed_name="${PROJECT_NAME}-failed-$(date +%Y%m%d%H%M%S)"
    while docker inspect "$failed_name" >/dev/null 2>&1; do
      failed_name="${failed_name}-1"
    done
    docker rename "$APP_CONTAINER" "$failed_name" >/dev/null 2>&1 || true
  fi

  if [ -n "$previous_legacy_container" ] && \
     docker inspect "$previous_legacy_container" >/dev/null 2>&1; then
    docker rename "$previous_legacy_container" "$APP_CONTAINER" >/dev/null 2>&1 || true
    if [ "$previous_container_was_running" -eq 1 ]; then
      docker start "$APP_CONTAINER" >/dev/null 2>&1 || true
    fi
  elif docker inspect "$APP_CONTAINER" >/dev/null 2>&1 && \
       [ "$previous_container_was_running" -eq 1 ]; then
    docker start "$APP_CONTAINER" >/dev/null 2>&1 || true
  fi

  return "$exit_code"
}
require_command() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

require_command git
require_command docker
require_command curl
require_command python3

trap rollback_on_error EXIT

[ -f .env ] || die '.env is missing'
[ "$(stat -c '%a' .env)" = 600 ] || die '.env must have mode 600'
[ -f compose.yaml ] || die 'compose.yaml is missing'
[ -f compose.build.yaml ] || die 'compose.build.yaml is missing'
[ -x scripts/verify_artifact_bundle.py ] || die 'artifact verifier is missing or not executable'
[ -d "$BUNDLE_DIR" ] || die "artifact bundle is missing: $BUNDLE_DIR"

if [ -n "$(git status --porcelain=v1)" ]; then
  die 'deployment worktree is dirty; refusing to deploy'
fi

printf 'deploy: pulling main with fast-forward only\n'
git pull --ff-only origin main

if [ -n "$(git status --porcelain=v1)" ]; then
  die 'git pull produced a dirty worktree; refusing to deploy'
fi

printf 'deploy: verifying immutable artifact bundle\n'
python3 scripts/verify_artifact_bundle.py --bundle "$BUNDLE_DIR"

printf 'deploy: building image with verified named context\n'
CRS_ARTIFACT_BUNDLE_DIR="$BUNDLE_DIR" \
  docker compose --project-name "$PROJECT_NAME" \
    -f compose.yaml -f compose.build.yaml build

printf 'deploy: preserving previous application container before cutover\n'
cutover_started=1
if docker inspect "$APP_CONTAINER" >/dev/null 2>&1; then
  previous_legacy_container="${PROJECT_NAME}-legacy-$(date +%Y%m%d%H%M%S)"
  while docker inspect "$previous_legacy_container" >/dev/null 2>&1; do
    previous_legacy_container="${previous_legacy_container}-1"
  done
  if [ "$(docker inspect --format '{{.State.Running}}' "$APP_CONTAINER")" = true ]; then
    previous_container_was_running=1
    docker stop "$APP_CONTAINER"
  fi
  docker rename "$APP_CONTAINER" "$previous_legacy_container"
fi

printf 'deploy: starting immutable image\n'
docker compose --project-name "$PROJECT_NAME" \
  -f compose.yaml up -d --no-build

deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECONDS ))
container_id=""
while :; do
  container_id="$(docker compose --project-name "$PROJECT_NAME" \
    -f compose.yaml ps -q crs-app)"
  health=""
  if [ -n "$container_id" ]; then
    health="$(docker inspect --format '{{.State.Health.Status}}' "$container_id" 2>/dev/null || true)"
  fi
  if [ "$health" = healthy ] && \
     curl --fail --silent --show-error --max-time 5 "$READY_URL" >/dev/null 2>&1; then
    break
  fi
  [ "$(date +%s)" -lt "$deadline" ] || die "readiness timeout: $READY_URL"
  sleep 2
done

curl --fail --silent --show-error --max-time 5 "$LIVE_URL" >/dev/null
curl --fail --silent --show-error --max-time 5 "$READY_URL" >/dev/null

[ -n "$container_id" ] || die 'Compose did not report the application container'
health=$(docker inspect --format '{{.State.Health.Status}}' "$container_id")
[ "$health" = healthy ] || die "container health is $health"

if [ "${CRS_SKIP_PUBLIC_HEALTH:-0}" != 1 ]; then
  printf 'deploy: checking public readiness endpoint\n'
  curl --fail --silent --show-error --max-time 15 "$PUBLIC_READY_URL" >/dev/null \
    || die "public readiness failed: $PUBLIC_READY_URL"
fi

cutover_started=0
printf 'deploy: success project=%s container=%s health=%s image=%s\n' \
  "$PROJECT_NAME" "$container_id" "$health" \
  "$(docker inspect --format '{{.Config.Image}}' "$container_id")"
