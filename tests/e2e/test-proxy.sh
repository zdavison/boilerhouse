#!/bin/bash
# Quick E2E test for the Envoy sidecar proxy + iptables transparent redirect.
# Usage: bash tests/e2e/test-proxy.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
API_URL="http://127.0.0.1:3000/api/v1"
API_DIR="$SCRIPT_DIR/apps/api"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

fail() { echo -e "${RED}FAIL:${NC} $1" >&2; exit 1; }
ok()   { echo -e "${GREEN}OK:${NC} $1"; }
info() { echo -e "${YELLOW}>>>${NC} $1"; }

# ── 1. Nuke ──────────────────────────────────────────────────────────────────
info "Nuking local data..."
bash "$SCRIPT_DIR/.kadai/actions/nuke.sh" 2>/dev/null || true
ok "Nuked"

# ── 2. Start API in background ──────────────────────────────────────────────
info "Starting API server..."

# Source the .env so the server gets all config
set -a
source "$API_DIR/.env"
set +a
export RUNTIME_TYPE=docker

cd "$API_DIR"
bun --hot src/server.ts > /tmp/boilerhouse-test-api.log 2>&1 &
API_PID=$!

cleanup() {
  kill "$API_PID" 2>/dev/null || true
  wait "$API_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Wait for API to be ready
info "Waiting for API..."
for i in $(seq 1 30); do
  if curl -sf "$API_URL/health" > /dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo "API server died. Logs:"
    cat /tmp/boilerhouse-test-api.log
    fail "API server exited unexpectedly"
  fi
  sleep 1
done
curl -sf "$API_URL/health" > /dev/null 2>&1 || fail "API did not start in time"
ok "API is up (PID $API_PID)"

# ── 3. Wait for workload to be ready ────────────────────────────────────────
info "Waiting for openclaw workload to be ready..."
for i in $(seq 1 90); do
  STATUS=$(curl -sf "$API_URL/workloads" 2>/dev/null | python3 -c "
import sys, json
wl = json.load(sys.stdin)
for w in wl:
  if w['name'] == 'openclaw':
    print(w['status'])
    break
" 2>/dev/null || echo "unknown")
  if [ "$STATUS" = "ready" ]; then
    break
  fi
  sleep 2
done
[ "$STATUS" = "ready" ] || fail "Workload not ready (status: $STATUS). Logs:\n$(cat /tmp/boilerhouse-test-api.log | tail -30)"
ok "Workload is ready"

# ── 4. Check that sidecar containers exist ──────────────────────────────────
info "Checking for proxy sidecar containers..."
PROXY_COUNT=$(docker ps --filter "label=boilerhouse.role=proxy" -q | wc -l | tr -d ' ')
[ "$PROXY_COUNT" -gt 0 ] || fail "No proxy sidecar containers found"
ok "Found $PROXY_COUNT proxy sidecar(s)"

# ── 5. Get a workload container and test Envoy reachability ─────────────────
info "Testing Envoy proxy reachability from workload container..."
WORKLOAD_CID=$(docker ps --filter "label=boilerhouse.role=workload" -q | head -1)
[ -n "$WORKLOAD_CID" ] || fail "No workload container found"

# Test that iptables redirect is working — curl to api.anthropic.com:80 should hit Envoy
ENVOY_TEST=$(docker exec "$WORKLOAD_CID" node -e "
fetch('http://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-api-key': 'test',
    'anthropic-version': '2023-06-01'
  },
  body: JSON.stringify({
    model: 'claude-opus-4-6',
    max_tokens: 5,
    messages: [{role: 'user', content: 'Say just the word hello'}]
  })
}).then(async r => {
  const body = await r.text();
  console.log(JSON.stringify({ status: r.status, body: body.slice(0, 300) }));
}).catch(e => console.log(JSON.stringify({ error: e.message })));
" 2>&1) || fail "Failed to exec into workload container"

echo "  Envoy test response: $ENVOY_TEST"

# Check if we got a successful response (200) — means iptables + Envoy + cred injection all work
ENVOY_STATUS=$(echo "$ENVOY_TEST" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status', 'error'))" 2>/dev/null || echo "error")
if [ "$ENVOY_STATUS" = "200" ]; then
  ok "Transparent proxy works! Got 200 from Anthropic API via Envoy"
elif [ "$ENVOY_STATUS" = "403" ]; then
  # 403 from Cloudflare means Envoy reached upstream but Host header was wrong
  fail "Got 403 — Envoy reached upstream but Host header mismatch"
elif [ "$ENVOY_STATUS" = "401" ]; then
  fail "Got 401 — Envoy credential injection not working"
else
  fail "Unexpected response: $ENVOY_TEST"
fi

# ── 6. Show container state ─────────────────────────────────────────────────
info "Container state:"
docker ps --filter "label=boilerhouse.managed=true" --format "  {{.Names}}\t{{.Status}}\t{{.Image}}"

# ── 7. Show proxy logs ──────────────────────────────────────────────────────
info "Proxy sidecar logs:"
PROXY_CID=$(docker ps --filter "label=boilerhouse.role=proxy" -q | head -1)
docker logs "$PROXY_CID" 2>&1 | tail -10 | sed 's/^/  /'

echo ""
echo -e "${GREEN}All checks passed!${NC}"
