#!/bin/bash
# kadai:name Container Breakout Tests
# kadai:emoji 🔓
# kadai:description Run CDK container breakout + credential leak tests against real runtimes

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"

# ── Runtime selection ────────────────────────────────────────────────────────

echo "Select runtime for container breakout tests:"
echo "  1) docker      — Container runtime via Docker daemon"
echo "  2) kubernetes  — Pods on minikube (boilerhouse-test profile)"
echo "  3) all         — All real runtimes"
echo ""
read -rp "Runtime [1]: " RUNTIME_CHOICE

case "${RUNTIME_CHOICE:-1}" in
  1|docker)     RUNTIMES="docker" ;;
  2|kubernetes) RUNTIMES="kubernetes" ;;
  3|all)        RUNTIMES="docker,kubernetes" ;;
  *)
    echo "Invalid choice: $RUNTIME_CHOICE" >&2
    exit 1
    ;;
esac

echo ""

# ── Ensure runtime infrastructure ───────────────────────────────────────────

ensure_docker() {
  if ! docker info &>/dev/null; then
    echo "Error: Docker daemon is not running or not accessible." >&2
    echo "Hint: Start Docker Desktop or run: sudo systemctl start docker" >&2
    exit 1
  fi
  echo "✓ Docker daemon is running"
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

if echo "$RUNTIMES" | grep -q "docker"; then
  ensure_docker
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
