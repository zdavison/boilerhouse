#!/usr/bin/env bash
#
# Setup script for Firecracker + Jailer environment.
#
# Usage:
#   ./scripts/setup-firecracker.sh --profile dev|prod [--dry-run]
#
# Installs firecracker/jailer binaries, kernel, creates directories,
# configures sysctl, sudoers, and (prod only) systemd service.

set -euo pipefail

# ── Defaults ────────────────────────────────────────────────────────────────

FC_VERSION="${FC_VERSION:-1.10.1}"
FC_ARCH="${FC_ARCH:-x86_64}"
FC_DOWNLOAD_BASE="https://github.com/firecracker-microvm/firecracker/releases/download"
KERNEL_URL="${KERNEL_URL:-https://s3.amazonaws.com/spec.ccfc.min/ci-artifacts/kernels/${FC_ARCH}/vmlinux-5.10.bin}"

INSTALL_DIR="/usr/local/bin"
KERNEL_DIR="/var/lib/boilerhouse"
JAILER_DIR="/srv/jailer"
STORAGE_DIR="/var/lib/boilerhouse/data"

PROFILE=""
DRY_RUN=false

# ── Argument parsing ────────────────────────────────────────────────────────

usage() {
	echo "Usage: $0 --profile dev|prod [--dry-run]"
	echo ""
	echo "Options:"
	echo "  --profile dev|prod   Installation profile"
	echo "  --dry-run            Print commands without executing"
	exit 1
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--profile)
			PROFILE="$2"
			shift 2
			;;
		--dry-run)
			DRY_RUN=true
			shift
			;;
		*)
			usage
			;;
	esac
done

if [[ -z "$PROFILE" ]]; then
	usage
fi

if [[ "$PROFILE" != "dev" && "$PROFILE" != "prod" ]]; then
	echo "Error: --profile must be 'dev' or 'prod'"
	exit 1
fi

# ── Helpers ─────────────────────────────────────────────────────────────────

run() {
	if $DRY_RUN; then
		echo "[dry-run] $*"
	else
		echo "[run] $*"
		"$@"
	fi
}

run_sudo() {
	if $DRY_RUN; then
		echo "[dry-run] sudo $*"
	else
		echo "[run] sudo $*"
		sudo "$@"
	fi
}

# ── Determine service user ─────────────────────────────────────────────────

if [[ "$PROFILE" == "dev" ]]; then
	SERVICE_USER="$(whoami)"
else
	SERVICE_USER="boilerhouse"
fi

echo "=== Firecracker Setup (profile=$PROFILE, user=$SERVICE_USER) ==="
echo ""

# ── 1. Install Firecracker + Jailer binaries ───────────────────────────────

echo "--- Installing Firecracker v${FC_VERSION} ---"

FC_RELEASE="firecracker-v${FC_VERSION}-${FC_ARCH}"
FC_TARBALL="${FC_RELEASE}.tgz"
FC_URL="${FC_DOWNLOAD_BASE}/v${FC_VERSION}/${FC_TARBALL}"

if ! $DRY_RUN; then
	TMPDIR=$(mktemp -d)
	trap 'rm -rf "$TMPDIR"' EXIT

	echo "[run] Downloading ${FC_URL}..."
	curl -fsSL "$FC_URL" -o "$TMPDIR/$FC_TARBALL"
	tar -xzf "$TMPDIR/$FC_TARBALL" -C "$TMPDIR"

	FC_BIN=$(find "$TMPDIR" -name "firecracker-v*" -not -name "*.debug" | head -1)
	JAILER_BIN=$(find "$TMPDIR" -name "jailer-v*" -not -name "*.debug" | head -1)

	if [[ -z "$FC_BIN" || -z "$JAILER_BIN" ]]; then
		echo "Error: Could not find firecracker/jailer binaries in release archive"
		exit 1
	fi

	sudo install -o root -g root -m 0755 "$FC_BIN" "${INSTALL_DIR}/firecracker"
	sudo install -o root -g root -m 0755 "$JAILER_BIN" "${INSTALL_DIR}/jailer"
else
	echo "[dry-run] Would download and install firecracker + jailer to ${INSTALL_DIR}/"
fi

echo ""

# ── 2. Download kernel ─────────────────────────────────────────────────────

echo "--- Downloading kernel ---"
run_sudo mkdir -p "$KERNEL_DIR"

if $DRY_RUN; then
	echo "[dry-run] Would download kernel to ${KERNEL_DIR}/vmlinux"
else
	if [[ ! -f "${KERNEL_DIR}/vmlinux" ]]; then
		echo "[run] Downloading kernel..."
		sudo curl -fsSL "$KERNEL_URL" -o "${KERNEL_DIR}/vmlinux"
	else
		echo "[skip] Kernel already exists at ${KERNEL_DIR}/vmlinux"
	fi
fi

echo ""

# ── 3. KVM group access ────────────────────────────────────────────────────

echo "--- Configuring KVM access ---"
if [[ -e /dev/kvm ]]; then
	run_sudo usermod -aG kvm "$SERVICE_USER"
else
	echo "[warn] /dev/kvm not found — hardware virtualization may not be available"
fi

echo ""

# ── 4. Create /srv/jailer directory ─────────────────────────────────────────

echo "--- Creating jailer directories ---"
run_sudo mkdir -p "$JAILER_DIR"
run_sudo chown root:root "$JAILER_DIR"
run_sudo chmod 0755 "$JAILER_DIR"

echo ""

# ── 5. Enable IP forwarding ────────────────────────────────────────────────

echo "--- Enabling IP forwarding ---"
SYSCTL_CONF="/etc/sysctl.d/99-boilerhouse.conf"

if $DRY_RUN; then
	echo "[dry-run] Would write to ${SYSCTL_CONF}:"
	echo "  net.ipv4.ip_forward = 1"
else
	echo "net.ipv4.ip_forward = 1" | sudo tee "$SYSCTL_CONF" > /dev/null
	sudo sysctl -p "$SYSCTL_CONF"
fi

echo ""

# ── 6. Sudoers entry ───────────────────────────────────────────────────────

echo "--- Configuring sudoers ---"
SUDOERS_FILE="/etc/sudoers.d/boilerhouse"

SUDOERS_CONTENT="${SERVICE_USER} ALL=(root) NOPASSWD: ${INSTALL_DIR}/jailer *
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/sbin/ip netns *
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/sbin/ip link *
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/sbin/ip addr *
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/sbin/ip tuntap *
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/sbin/iptables *
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/bin/kill *
${SERVICE_USER} ALL=(root) NOPASSWD: /bin/chown *
${SERVICE_USER} ALL=(root) NOPASSWD: /bin/rm -rf ${JAILER_DIR}/*"

if $DRY_RUN; then
	echo "[dry-run] Would write to ${SUDOERS_FILE}:"
	echo "$SUDOERS_CONTENT" | sed 's/^/  /'
else
	echo "$SUDOERS_CONTENT" | sudo tee "$SUDOERS_FILE" > /dev/null
	sudo chmod 0440 "$SUDOERS_FILE"
	# Validate syntax
	sudo visudo -cf "$SUDOERS_FILE"
fi

echo ""

# ── 7. Subordinate UID range ───────────────────────────────────────────────

echo "--- Configuring subordinate UID range ---"
if $DRY_RUN; then
	echo "[dry-run] Would add subuid/subgid entries for ${SERVICE_USER}: 100000:65536"
else
	if ! grep -q "^${SERVICE_USER}:" /etc/subuid 2>/dev/null; then
		echo "${SERVICE_USER}:100000:65536" | sudo tee -a /etc/subuid > /dev/null
	fi
	if ! grep -q "^${SERVICE_USER}:" /etc/subgid 2>/dev/null; then
		echo "${SERVICE_USER}:100000:65536" | sudo tee -a /etc/subgid > /dev/null
	fi
fi

echo ""

# ── 8. Create storage directories ──────────────────────────────────────────

echo "--- Creating storage directories ---"
run_sudo mkdir -p "${STORAGE_DIR}/snapshots"
run_sudo mkdir -p "${STORAGE_DIR}/instances"
run_sudo mkdir -p "${STORAGE_DIR}/images"
run_sudo chown -R "${SERVICE_USER}:" "$STORAGE_DIR"

echo ""

# ── 9. Prod-only: system user + systemd ────────────────────────────────────

if [[ "$PROFILE" == "prod" ]]; then
	echo "--- Creating system user ---"
	if ! id -u "$SERVICE_USER" &>/dev/null; then
		run_sudo useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
	else
		echo "[skip] User ${SERVICE_USER} already exists"
	fi

	echo ""
	echo "--- Installing systemd unit ---"

	UNIT_FILE="/etc/systemd/system/boilerhouse.service"
	UNIT_CONTENT="[Unit]
Description=Boilerhouse API Server
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=/opt/boilerhouse
ExecStart=/usr/local/bin/bun run apps/api/src/server.ts
Restart=on-failure
RestartSec=5
Environment=JAILER_BIN=${INSTALL_DIR}/jailer
Environment=JAILER_CHROOT_BASE=${JAILER_DIR}
Environment=STORAGE_PATH=${STORAGE_DIR}
Environment=KERNEL_PATH=${KERNEL_DIR}/vmlinux
Environment=FIRECRACKER_BIN=${INSTALL_DIR}/firecracker

[Install]
WantedBy=multi-user.target"

	if $DRY_RUN; then
		echo "[dry-run] Would write systemd unit to ${UNIT_FILE}"
		echo "$UNIT_CONTENT" | sed 's/^/  /'
	else
		echo "$UNIT_CONTENT" | sudo tee "$UNIT_FILE" > /dev/null
		sudo systemctl daemon-reload
		sudo systemctl enable boilerhouse
	fi

	echo ""
fi

echo "=== Setup complete ==="
echo ""
echo "Next steps:"
if [[ "$PROFILE" == "dev" ]]; then
	echo "  1. Prepare a rootfs image: ./scripts/docker-to-rootfs.sh"
	echo "  2. Start the server:"
	echo "     JAILER_BIN=${INSTALL_DIR}/jailer FIRECRACKER_BIN=${INSTALL_DIR}/firecracker \\"
	echo "       KERNEL_PATH=${KERNEL_DIR}/vmlinux bun run apps/api/src/server.ts"
else
	echo "  1. Deploy application to /opt/boilerhouse"
	echo "  2. Prepare rootfs images"
	echo "  3. Start: sudo systemctl start boilerhouse"
fi
