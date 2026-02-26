#!/bin/bash
# kadai:name Start/Restart Daemon
# kadai:emoji 🔄
# kadai:description Start or restart the rootful podman API daemon

set -euo pipefail

SOCKET_PATH="${PODMAN_SOCKET:-/run/boilerhouse/podman.sock}"
SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
DAEMON_SCRIPT="$SCRIPT_DIR/scripts/start-podman-daemon.sh"

# Kill any existing podman system service listening on our socket
if [ -S "$SOCKET_PATH" ]; then
  EXISTING_PID=$(sudo lsof -t "$SOCKET_PATH" 2>/dev/null || true)
  if [ -n "$EXISTING_PID" ]; then
    echo "Stopping existing daemon (PID $EXISTING_PID)..."
    sudo kill "$EXISTING_PID" 2>/dev/null || true
    sleep 0.5
  else
    echo "Removing stale socket..."
    sudo rm -f "$SOCKET_PATH"
  fi
fi

echo "Starting podman daemon..."
sudo "$DAEMON_SCRIPT" --background

# Verify the socket is up
if [ -S "$SOCKET_PATH" ]; then
  PID=$(sudo lsof -t "$SOCKET_PATH" 2>/dev/null || true)
  echo ""
  echo "Daemon is running (PID $PID)."
  echo "To stop: sudo kill $PID"
else
  echo "Error: daemon failed to start." >&2
  exit 1
fi
