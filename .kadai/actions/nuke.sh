#!/bin/bash
# kadai:name Nuke Local Data
# kadai:emoji 💣
# kadai:description Delete local database, data, and boilerhouse podman images
# kadai:confirm true

set -euo pipefail

# Resolve paths relative to project root
SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
API_DIR="$SCRIPT_DIR/apps/api"

DB_PATH="${DB_PATH:-$API_DIR/boilerhouse.db}"
STORAGE_PATH="${STORAGE_PATH:-$API_DIR/data}"

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "[dry-run] Would delete the following:"
fi

nuke() {
  local target="$1"
  if [[ -e "$target" ]]; then
    if $DRY_RUN; then
      echo "  $target"
    else
      rm -rf "$target"
      echo "Deleted $target"
    fi
  fi
}

# SQLite database + WAL/SHM journal files
nuke "$DB_PATH"
nuke "$DB_PATH-wal"
nuke "$DB_PATH-shm"

# Data directory (snapshots + tenant overlays)
nuke "$STORAGE_PATH"

# Podman images managed by boilerhoused
if [[ "$(uname -s)" == "Darwin" ]]; then
  RUNTIME_SOCKET="${RUNTIME_SOCKET:-$HOME/.local/share/boilerhouse/runtime.sock}"
else
  RUNTIME_SOCKET="${RUNTIME_SOCKET:-/var/run/boilerhouse/runtime.sock}"
fi

if [[ -S "$RUNTIME_SOCKET" ]]; then
  echo ""
  read -rp "Also delete podman images? [y/N] " NUKE_IMAGES
  if [[ "$NUKE_IMAGES" =~ ^[Yy]$ ]]; then
    sudo BUN="$(command -v bun)" "$SCRIPT_DIR/scripts/nuke-images.sh" "$RUNTIME_SOCKET" "$DRY_RUN"
  else
    echo "Skipping image cleanup."
  fi
else
  echo "Daemon not running — skipping image cleanup."
fi

if ! $DRY_RUN; then
  echo ""
  echo "Done. All local data has been nuked."
fi
