#!/usr/bin/env bash
# Integration tests for overlay-init.sh.
# Requires: BOILERHOUSE_INTEGRATION=1 and root (for mount/losetup/pivot_root).
set -euo pipefail

if [[ "${BOILERHOUSE_INTEGRATION:-}" != "1" ]]; then
  echo "SKIP: set BOILERHOUSE_INTEGRATION=1 to run"
  exit 0
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "SKIP: must run as root (sudo)"
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OVERLAY_SCRIPT="${SCRIPT_DIR}/overlay-init.sh"
PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

cleanup() {
  # Unmount in reverse order
  umount "$WORK_DIR/merged" 2>/dev/null || true
  umount "$WORK_DIR/overlay" 2>/dev/null || true
  umount "$WORK_DIR/base" 2>/dev/null || true
  [[ -n "${LOOP_BASE:-}" ]] && losetup -d "$LOOP_BASE" 2>/dev/null || true
  [[ -n "${LOOP_OVERLAY:-}" ]] && losetup -d "$LOOP_OVERLAY" 2>/dev/null || true
  [[ -n "${WORK_DIR:-}" ]] && rm -rf "$WORK_DIR"
}
trap cleanup EXIT

WORK_DIR=$(mktemp -d)

echo "=== overlay-init.sh integration tests ==="

# --- Test 1: Script is executable ---
echo "-- executable bit --"
if [[ -x "$OVERLAY_SCRIPT" ]]; then
  pass "overlay-init.sh is executable"
else
  fail "overlay-init.sh is NOT executable"
fi

# --- Test 2: Script has valid shebang ---
echo "-- valid shebang --"
SHEBANG=$(head -1 "$OVERLAY_SCRIPT")
if [[ "$SHEBANG" == "#!/bin/sh" ]] || [[ "$SHEBANG" == "#!/bin/bash" ]]; then
  pass "valid shebang: $SHEBANG"
else
  fail "unexpected shebang: $SHEBANG"
fi

# --- Test 3: OverlayFS merge test ---
echo "-- overlayfs merge --"

# Create a squashfs base image with a test file
mkdir -p "$WORK_DIR/base-content"
echo "BASE_FILE_CONTENT" > "$WORK_DIR/base-content/base.txt"
mkdir -p "$WORK_DIR/base-content/bin"
cp /bin/sh "$WORK_DIR/base-content/bin/sh" 2>/dev/null || true

if command -v mksquashfs >/dev/null 2>&1; then
  mksquashfs "$WORK_DIR/base-content" "$WORK_DIR/base.sqsh" -quiet 2>/dev/null

  # Create an ext4 overlay image
  dd if=/dev/zero of="$WORK_DIR/overlay.ext4" bs=1M count=32 2>/dev/null
  mkfs.ext4 -F "$WORK_DIR/overlay.ext4" >/dev/null 2>&1

  # Mount both and set up overlayfs manually to test the concept
  mkdir -p "$WORK_DIR/base" "$WORK_DIR/overlay" "$WORK_DIR/merged"
  mount -t squashfs "$WORK_DIR/base.sqsh" "$WORK_DIR/base" -o ro
  LOOP_OVERLAY=$(losetup --find --show "$WORK_DIR/overlay.ext4")
  mount "$LOOP_OVERLAY" "$WORK_DIR/overlay"

  mkdir -p "$WORK_DIR/overlay/upper" "$WORK_DIR/overlay/work"
  mount -t overlay overlay \
    -o "lowerdir=$WORK_DIR/base,upperdir=$WORK_DIR/overlay/upper,workdir=$WORK_DIR/overlay/work" \
    "$WORK_DIR/merged"

  # Verify base file is visible through overlay
  if [[ -f "$WORK_DIR/merged/base.txt" ]]; then
    CONTENT=$(cat "$WORK_DIR/merged/base.txt")
    if [[ "$CONTENT" == "BASE_FILE_CONTENT" ]]; then
      pass "base file visible through overlay"
    else
      fail "base file has wrong content: $CONTENT"
    fi
  else
    fail "base file not visible through overlay"
  fi

  # --- Test 4: Write isolation ---
  echo "-- write isolation --"
  echo "OVERLAY_WRITE" > "$WORK_DIR/merged/new-file.txt"

  # New file should appear in overlay upper, NOT in base
  if [[ -f "$WORK_DIR/overlay/upper/new-file.txt" ]]; then
    pass "writes go to overlay upper dir"
  else
    fail "write did not land in overlay upper dir"
  fi

  if [[ ! -f "$WORK_DIR/base/new-file.txt" ]]; then
    pass "base remains read-only (no new file)"
  else
    fail "write leaked into base layer"
  fi

  # Cleanup mounts for this test
  umount "$WORK_DIR/merged" 2>/dev/null || true
  umount "$LOOP_OVERLAY" 2>/dev/null || true
  umount "$WORK_DIR/base" 2>/dev/null || true
  losetup -d "$LOOP_OVERLAY" 2>/dev/null || true
  LOOP_OVERLAY=""
else
  echo "  SKIP: mksquashfs not installed"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
