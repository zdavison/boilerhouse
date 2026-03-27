#!/bin/bash
# Shared helpers for boilerhouse presets.
# Source this file — do not execute directly.

set -euo pipefail

PRESET_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PRESET_ENV_FILE="$PRESET_ROOT/apps/api/.env"
PRESET_WORKLOADS_DIR="$PRESET_ROOT/workloads"
PRESET_STAGING_DIR="$PRESET_ROOT/.boilerhouse-preset/workloads"

# ── Env helpers ──────────────────────────────────────────────────────────────

load_env() {
  if [ -f "$PRESET_ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$PRESET_ENV_FILE"
    set +a
  fi
}

# Write or update a key=value pair in the .env file.
_set_env() {
  local key="$1" value="$2"
  mkdir -p "$(dirname "$PRESET_ENV_FILE")"

  if [ -f "$PRESET_ENV_FILE" ] && grep -q "^${key}=" "$PRESET_ENV_FILE" 2>/dev/null; then
    # Update existing line
    local tmp
    tmp=$(mktemp)
    sed "s|^${key}=.*|${key}=${value}|" "$PRESET_ENV_FILE" > "$tmp"
    mv "$tmp" "$PRESET_ENV_FILE"
  else
    # Append
    echo "${key}=${value}" >> "$PRESET_ENV_FILE"
  fi
}

# Check if a var is set (non-empty) in the current environment.
_is_set() {
  [ -n "${!1:-}" ]
}

# ensure_env_var NAME PROMPT [DEFAULT] [--secret]
#   Prompts only if NAME is not already set. Writes to .env.
ensure_env_var() {
  local name="$1" prompt="$2" default="${3:-}" secret=false
  if [ "${4:-}" = "--secret" ] || [ "${3:-}" = "--secret" ]; then
    secret=true
    # If --secret was passed as $3, clear default
    if [ "${3:-}" = "--secret" ]; then default=""; fi
  fi

  if _is_set "$name"; then
    echo "  $name already set"
    return 0
  fi

  local display_default=""
  if [ -n "$default" ]; then
    display_default=" [$default]"
  fi

  local value
  if [ "$secret" = true ]; then
    read -rsp "${prompt}${display_default}: " value
    echo ""  # newline after hidden input
  else
    read -rp "${prompt}${display_default}: " value
  fi

  value="${value:-$default}"

  if [ -z "$value" ]; then
    echo "  Error: $name is required." >&2
    return 1
  fi

  export "$name=$value"
  _set_env "$name" "$value"
}

# Auto-generate BOILERHOUSE_SECRET_KEY if not set.
ensure_secret_key() {
  if _is_set BOILERHOUSE_SECRET_KEY; then
    echo "  BOILERHOUSE_SECRET_KEY already set"
    return 0
  fi

  local key
  key=$(openssl rand -hex 32)
  export BOILERHOUSE_SECRET_KEY="$key"
  _set_env "BOILERHOUSE_SECRET_KEY" "$key"
  echo "  Generated BOILERHOUSE_SECRET_KEY"
}

# Prompt for runtime type with a selection menu.
ensure_runtime_type() {
  if _is_set RUNTIME_TYPE; then
    echo "  RUNTIME_TYPE already set ($RUNTIME_TYPE)"
    return 0
  fi

  echo ""
  echo "Select runtime:"
  echo "  1) docker     — Container runtime via Docker daemon"
  echo "  2) kubernetes — Pods on minikube (boilerhouse-test profile)"
  echo ""
  read -rp "Runtime [1]: " choice

  case "${choice:-1}" in
    1|docker)     RUNTIME_TYPE="docker" ;;
    2|kubernetes) RUNTIME_TYPE="kubernetes" ;;
    *)
      echo "Invalid choice: $choice" >&2
      return 1
      ;;
  esac

  export RUNTIME_TYPE
  _set_env "RUNTIME_TYPE" "$RUNTIME_TYPE"

  # Auto-detect Docker socket on macOS if not already set
  if [ "$RUNTIME_TYPE" = "docker" ] && ! _is_set DOCKER_SOCKET; then
    local sock=""
    if [ -S "/var/run/docker.sock" ]; then
      sock="/var/run/docker.sock"
    elif [ -S "$HOME/.docker/run/docker.sock" ]; then
      sock="$HOME/.docker/run/docker.sock"
    fi
    if [ -n "$sock" ]; then
      export DOCKER_SOCKET="$sock"
      _set_env "DOCKER_SOCKET" "$sock"
      echo "  Auto-detected DOCKER_SOCKET=$sock"
    fi
  fi
}

# ── Workload staging ─────────────────────────────────────────────────────────

# stage_workloads FILE_OR_DIR ...
#   Creates a staging directory with symlinks to only the specified workload
#   and trigger files (and supporting directories). Sets WORKLOADS_DIR in .env.
#
#   Examples:
#     stage_workloads openclaw.workload.ts tg-openclaw.trigger.ts openclaw/
stage_workloads() {
  rm -rf "$PRESET_STAGING_DIR"
  mkdir -p "$PRESET_STAGING_DIR"

  for item in "$@"; do
    # Strip trailing slashes for consistent path handling
    item="${item%/}"
    local src="$PRESET_WORKLOADS_DIR/$item"
    local dst="$PRESET_STAGING_DIR/$item"

    if [ ! -e "$src" ]; then
      echo "  Warning: $item not found in workloads/, skipping" >&2
      continue
    fi

    # Ensure parent directory exists for nested paths
    mkdir -p "$(dirname "$dst")"
    ln -sf "$src" "$dst"
  done

  # Also symlink package.json if it exists (needed for workspace resolution)
  if [ -f "$PRESET_WORKLOADS_DIR/package.json" ]; then
    ln -sf "$PRESET_WORKLOADS_DIR/package.json" "$PRESET_STAGING_DIR/package.json"
  fi

  # Write the staging dir as WORKLOADS_DIR (relative to apps/api/)
  local rel_path
  rel_path=$(python3 -c "import os; print(os.path.relpath('$PRESET_STAGING_DIR', '$PRESET_ROOT/apps/api'))")
  _set_env "WORKLOADS_DIR" "$rel_path"

  echo "  Staged workloads in .boilerhouse-preset/workloads/"
}

# ── API interaction ──────────────────────────────────────────────────────────

wait_for_api() {
  local port="${PORT:-3000}"
  local url="http://127.0.0.1:${port}/api/v1/health"
  local attempts=0 max=30

  echo -n "Waiting for API"
  while [ $attempts -lt $max ]; do
    if curl -sf "$url" &>/dev/null; then
      echo " ready!"
      return 0
    fi
    echo -n "."
    sleep 1
    attempts=$((attempts + 1))
  done
  echo " timed out"
  return 1
}

seed_secret() {
  local tenant_id="$1" secret_name="$2" value="$3"
  local port="${PORT:-3000}"
  local url="http://127.0.0.1:${port}/api/v1/tenants/${tenant_id}/secrets/${secret_name}"

  curl -sf -X PUT "$url" \
    -H "Content-Type: application/json" \
    -d "{\"value\":\"$value\"}" &>/dev/null

  echo "  Stored secret $secret_name for tenant $tenant_id"
}
