#!/bin/bash
# kadai:name Dev
# kadai:emoji 🚀
# kadai:description Start dashboard (background) + API (foreground) — Ctrl+C kills both

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
DASHBOARD_PID=""

cleanup() {
  if [ -n "$DASHBOARD_PID" ]; then
    kill "$DASHBOARD_PID" 2>/dev/null || true
    wait "$DASHBOARD_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

# Start dashboard in background
echo "Starting dashboard..."
cd "$SCRIPT_DIR/apps/dashboard"
bun --hot src/server.ts &
DASHBOARD_PID=$!
echo "Dashboard running (PID $DASHBOARD_PID)"

# Start API in foreground
echo ""
echo "Starting API..."
cd "$SCRIPT_DIR/apps/api"
exec bun --hot src/server.ts
