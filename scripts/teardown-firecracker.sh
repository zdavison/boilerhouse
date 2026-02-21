#!/usr/bin/env bash
#
# Teardown script for Firecracker + Jailer environment.
#
# Usage:
#   ./scripts/teardown-firecracker.sh [--dry-run] [--force]
#
# Reverses the setup script: removes binaries, kernel, directories,
# sysctl, sudoers, and systemd service.

set -euo pipefail

# ── Defaults ────────────────────────────────────────────────────────────────

INSTALL_DIR="/usr/local/bin"
KERNEL_DIR="/var/lib/boilerhouse"
JAILER_DIR="/srv/jailer"
STORAGE_DIR="/var/lib/boilerhouse/data"
SUDOERS_FILE="/etc/sudoers.d/boilerhouse"
SYSCTL_CONF="/etc/sysctl.d/99-boilerhouse.conf"
UNIT_FILE="/etc/systemd/system/boilerhouse.service"

DRY_RUN=false
FORCE=false

# ── Argument parsing ────────────────────────────────────────────────────────

usage() {
	echo "Usage: $0 [--dry-run] [--force]"
	echo ""
	echo "Options:"
	echo "  --dry-run   Print commands without executing"
	echo "  --force     Skip confirmation prompts"
	exit 1
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--dry-run)
			DRY_RUN=true
			shift
			;;
		--force)
			FORCE=true
			shift
			;;
		--help|-h)
			usage
			;;
		*)
			echo "Unknown option: $1"
			usage
			;;
	esac
done

# ── Helpers ─────────────────────────────────────────────────────────────────

run_sudo() {
	if $DRY_RUN; then
		echo "[dry-run] sudo $*"
	else
		echo "[run] sudo $*"
		sudo "$@"
	fi
}

confirm() {
	if $FORCE || $DRY_RUN; then
		return 0
	fi
	read -rp "$1 [y/N] " answer
	[[ "$answer" =~ ^[Yy] ]]
}

echo "=== Firecracker Teardown ==="
echo ""

if ! $FORCE && ! $DRY_RUN; then
	echo "This will remove Firecracker, jailer, kernel, jail directories,"
	echo "sysctl rules, sudoers entries, and the systemd service."
	echo ""
	if ! confirm "Continue?"; then
		echo "Aborted."
		exit 0
	fi
	echo ""
fi

# ── 1. Stop and remove systemd service ─────────────────────────────────────

echo "--- Removing systemd service ---"
if [[ -f "$UNIT_FILE" ]]; then
	if ! $DRY_RUN; then
		sudo systemctl stop boilerhouse 2>/dev/null || true
		sudo systemctl disable boilerhouse 2>/dev/null || true
	fi
	run_sudo rm -f "$UNIT_FILE"
	if ! $DRY_RUN; then
		sudo systemctl daemon-reload
	fi
else
	echo "[skip] No systemd unit found"
fi

echo ""

# ── 2. Remove sudoers entry ────────────────────────────────────────────────

echo "--- Removing sudoers entry ---"
if [[ -f "$SUDOERS_FILE" ]]; then
	run_sudo rm -f "$SUDOERS_FILE"
else
	echo "[skip] No sudoers file found"
fi

echo ""

# ── 3. Remove sysctl config ────────────────────────────────────────────────

echo "--- Removing sysctl config ---"
if [[ -f "$SYSCTL_CONF" ]]; then
	run_sudo rm -f "$SYSCTL_CONF"
	if ! $DRY_RUN; then
		sudo sysctl --system > /dev/null 2>&1
	fi
else
	echo "[skip] No sysctl config found"
fi

echo ""

# ── 4. Clean up jail directory ──────────────────────────────────────────────

echo "--- Removing jail directory ---"
if [[ -d "$JAILER_DIR" ]]; then
	run_sudo rm -rf "$JAILER_DIR"
else
	echo "[skip] No jail directory found"
fi

echo ""

# ── 5. Remove binaries ─────────────────────────────────────────────────────

echo "--- Removing binaries ---"
for bin in firecracker jailer; do
	if [[ -f "${INSTALL_DIR}/${bin}" ]]; then
		run_sudo rm -f "${INSTALL_DIR}/${bin}"
	else
		echo "[skip] ${INSTALL_DIR}/${bin} not found"
	fi
done

echo ""

# ── 6. Remove kernel ───────────────────────────────────────────────────────

echo "--- Removing kernel ---"
if [[ -f "${KERNEL_DIR}/vmlinux" ]]; then
	run_sudo rm -f "${KERNEL_DIR}/vmlinux"
else
	echo "[skip] No kernel found"
fi

echo ""

# ── 7. Remove storage (only with --force) ──────────────────────────────────

echo "--- Storage directories ---"
if [[ -d "$STORAGE_DIR" ]]; then
	if $FORCE; then
		run_sudo rm -rf "$STORAGE_DIR"
	else
		echo "[skip] Keeping storage at ${STORAGE_DIR} (use --force to remove)"
	fi
else
	echo "[skip] No storage directory found"
fi

echo ""

# ── 8. Remove system user (only with --force) ──────────────────────────────

echo "--- System user ---"
if id -u boilerhouse &>/dev/null; then
	if $FORCE; then
		run_sudo userdel boilerhouse
	else
		echo "[skip] Keeping user 'boilerhouse' (use --force to remove)"
	fi
else
	echo "[skip] No boilerhouse user found"
fi

echo ""
echo "=== Teardown complete ==="
