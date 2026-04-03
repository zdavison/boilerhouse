#!/bin/bash
# kadai:name Dev
# kadai:emoji 🚀
# kadai:description Start dashboard (background) + API (foreground) — Ctrl+C kills both

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
DASHBOARD_PID=""

cleanup() {
  # Kill entire process group of the dashboard so child processes (e.g.
  # Telegram long-pollers) don't survive as orphans.
  if [ -n "$DASHBOARD_PID" ]; then
    kill "$DASHBOARD_PID" 2>/dev/null || true
    wait "$DASHBOARD_PID" 2>/dev/null || true
  fi
  # Kill any remaining bun children spawned by this session
  pkill -P $$ 2>/dev/null || true
}

trap cleanup EXIT INT TERM

# ── Runtime selection ────────────────────────────────────────────────────────

echo "Select runtime:"
echo "  1) docker     — Container runtime via Docker daemon"
echo "  2) kubernetes — Pods on minikube (boilerhouse-test profile)"
echo ""
read -rp "Runtime [1]: " RUNTIME_CHOICE

case "${RUNTIME_CHOICE:-1}" in
  1|docker)     RUNTIME_TYPE="docker" ;;
  2|kubernetes) RUNTIME_TYPE="kubernetes" ;;
  *)
    echo "Invalid choice: $RUNTIME_CHOICE" >&2
    exit 1
    ;;
esac

echo ""
echo "Using runtime: $RUNTIME_TYPE"
echo ""

# ── Detect observability stack ───────────────────────────────────────────────
# Must run before API start so OTEL_EXPORTER_OTLP_ENDPOINT is set.

TEMPO_HTTP_CODE=$(curl --max-time 1 -s -o /dev/null -w '%{http_code}' http://localhost:4318/v1/traces 2>/dev/null || echo "000")
if [ "$TEMPO_HTTP_CODE" != "000" ]; then
  export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318/v1/traces"
  echo "✓ Observability stack detected (Tempo on :4318)"
  echo "  OTEL_EXPORTER_OTLP_ENDPOINT=$OTEL_EXPORTER_OTLP_ENDPOINT"
  echo ""
else
  echo "ℹ Observability stack not running (start with: docker compose up -d)"
  echo ""
fi

# ── Ensure runtime infrastructure ───────────────────────────────────────────

if [ "$RUNTIME_TYPE" = "docker" ]; then
  if ! docker info &>/dev/null; then
    echo "Error: Docker daemon is not running or not accessible." >&2
    echo "Hint: Start Docker Desktop or run: sudo systemctl start docker" >&2
    exit 1
  fi
  echo "✓ Docker daemon is running"
  echo ""

elif [ "$RUNTIME_TYPE" = "kubernetes" ]; then
  PROFILE="boilerhouse-test"
  NAMESPACE="boilerhouse"

  # Ensure minikube cluster is running
  if minikube status -p "$PROFILE" &>/dev/null; then
    echo "✓ Minikube cluster '$PROFILE' is running"
  else
    echo "Minikube cluster not running — starting..."
    bash "$SCRIPT_DIR/.kadai/actions/minikube.sh"
  fi

  # Verify kubectl can reach the cluster
  if ! kubectl --context="$PROFILE" cluster-info &>/dev/null; then
    echo "Error: kubectl cannot reach minikube cluster" >&2
    exit 1
  fi

  MINIKUBE_IP="$(minikube ip -p "$PROFILE")"
  K8S_TOKEN="$(kubectl --context="$PROFILE" -n "$NAMESPACE" create token default)"

  export K8S_API_URL="https://${MINIKUBE_IP}:8443"
  export K8S_TOKEN="$K8S_TOKEN"
  export K8S_NAMESPACE="$NAMESPACE"
  export K8S_CONTEXT="$PROFILE"
  export K8S_MINIKUBE_PROFILE="$PROFILE"

  # In-cluster infra services
  export REDIS_URL="redis://redis.${NAMESPACE}.svc.cluster.local:6379"

  echo "  API server: ${MINIKUBE_IP}:8443"
  echo ""
fi

# ── Kill stale dev processes ─────────────────────────────────────────────────
# Kill by port AND by command pattern. Orphaned bun processes (e.g. from
# Telegram long-polling) may survive after the port is freed, causing 409
# conflicts on getUpdates.

STALE_PIDS=""
for port in 3000 3001 18080; do
  PID=$(lsof -i :"$port" -t 2>/dev/null || true)
  if [ -n "$PID" ]; then
    STALE_PIDS="$STALE_PIDS $PID"
  fi
done
# Also find bun processes running our server scripts (catches orphans not bound to a port).
# Match both full-path (apps/api/src/server.ts) and short form (src/server.ts) since
# `exec bun --hot src/server.ts` from a cd'd directory only shows the relative path.
# Filter to pids whose cwd is under our project tree to avoid killing unrelated bun processes.
BUN_PIDS=""
for pid in $(pgrep -f 'bun.*src/server\.ts' 2>/dev/null || true); do
  PID_CWD=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep '^n' | head -1 || true)
  if echo "$PID_CWD" | grep -q "$SCRIPT_DIR"; then
    BUN_PIDS="$BUN_PIDS $pid"
  fi
done
if [ -n "$BUN_PIDS" ]; then
  STALE_PIDS="$STALE_PIDS $BUN_PIDS"
fi

# Deduplicate (exclude our own PID) and kill all at once, then wait
STALE_PIDS=$(echo "$STALE_PIDS" | tr ' ' '\n' | grep -v "^$$\$" | sort -u | tr '\n' ' ')
if [ -n "${STALE_PIDS// }" ]; then
  echo "Killing stale processes: $STALE_PIDS"
  kill $STALE_PIDS 2>/dev/null || true
  sleep 1
  # Force-kill any survivors
  for pid in $STALE_PIDS; do
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  done
  sleep 0.3
fi

# ── Start dashboard + API ────────────────────────────────────────────────────

# Start dashboard in background
echo "Starting dashboard..."
cd "$SCRIPT_DIR/apps/dashboard"
bun --hot src/server.ts &
DASHBOARD_PID=$!
echo "Dashboard running (PID $DASHBOARD_PID)"

# Start API in foreground with runtime env vars
echo ""
echo "Starting API (RUNTIME_TYPE=$RUNTIME_TYPE)..."
cd "$SCRIPT_DIR/apps/api"
export RUNTIME_TYPE="$RUNTIME_TYPE"
exec bun --hot src/server.ts
