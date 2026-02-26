#!/bin/bash
# kadai:name Nuke Local Data
# kadai:emoji 💣
# kadai:description Delete local database (SQLite) and all data (snapshots, tenant overlays)
# kadai:confirm true

set -euo pipefail

# Resolve paths relative to the API app, matching server.ts defaults
API_DIR="$(cd "$(dirname "$0")/../../apps/api" && pwd)"

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

if ! $DRY_RUN; then
  echo ""
  echo "Done. All local data has been nuked."
fi
