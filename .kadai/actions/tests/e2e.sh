#!/bin/bash
# kadai:name E2E Tests
# kadai:emoji 🧪
# kadai:description Run E2E tests against a selected runtime (ensures infrastructure is ready)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"

# ── Runtime selection ────────────────────────────────────────────────────────

echo "Select runtime for E2E tests:"
echo "  1) fake        — In-memory fake runtime (no infra needed)"
echo "  2) docker      — Container runtime via Docker daemon"
echo "  3) kubernetes  — Pods on minikube (boilerhouse-test profile)"
echo "  4) all         — All available runtimes"
echo ""
read -rp "Runtime [1]: " RUNTIME_CHOICE

case "${RUNTIME_CHOICE:-1}" in
  1|fake)       RUNTIMES="fake" ;;
  2|docker)     RUNTIMES="docker" ;;
  3|kubernetes) RUNTIMES="kubernetes" ;;
  4|all)        RUNTIMES="all" ;;
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
  local NAMESPACE="boilerhouse"

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

  # Point at in-cluster infra services
  export REDIS_URL="redis://redis.${NAMESPACE}.svc.cluster.local:6379"
}

if [ "$RUNTIMES" = "docker" ] || [ "$RUNTIMES" = "all" ]; then
  ensure_docker
fi

if [ "$RUNTIMES" = "kubernetes" ] || [ "$RUNTIMES" = "all" ]; then
  ensure_kubernetes
fi

echo ""

# ── Run E2E tests ────────────────────────────────────────────────────────────
# exec replaces this shell with bun so Ctrl+C is delivered directly to the
# test runner instead of orphaning it in the background.

if [ "$RUNTIMES" = "all" ]; then
  echo "Running E2E tests against all available runtimes..."
  exec bun test tests/e2e/ --timeout 120000
else
  echo "Running E2E tests against: $RUNTIMES"
  exec env BOILERHOUSE_E2E_RUNTIMES="$RUNTIMES" bun test tests/e2e/ --timeout 120000
fi
