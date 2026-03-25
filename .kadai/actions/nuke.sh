#!/bin/bash
# kadai:name Nuke Local Data
# kadai:emoji 💣
# kadai:description Delete local database, data, and boilerhouse docker containers
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

# Remove all boilerhouse-labelled docker containers
if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
  CONTAINER_IDS=$(docker ps -aq --filter "label=boilerhouse" 2>/dev/null || true)
  if [[ -n "$CONTAINER_IDS" ]]; then
    echo ""
    if $DRY_RUN; then
      CONTAINER_COUNT=$(echo "$CONTAINER_IDS" | wc -l | tr -d ' ')
      echo "  Would remove $CONTAINER_COUNT boilerhouse container(s)"
    else
      echo "Removing boilerhouse docker containers..."
      echo "$CONTAINER_IDS" | xargs docker rm -f 2>/dev/null || true
      echo "All boilerhouse containers removed."
    fi
  fi
fi

if ! $DRY_RUN; then
  echo ""
  echo "Done. All local data has been nuked."
fi
