#!/bin/bash
# kadai:name Container Breakout Tests
# kadai:emoji 🔓
# kadai:description Run CDK container breakout + credential leak tests against real runtimes

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"

IS_MACOS=false
if [ "$(uname -s)" = "Darwin" ]; then
  IS_MACOS=true
fi

# ── Runtime selection ────────────────────────────────────────────────────────

echo "Select runtime for container breakout tests:"
echo "  1) podman      — Container runtime via boilerhouse-podmand"
echo "  2) kubernetes  — Pods on minikube (boilerhouse-test profile)"
echo "  3) all         — All real runtimes"
echo ""
read -rp "Runtime [1]: " RUNTIME_CHOICE

case "${RUNTIME_CHOICE:-1}" in
  1|podman)     RUNTIMES="podman" ;;
  2|kubernetes) RUNTIMES="kubernetes" ;;
  3|all)        RUNTIMES="podman,kubernetes" ;;
  *)
    echo "Invalid choice: $RUNTIME_CHOICE" >&2
    exit 1
    ;;
esac

echo ""

# ── Ensure runtime infrastructure ───────────────────────────────────────────

ensure_podman() {
  if [ "$IS_MACOS" = true ]; then
    RUNTIME_SOCKET="${LISTEN_SOCKET:-$HOME/.local/share/boilerhouse/runtime.sock}"
  else
    RUNTIME_SOCKET="${LISTEN_SOCKET:-/var/run/boilerhouse/runtime.sock}"
  fi

  if [ -S "$RUNTIME_SOCKET" ]; then
    if curl --unix-socket "$RUNTIME_SOCKET" --max-time 2 -sf http://localhost/healthz &>/dev/null; then
      echo "✓ Podman daemon already running"
      return 0
    else
      echo "Stale daemon socket — restarting..."
      bash "$SCRIPT_DIR/.kadai/actions/daemon.sh"
    fi
  else
    echo "Podman daemon not running — starting..."
    bash "$SCRIPT_DIR/.kadai/actions/daemon.sh"
  fi
}

ensure_kubernetes() {
  local PROFILE="boilerhouse-test"

  if minikube status -p "$PROFILE" &>/dev/null; then
    echo "✓ Minikube cluster '$PROFILE' is running"
  else
    echo "Minikube cluster not running — starting..."
    bash "$SCRIPT_DIR/.kadai/actions/minikube.sh"
  fi

  if ! kubectl --context="$PROFILE" cluster-info &>/dev/null; then
    echo "Error: kubectl cannot reach minikube cluster" >&2
    return 1
  fi
}

if echo "$RUNTIMES" | grep -q "podman"; then
  ensure_podman
  export BOILERHOUSE_CRIU_AVAILABLE=true
fi

if echo "$RUNTIMES" | grep -q "kubernetes"; then
  ensure_kubernetes
fi

echo ""

# ── Run container breakout tests ────────────────────────────────────────────

echo "Running container breakout tests against: $RUNTIMES"

TEST_OUTPUT=$(env BOILERHOUSE_E2E_RUNTIMES="$RUNTIMES" bun run tests/security/container-breakout/breakout.ts 2>&1) || true
TEST_EXIT=$?

# ── Print raw output ────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════════════════════"
echo "  Raw Test Output"
echo "═══════════════════════════════════════════════════════════════════════"
echo ""
echo "$TEST_OUTPUT"

# ── AI Summary ──────────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════════════════════"
echo "  AI Summary"
echo "═══════════════════════════════════════════════════════════════════════"
echo ""

echo "$TEST_OUTPUT" | deerbox "You are a security engineer reviewing container breakout test results from CDK (Container Debug Toolkit). Summarize the results concisely: which runtimes were tested, how many findings were detected, whether any critical escape vectors were found, and an overall pass/fail verdict. Be brief."

exit $TEST_EXIT
