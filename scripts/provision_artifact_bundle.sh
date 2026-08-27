#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 SOURCE_BUNDLE TARGET_ROOT" >&2
  exit 2
fi

source_bundle=$1
target_root=$2
if [[ ! -d "$source_bundle" ]]; then
  echo "source bundle is not a directory: $source_bundle" >&2
  exit 1
fi
if [[ ! -f "$source_bundle/bundle-lock.json" ]]; then
  echo "source bundle has no bundle-lock.json" >&2
  exit 1
fi

bundle_id=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["bundle_id"])' "$source_bundle/bundle-lock.json")
mkdir -p "$target_root"
target="$target_root/$bundle_id"
if [[ -e "$target" ]]; then
  echo "refusing to overwrite existing immutable bundle: $target" >&2
  exit 1
fi
staging=$(mktemp -d "$target_root/.${bundle_id}.staging.XXXXXX")
cleanup() { rm -rf -- "$staging"; }
trap cleanup EXIT
cp -a "$source_bundle/." "$staging/"
python3 "$(dirname "$0")/verify_artifact_bundle.py" --bundle "$staging"
if [[ -e "$target" ]]; then
  echo "target appeared during provisioning: $target" >&2
  exit 1
fi
mv -- "$staging" "$target"
trap - EXIT
printf '%s\n' "$target"
