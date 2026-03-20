#!/bin/bash
# kadai:name E2E Tests
# kadai:emoji 🧪
# kadai:description Run E2E tests against a selected runtime (ensures infrastructure is ready)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

IS_MACOS=false
if [ "$(uname -s)" = "Darwin" ]; then
  IS_MACOS=true
fi

# ── Runtime selection ────────────────────────────────────────────────────────

echo "Select runtime for E2E tests:"
echo "  1) fake        — In-memory fake runtime (no infra needed)"
echo "  2) podman      — Container runtime via boilerhouse-podmand"
echo "  3) kubernetes  — Pods on minikube (boilerhouse-test profile)"
echo "  4) all         — All available runtimes"
echo ""
read -rp "Runtime [1]: " RUNTIME_CHOICE

case "${RUNTIME_CHOICE:-1}" in
  1|fake)       RUNTIMES="fake" ;;
  2|podman)     RUNTIMES="podman" ;;
  3|kubernetes) RUNTIMES="kubernetes" ;;
  4|all)        RUNTIMES="all" ;;
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

if [ "$RUNTIMES" = "podman" ] || [ "$RUNTIMES" = "all" ]; then
  ensure_podman
  export BOILERHOUSE_CRIU_AVAILABLE=true
fi

if [ "$RUNTIMES" = "kubernetes" ] || [ "$RUNTIMES" = "all" ]; then
  ensure_kubernetes
fi

echo ""

# ── Run E2E tests ────────────────────────────────────────────────────────────

EXIT_CODE=0

if [ "$RUNTIMES" = "all" ]; then
  echo "Running E2E tests against all available runtimes..."
  bun test apps/api/src/e2e/ --timeout 120000 || EXIT_CODE=$?
else
  echo "Running E2E tests against: $RUNTIMES"
  BOILERHOUSE_E2E_RUNTIMES="$RUNTIMES" bun test apps/api/src/e2e/ --timeout 120000 || EXIT_CODE=$?
fi

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
if [ "$EXIT_CODE" -eq 0 ]; then
  echo "E2E tests passed."
else
  echo "E2E tests failed (exit $EXIT_CODE)."
fi

exit "$EXIT_CODE"
