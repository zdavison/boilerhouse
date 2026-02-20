#!/bin/sh
#
# Boilerhouse overlay filesystem init.
#
# Runs as the kernel's init= before the real init. Sets up an overlayfs
# using a squashfs base (read-only) + ext4 overlay (read-write), then
# pivot_roots into the merged view and execs the real init.
#
# Kernel cmdline parameters:
#   boilerhouse.base_dev=<device>      — block device for squashfs base
#   boilerhouse.overlay_dev=<device>   — block device for ext4 overlay
#   boilerhouse.init=<path>            — real init path (default: /opt/boilerhouse/init)
#
set -e

die() {
  echo "overlay-init: FATAL: $*" >&2
  exec /bin/sh  # Drop to shell on failure
}

# Mount /proc to read cmdline (may already be mounted).
mount -t proc proc /proc 2>/dev/null || true

# Parse kernel cmdline.
CMDLINE=$(cat /proc/cmdline)

get_param() {
  echo "$CMDLINE" | tr ' ' '\n' | grep "^$1=" | head -1 | cut -d= -f2-
}

BASE_DEV=$(get_param "boilerhouse.base_dev")
OVERLAY_DEV=$(get_param "boilerhouse.overlay_dev")
REAL_INIT=$(get_param "boilerhouse.init")

: "${BASE_DEV:?overlay-init: boilerhouse.base_dev not set in kernel cmdline}"
: "${OVERLAY_DEV:?overlay-init: boilerhouse.overlay_dev not set in kernel cmdline}"
: "${REAL_INIT:=/opt/boilerhouse/init}"

# Create mount points.
mkdir -p /mnt/base /mnt/overlay /mnt/merged /mnt/overlay-work

# Mount squashfs base (read-only).
mount -t squashfs -o ro "$BASE_DEV" /mnt/base || die "failed to mount squashfs: $BASE_DEV"

# Mount ext4 overlay (read-write).
mount -t ext4 "$OVERLAY_DEV" /mnt/overlay || die "failed to mount ext4: $OVERLAY_DEV"

# Prepare overlay directories.
mkdir -p /mnt/overlay/upper /mnt/overlay/work

# Mount overlayfs.
mount -t overlay overlay \
  -o "lowerdir=/mnt/base,upperdir=/mnt/overlay/upper,workdir=/mnt/overlay/work" \
  /mnt/merged || die "failed to mount overlayfs"

# Move essential mounts into the new root.
mkdir -p /mnt/merged/proc /mnt/merged/sys /mnt/merged/dev

# Move /proc into the new root (we'll re-mount it in init).
umount /proc 2>/dev/null || true

# Set up pivot_root: the old root goes into a temporary directory.
mkdir -p /mnt/merged/mnt/old-root

# pivot_root swaps the root filesystem.
cd /mnt/merged
pivot_root . mnt/old-root

# Clean up old root mounts (lazy unmount to avoid busy errors).
umount -l /mnt/old-root 2>/dev/null || true

# Exec the real init.
exec "$REAL_INIT" "$@"
