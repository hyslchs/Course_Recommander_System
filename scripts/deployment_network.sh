#!/usr/bin/env bash

# Shared, read-only checks for the operator-managed CRS production network.
# This file is sourced by deploy.sh; it deliberately never creates or removes
# Docker resources.

readonly CRS_PRODUCTION_NETWORK_NAME="crs-production-network"
readonly CRS_PRODUCTION_NETWORK_DRIVER="bridge"
readonly CRS_PRODUCTION_NETWORK_SUBNET="172.24.0.0/24"
readonly CRS_PRODUCTION_NETWORK_GATEWAY="172.24.0.1"

verify_fixed_network() {
  local inspection
  local driver
  local subnet
  local gateway

  if ! inspection="$(docker network inspect --format '{{.Driver}}|{{range .IPAM.Config}}{{.Subnet}}|{{.Gateway}}{{end}}' \
    "$CRS_PRODUCTION_NETWORK_NAME" 2>/dev/null)"; then
    printf 'fixed network preflight: network is missing: %s\n' \
      "$CRS_PRODUCTION_NETWORK_NAME" >&2
    return 1
  fi

  IFS='|' read -r driver subnet gateway <<< "$inspection"
  if [ "$driver" != "$CRS_PRODUCTION_NETWORK_DRIVER" ]; then
    printf 'fixed network preflight: expected driver %s, got %s\n' \
      "$CRS_PRODUCTION_NETWORK_DRIVER" "$driver" >&2
    return 1
  fi
  if [ "$subnet" != "$CRS_PRODUCTION_NETWORK_SUBNET" ]; then
    printf 'fixed network preflight: expected subnet %s, got %s\n' \
      "$CRS_PRODUCTION_NETWORK_SUBNET" "$subnet" >&2
    return 1
  fi
  if [ "$gateway" != "$CRS_PRODUCTION_NETWORK_GATEWAY" ]; then
    printf 'fixed network preflight: expected gateway %s, got %s\n' \
      "$CRS_PRODUCTION_NETWORK_GATEWAY" "$gateway" >&2
    return 1
  fi
}

verify_container_on_fixed_network() {
  local container_id="$1"
  local attached

  if ! attached="$(docker inspect --format \
    '{{if index .NetworkSettings.Networks "crs-production-network"}}attached{{end}}' \
    "$container_id" 2>/dev/null)"; then
    printf 'fixed network validation: unable to inspect container: %s\n' \
      "$container_id" >&2
    return 1
  fi
  if [ "$attached" != attached ]; then
    printf 'fixed network validation: container is not attached to %s: %s\n' \
      "$CRS_PRODUCTION_NETWORK_NAME" "$container_id" >&2
    return 1
  fi
}

verify_trusted_proxy_setting() {
  local env_file="${1:-.env}"
  local configured

  if ! configured="$(awk -F= '
    $1 == "FJU_TRUSTED_PROXY_IPS" {
      value = substr($0, index($0, "=") + 1)
      count++
    }
    END {
      if (count != 1) {
        exit 1
      }
      print value
    }
  ' "$env_file" 2>/dev/null)"; then
    printf 'fixed network preflight: .env must contain exactly one FJU_TRUSTED_PROXY_IPS entry\n' >&2
    return 1
  fi
  if [ "$configured" != "$CRS_PRODUCTION_NETWORK_GATEWAY/32" ]; then
    printf 'fixed network preflight: FJU_TRUSTED_PROXY_IPS does not match the fixed gateway\n' >&2
    return 1
  fi
}
