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

# Kill stale dev processes from previous runs
STALE_PIDS=""
for port in 3000 3001 18080; do
  PID=$(lsof -i :"$port" -t 2>/dev/null || true)
  if [ -n "$PID" ]; then
    STALE_PIDS="$STALE_PIDS $PID"
  fi
done
# Deduplicate and kill all at once, then wait
STALE_PIDS=$(echo "$STALE_PIDS" | tr ' ' '\n' | sort -u | tr '\n' ' ')
if [ -n "${STALE_PIDS// }" ]; then
  echo "Killing stale processes: $STALE_PIDS"
  kill $STALE_PIDS 2>/dev/null || true
  sleep 1
  # Force-kill any survivors
  for pid in $STALE_PIDS; do
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  done
  sleep 0.3
fi

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
