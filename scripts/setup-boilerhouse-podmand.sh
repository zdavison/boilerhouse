#!/usr/bin/env bash
set -euo pipefail

# Installs and configures rootful podman with crun + CRIU for Boilerhouse.
#
# Usage:
#   sudo scripts/setup-boilerhouse-podmand.sh
#   sudo scripts/setup-boilerhouse-podmand.sh --dry-run
#
# What this script does:
#   1. Installs podman, crun, and criu via the system package manager
#   2. Verifies crun is the active OCI runtime
#   3. Verifies CRIU is enabled
#   4. Creates the socket directory and starts the podman API daemon
#
# Supported distros: Ubuntu, Debian, Fedora, RHEL, CentOS, Arch

DRY_RUN=false
SOCKET_PATH="${PODMAN_SOCKET:-/var/run/boilerhouse/podman.sock}"
MIN_CRIU_VERSION="4.2"

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

info() {
	echo "==> $*"
}

warn() {
	echo "WARNING: $*" >&2
}

fail() {
	echo "ERROR: $*" >&2
	exit 1
}

# Returns 0 if $1 >= $2 (version comparison)
version_gte() {
	printf '%s\n%s\n' "$2" "$1" | sort -V -C
}

if [ "$(id -u)" -ne 0 ]; then
	fail "This script must be run as root (use sudo)."
fi

# ── Detect distro ────────────────────────────────────────────────────────────

if [ -f /etc/os-release ]; then
	# shellcheck disable=SC1091
	. /etc/os-release
	DISTRO="${ID}"
else
	fail "Cannot detect distribution (no /etc/os-release)."
fi

info "Detected distro: ${DISTRO}"

# ── Install packages ─────────────────────────────────────────────────────────

# Skip installation if all binaries already exist
NEED_INSTALL=false
for cmd in podman crun criu; do
	if ! command -v "$cmd" &>/dev/null; then
		NEED_INSTALL=true
		break
	fi
done

if [ "$NEED_INSTALL" = true ]; then
	info "Installing podman, crun, and criu..."

	case "${DISTRO}" in
		ubuntu|debian|pop)
			# update can fail due to broken PPAs — don't abort
			run apt-get update -qq || warn "apt-get update had errors (continuing anyway)"
			# install can fail due to unrelated broken packages (e.g. nvidia) — don't abort
			run apt-get install -y -qq podman crun criu || warn "apt-get install had errors (continuing anyway)"
			;;
		fedora)
			run dnf install -y podman crun criu
			;;
		rhel|centos|rocky|almalinux)
			run dnf install -y podman crun criu
			;;
		arch|manjaro)
			run pacman -S --noconfirm --needed podman crun criu
			;;
		*)
			warn "Unsupported distro '${DISTRO}'. Install podman, crun, and criu manually."
			;;
	esac
else
	info "podman, crun, and criu already installed — skipping package install."
fi

# ── Verify installation ─────────────────────────────────────────────────────

info "Verifying installation..."

if [ "$DRY_RUN" = true ]; then
	echo "[dry-run] would verify podman, crun, criu versions"
else
	# Check binaries exist
	for cmd in podman crun; do
		if ! command -v "$cmd" &>/dev/null; then
			fail "'${cmd}' not found on PATH after installation."
		fi
	done

	PODMAN_VERSION=$(podman --version | grep -oP '\d+\.\d+\.\d+' | head -1)
	CRUN_VERSION=$(crun --version | grep -oP '\d+\.\d+(\.\d+)?' | head -1)

	echo "  podman: ${PODMAN_VERSION}"
	echo "  crun:   ${CRUN_VERSION}"

	# ── CRIU version check ─────────────────────────────────────────────────
	# Kernel 6.x changed getsockopt behavior for SO_PASSCRED/SO_PASSSEC on
	# AF_INET sockets (returns EOPNOTSUPP). CRIU < 4.2 treats this as fatal,
	# causing checkpoint to fail. We need >= 4.2 which only dumps these
	# socket options on AF_UNIX/AF_NETLINK.

	NEED_CRIU_BUILD=false

	if command -v criu &>/dev/null; then
		CRIU_VERSION=$(criu --version | grep -oP '\d+\.\d+(\.\d+)?' | head -1)
		echo "  criu:   ${CRIU_VERSION}"

		if ! version_gte "${CRIU_VERSION}" "${MIN_CRIU_VERSION}"; then
			warn "CRIU ${CRIU_VERSION} is too old (need >= ${MIN_CRIU_VERSION} for kernel $(uname -r))."
			NEED_CRIU_BUILD=true
		fi
	else
		warn "criu not found on PATH."
		NEED_CRIU_BUILD=true
	fi

	if [ "${NEED_CRIU_BUILD}" = true ]; then
		info "Building CRIU ${MIN_CRIU_VERSION} from source..."

		# Install build dependencies
		case "${DISTRO}" in
			ubuntu|debian|pop)
				run apt-get install -y -qq \
					build-essential pkg-config python3-minimal \
					libprotobuf-dev libprotobuf-c-dev protobuf-c-compiler protobuf-compiler \
					libcap-dev libnl-3-dev libnet1-dev libaio-dev libgnutls28-dev \
					asciidoc xmlto \
					|| warn "apt-get install (build deps) had errors (continuing anyway)"
				;;
			fedora|rhel|centos|rocky|almalinux)
				run dnf install -y \
					gcc make pkg-config python3 \
					protobuf-devel protobuf-c-devel \
					libcap-devel libnl3-devel libnet-devel libaio-devel gnutls-devel \
					asciidoc xmlto
				;;
			arch|manjaro)
				run pacman -S --noconfirm --needed \
					base-devel pkg-config python \
					protobuf protobuf-c \
					libcap libnl libnet libaio gnutls \
					asciidoc xmlto
				;;
			*)
				warn "Cannot install CRIU build deps for '${DISTRO}'. Install manually."
				;;
		esac

		CRIU_BUILD_DIR=$(mktemp -d)
		trap "rm -rf '${CRIU_BUILD_DIR}'" EXIT

		info "Downloading CRIU v${MIN_CRIU_VERSION} source..."
		run curl -sL "https://github.com/checkpoint-restore/criu/archive/refs/tags/v${MIN_CRIU_VERSION}.tar.gz" \
			-o "${CRIU_BUILD_DIR}/criu.tar.gz"
		run tar -xzf "${CRIU_BUILD_DIR}/criu.tar.gz" -C "${CRIU_BUILD_DIR}" --strip-components=1

		info "Compiling CRIU (this may take a few minutes)..."
		run make -C "${CRIU_BUILD_DIR}" -j"$(nproc)" 2>&1 | tail -5

		info "Installing CRIU..."
		run make -C "${CRIU_BUILD_DIR}" install PREFIX=/usr/local

		# Verify the new build
		if command -v /usr/local/sbin/criu &>/dev/null; then
			CRIU_VERSION=$(/usr/local/sbin/criu --version | grep -oP '\d+\.\d+(\.\d+)?' | head -1)
			echo "  criu:   ${CRIU_VERSION} (built from source, installed to /usr/local/sbin/criu)"
		elif command -v criu &>/dev/null; then
			CRIU_VERSION=$(criu --version | grep -oP '\d+\.\d+(\.\d+)?' | head -1)
			echo "  criu:   ${CRIU_VERSION} (built from source)"
		else
			fail "CRIU build succeeded but binary not found on PATH."
		fi
	fi

	# Verify podman uses crun
	OCI_RUNTIME=$(podman info --format '{{.Host.OCIRuntime.Name}}' 2>/dev/null || true)
	if [ "${OCI_RUNTIME}" != "crun" ]; then
		warn "Podman OCI runtime is '${OCI_RUNTIME}', not 'crun'."
		warn "Checkpoint/restore requires crun. Configuring podman to use crun..."

		# Set crun as the default runtime in containers.conf
		CONF_DIR="/etc/containers"
		CONF_FILE="${CONF_DIR}/containers.conf"
		run mkdir -p "${CONF_DIR}"

		if [ -f "${CONF_FILE}" ]; then
			# Check if [engine] section exists
			if grep -q '^\[engine\]' "${CONF_FILE}"; then
				if grep -q '^runtime' "${CONF_FILE}"; then
					run sed -i 's/^runtime.*/runtime = "crun"/' "${CONF_FILE}"
				else
					run sed -i '/^\[engine\]/a runtime = "crun"' "${CONF_FILE}"
				fi
			else
				echo -e '\n[engine]\nruntime = "crun"' | run tee -a "${CONF_FILE}" >/dev/null
			fi
		else
			run tee "${CONF_FILE}" >/dev/null <<-'CONF'
			[engine]
			runtime = "crun"
			CONF
		fi

		# Verify the change took effect
		OCI_RUNTIME=$(podman info --format '{{.Host.OCIRuntime.Name}}' 2>/dev/null || true)
		if [ "${OCI_RUNTIME}" = "crun" ]; then
			echo "  OCI runtime: crun (configured)"
		else
			warn "Could not set crun as OCI runtime. You may need to configure it manually."
			warn "Add 'runtime = \"crun\"' under [engine] in /etc/containers/containers.conf"
		fi
	else
		echo "  OCI runtime: crun"
	fi

	# Verify CRIU is enabled
	CRIU_ENABLED=$(podman info --format '{{.Host.CriuEnabled}}' 2>/dev/null || true)
	if [ "${CRIU_ENABLED}" != "true" ]; then
		warn "CRIU is not enabled in podman. Check that criu is on PATH and podman is rootful."
	else
		echo "  CRIU enabled: true"
	fi
fi

# ── Set up socket directory ──────────────────────────────────────────────────

info "Setting up socket directory..."

run mkdir -p "$(dirname "${SOCKET_PATH}")"

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
info "Setup complete."
echo ""
echo "Next steps:"
echo "  1. Start the boilerhouse-podmand runtime daemon:"
echo "     sudo scripts/start-boilerhouse-podmand.sh"
echo ""
echo "  2. Install project dependencies:"
echo "     bun install"
echo ""
echo "  3. Start the dev server:"
echo "     bun dev"
