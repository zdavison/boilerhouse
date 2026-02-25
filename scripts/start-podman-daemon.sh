#!/usr/bin/env bash
set -euo pipefail

# Starts a rootful podman API socket for development.
# The API server (running as an unprivileged user) communicates with
# rootful podman over this Unix socket.
#
# Usage:
#   sudo scripts/start-podman-daemon.sh
#   sudo scripts/start-podman-daemon.sh --dry-run
#
# The socket is created at /run/boilerhouse/podman.sock and made
# accessible to the current user's primary group.

SOCKET_PATH="/run/boilerhouse/podman.sock"
DRY_RUN=false
CALLER_GROUP="${SUDO_GID:-$(id -g)}"

for arg in "$@"; do
	case "$arg" in
		--dry-run)
			DRY_RUN=true
			;;
	esac
done

run() {
	if [ "$DRY_RUN" = true ]; then
		echo "[dry-run] $*"
	else
		"$@"
	fi
}

if [ "$(id -u)" -ne 0 ]; then
	echo "Error: This script must be run as root (use sudo)." >&2
	exit 1
fi

echo "Creating socket directory..."
run mkdir -p "$(dirname "$SOCKET_PATH")"

# Stop any existing podman system service on this socket
if [ -S "$SOCKET_PATH" ]; then
	echo "Removing stale socket..."
	run rm -f "$SOCKET_PATH"
fi

echo "Starting podman system service on $SOCKET_PATH..."
if [ "$DRY_RUN" = true ]; then
	echo "[dry-run] podman system service --time=0 unix://$SOCKET_PATH &"
	echo "[dry-run] chmod 660 $SOCKET_PATH"
	echo "[dry-run] chgrp $CALLER_GROUP $SOCKET_PATH"
else
	podman system service --time=0 "unix://$SOCKET_PATH" &
	PODMAN_PID=$!

	# Wait for socket to appear
	for _ in $(seq 1 50); do
		if [ -S "$SOCKET_PATH" ]; then
			break
		fi
		sleep 0.1
	done

	if [ ! -S "$SOCKET_PATH" ]; then
		echo "Error: Socket did not appear within 5 seconds." >&2
		kill "$PODMAN_PID" 2>/dev/null || true
		exit 1
	fi

	chmod 660 "$SOCKET_PATH"
	chgrp "$CALLER_GROUP" "$SOCKET_PATH"

	echo "Podman API listening on $SOCKET_PATH (PID $PODMAN_PID)"
	echo "Socket is accessible to GID $CALLER_GROUP"
	echo ""
	echo "To stop: kill $PODMAN_PID"

	# Wait for the podman process so the script stays alive
	wait "$PODMAN_PID"
fi
