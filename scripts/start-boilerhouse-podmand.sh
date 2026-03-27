#!/usr/bin/env bash
set -euo pipefail

# Starts boilerhouse-podmand for development.
# boilerhouse-podmand manages the podman daemon internally — no separate podman
# script is needed.
#
# Usage:
#   Linux:  sudo scripts/start-boilerhouse-podmand.sh
#   macOS:  scripts/start-boilerhouse-podmand.sh  (no sudo — podman machine runs as user)
#
# Flags:
#   --dry-run     Print commands without executing
#   --background  Detach the daemon process

DRY_RUN=false
BACKGROUND=false

# Platform detection
IS_MACOS=false
if [ "$(uname -s)" = "Darwin" ]; then
	IS_MACOS=true
fi

# Default paths differ by platform
if [ "$IS_MACOS" = true ]; then
	# macOS: socket is discovered at runtime from the podman machine
	PODMAN_SOCKET=""
	LISTEN_SOCKET="${LISTEN_SOCKET:-$HOME/.local/share/boilerhouse/runtime.sock}"
	SNAPSHOT_DIR="${SNAPSHOT_DIR:-$HOME/.local/share/boilerhouse/snapshots}"
else
	PODMAN_SOCKET="/var/run/boilerhouse/podman.sock"
	LISTEN_SOCKET="/var/run/boilerhouse/runtime.sock"
	SNAPSHOT_DIR="/var/lib/boilerhouse/snapshots"
fi

CALLER_GROUP="${SUDO_GID:-$(id -g)}"

# Resolve bun path before sudo strips PATH
BUN="${BUN:-$(command -v bun 2>/dev/null || echo "")}"
if [ -z "$BUN" ]; then
	# Common install locations (Linux + macOS)
	for candidate in /home/*/.bun/bin/bun /Users/*/.bun/bin/bun /usr/local/bin/bun; do
		# shellcheck disable=SC2086
		for path in $candidate; do
			if [ -x "$path" ]; then
				BUN="$path"
				break 2
			fi
		done
	done
fi

for arg in "$@"; do
	case "$arg" in
		--dry-run)
			DRY_RUN=true
			;;
		--background)
			BACKGROUND=true
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

if [ -z "$BUN" ]; then
	echo "Error: bun not found. Install bun or set BUN=/path/to/bun." >&2
	exit 1
fi

# Linux requires root for rootful podman; macOS does not
if [ "$IS_MACOS" = false ] && [ "$(id -u)" -ne 0 ]; then
	echo "Error: This script must be run as root (use sudo)." >&2
	exit 1
fi

# Ensure we're in the project root for workspace module resolution
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

# Remove stale listen socket
if [ -S "$LISTEN_SOCKET" ]; then
	echo "Removing stale socket $LISTEN_SOCKET..."
	run rm -f "$LISTEN_SOCKET"
fi
if [ -n "$PODMAN_SOCKET" ] && [ -S "$PODMAN_SOCKET" ]; then
	echo "Removing stale socket $PODMAN_SOCKET..."
	run rm -f "$PODMAN_SOCKET"
fi

echo "Creating directories..."
run mkdir -p "$(dirname "$LISTEN_SOCKET")" "$SNAPSHOT_DIR"
run chmod 700 "$SNAPSHOT_DIR"

echo "Starting boilerhouse-podmand (manages podman internally)..."
if [ "$DRY_RUN" = true ]; then
	echo "[dry-run] umask 0117"
	echo "[dry-run] LISTEN_SOCKET=$LISTEN_SOCKET SNAPSHOT_DIR=$SNAPSHOT_DIR $BUN apps/boilerhouse-podmand/src/main.ts &"
else
	# Restrictive umask for socket creation — only needed on Linux where
	# the daemon runs as root. On macOS the socket perms are set after creation.
	if [ "$IS_MACOS" = false ]; then
		umask 0117
	fi

	export LISTEN_SOCKET
	export SNAPSHOT_DIR
	export HMAC_KEY="${HMAC_KEY:-deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef}"
	export WORKLOADS_DIR="${WORKLOADS_DIR:-$SCRIPT_DIR/workloads}"
	if [ -n "$PODMAN_SOCKET" ]; then
		export PODMAN_SOCKET
	fi

	# Start boilerhouse-podmand — keep stderr visible so startup errors are shown
	if [ "$BACKGROUND" = true ]; then
		"$BUN" apps/boilerhouse-podmand/src/main.ts >/dev/null &
	else
		"$BUN" apps/boilerhouse-podmand/src/main.ts &
	fi
	DAEMON_PID=$!

	# Wait for runtime socket to appear. On macOS, `podman machine start` can
	# take 30s+ on first boot, so we allow up to 60 seconds.
	SOCKET_TIMEOUT=600  # iterations × 0.1s = 60s
	for _ in $(seq 1 $SOCKET_TIMEOUT); do
		if [ -S "$LISTEN_SOCKET" ]; then
			break
		fi
		# Check if process already died
		if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
			echo "Error: boilerhouse-podmand exited before creating socket." >&2
			wait "$DAEMON_PID" 2>/dev/null || true
			exit 1
		fi
		sleep 0.1
	done

	if [ ! -S "$LISTEN_SOCKET" ]; then
		echo "Error: Daemon socket did not appear within 60 seconds." >&2
		kill "$DAEMON_PID" 2>/dev/null || true
		exit 1
	fi

	# On Linux (sudo), adjust socket group for the calling user
	if [ "$IS_MACOS" = false ]; then
		chgrp "$CALLER_GROUP" "$LISTEN_SOCKET"
	fi
	chmod 660 "$LISTEN_SOCKET"

	echo "boilerhouse-podmand listening on $LISTEN_SOCKET (PID $DAEMON_PID)"
	if [ -n "$PODMAN_SOCKET" ]; then
		echo "  podman socket: $PODMAN_SOCKET (managed, 0600)"
	else
		echo "  podman socket: (managed by podman machine)"
	fi
	echo "  runtime socket: $LISTEN_SOCKET (0660)"
	echo "  snapshot dir:  $SNAPSHOT_DIR"
	echo ""
	echo "To stop: kill $DAEMON_PID"

	if [ "$BACKGROUND" = true ]; then
		disown "$DAEMON_PID"
	else
		wait "$DAEMON_PID"
	fi
fi
