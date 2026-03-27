#!/bin/bash
# kadai:name Kill Boilerhouse
# kadai:emoji 🔪
# kadai:description Kill all running boilerhouse API/dashboard processes

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

STALE_PIDS=""

# ── Find processes bound to our ports ────────────────────────────────────────
for port in 3000 3001 18080; do
  PID=$(lsof -i :"$port" -t 2>/dev/null || true)
  if [ -n "$PID" ]; then
    STALE_PIDS="$STALE_PIDS $PID"
  fi
done

# ── Find bun processes running our server scripts ────────────────────────────
# Catches orphaned long-pollers (e.g. Telegram getUpdates) not bound to a port.
for pid in $(pgrep -f 'bun.*src/server\.ts' 2>/dev/null || true); do
  PID_CWD=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep '^n' | head -1 || true)
  if echo "$PID_CWD" | grep -q "$SCRIPT_DIR"; then
    STALE_PIDS="$STALE_PIDS $pid"
  fi
done

# ── Deduplicate and kill ─────────────────────────────────────────────────────
STALE_PIDS=$(echo "$STALE_PIDS" | tr ' ' '\n' | grep -v '^$' | sort -u | tr '\n' ' ')

if [ -z "${STALE_PIDS// }" ]; then
  echo "No boilerhouse processes found."
  exit 0
fi

echo "Killing boilerhouse processes:"
for pid in $STALE_PIDS; do
  CMD=$(ps -o command= -p "$pid" 2>/dev/null || echo "(already exited)")
  echo "  PID $pid — $CMD"
done
echo ""
kill $STALE_PIDS 2>/dev/null || true
sleep 1

# Force-kill any survivors
SURVIVORS=""
for pid in $STALE_PIDS; do
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
    SURVIVORS="$SURVIVORS $pid"
  fi
done

if [ -n "${SURVIVORS// }" ]; then
  echo "Force-killed survivors:$SURVIVORS"
fi

echo "Done. All boilerhouse processes killed."
