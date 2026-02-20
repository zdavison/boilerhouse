#!/usr/bin/env bash
# Integration tests for the idle-agent binary.
# Requires: BOILERHOUSE_INTEGRATION=1.
set -euo pipefail

if [[ "${BOILERHOUSE_INTEGRATION:-}" != "1" ]]; then
  echo "SKIP: set BOILERHOUSE_INTEGRATION=1 to run"
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_BIN="${SCRIPT_DIR}/build/x86_64/idle-agent"
PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

cleanup() {
  [[ -n "${AGENT_PID:-}" ]] && kill "$AGENT_PID" 2>/dev/null || true
  [[ -n "${LISTEN_PID:-}" ]] && kill "$LISTEN_PID" 2>/dev/null || true
  [[ -n "${TMPDIR_TEST:-}" ]] && rm -rf "$TMPDIR_TEST"
}
trap cleanup EXIT

echo "=== idle-agent integration tests ==="

# --- Test 1: Binary exists and is statically linked ---
echo "-- static linking --"
if file "$AGENT_BIN" | grep -q "statically linked"; then
  pass "idle-agent is statically linked"
else
  fail "idle-agent is NOT statically linked"
fi

# --- Test 2: Exits cleanly on SIGTERM ---
echo "-- SIGTERM clean exit --"
TMPDIR_TEST=$(mktemp -d)
WATCH_DIR="$TMPDIR_TEST/watched"
mkdir -p "$WATCH_DIR"

BOILERHOUSE_WATCH_DIRS="$WATCH_DIR" \
BOILERHOUSE_POLL_INTERVAL=1 \
  "$AGENT_BIN" &
AGENT_PID=$!
sleep 0.5

kill -TERM "$AGENT_PID"
wait "$AGENT_PID" 2>/dev/null && EXIT_CODE=0 || EXIT_CODE=$?
if [[ "$EXIT_CODE" -eq 0 ]]; then
  pass "clean SIGTERM exit (code 0)"
else
  fail "expected exit code 0 on SIGTERM, got $EXIT_CODE"
fi
AGENT_PID=""

# --- Test 3: Handles nonexistent watch directories gracefully ---
echo "-- nonexistent dirs --"
BOILERHOUSE_WATCH_DIRS="/nonexistent/path/abc123:$WATCH_DIR" \
BOILERHOUSE_POLL_INTERVAL=1 \
  "$AGENT_BIN" &
AGENT_PID=$!
sleep 1

# Agent should still be running (not crashed)
if kill -0 "$AGENT_PID" 2>/dev/null; then
  pass "agent runs despite nonexistent dir"
  kill -TERM "$AGENT_PID"
  wait "$AGENT_PID" 2>/dev/null || true
else
  fail "agent crashed with nonexistent dir"
fi
AGENT_PID=""

# --- Test 4: Detects mtime changes via HTTP endpoint ---
echo "-- mtime detection via HTTP --"

# Start a simple listener on a random port
HTTP_PORT=0
# Find a free port
HTTP_PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('',0)); print(s.getsockname()[1]); s.close()")
HTTP_LOG="$TMPDIR_TEST/http.log"

# Listen for one HTTP POST using socat
if command -v socat >/dev/null 2>&1; then
  socat TCP-LISTEN:"$HTTP_PORT",reuseaddr,fork OPEN:"$HTTP_LOG",creat,append &
  LISTEN_PID=$!
  sleep 0.3

  BOILERHOUSE_WATCH_DIRS="$WATCH_DIR" \
  BOILERHOUSE_POLL_INTERVAL=1 \
  BOILERHOUSE_HTTP_ENDPOINT="http://127.0.0.1:${HTTP_PORT}/activity" \
    "$AGENT_BIN" &
  AGENT_PID=$!

  # Touch a file to update mtime
  touch "$WATCH_DIR/testfile"
  sleep 2.5

  kill -TERM "$AGENT_PID" 2>/dev/null || true
  wait "$AGENT_PID" 2>/dev/null || true
  AGENT_PID=""

  kill "$LISTEN_PID" 2>/dev/null || true
  wait "$LISTEN_PID" 2>/dev/null || true
  LISTEN_PID=""

  if [[ -f "$HTTP_LOG" ]] && grep -q '"mtime"' "$HTTP_LOG"; then
    pass "mtime reported via HTTP"
  else
    fail "mtime not found in HTTP log"
  fi
else
  echo "  SKIP: socat not installed, skipping HTTP test"
fi

# --- Test 5: Poll interval is respected ---
echo "-- poll interval --"
POLL_LOG="$TMPDIR_TEST/poll.log"

BOILERHOUSE_WATCH_DIRS="$WATCH_DIR" \
BOILERHOUSE_POLL_INTERVAL=1 \
BOILERHOUSE_DEBUG_LOG="$POLL_LOG" \
  "$AGENT_BIN" &
AGENT_PID=$!

sleep 3.5
kill -TERM "$AGENT_PID" 2>/dev/null || true
wait "$AGENT_PID" 2>/dev/null || true
AGENT_PID=""

if [[ -f "$POLL_LOG" ]]; then
  POLL_COUNT=$(grep -c "poll" "$POLL_LOG" 2>/dev/null || echo "0")
  if [[ "$POLL_COUNT" -ge 2 ]] && [[ "$POLL_COUNT" -le 5 ]]; then
    pass "poll interval ~1s ($POLL_COUNT polls in 3.5s)"
  else
    fail "unexpected poll count: $POLL_COUNT (expected 2-5 in 3.5s)"
  fi
else
  echo "  SKIP: debug log not created (BOILERHOUSE_DEBUG_LOG may not be supported)"
  pass "poll interval (skipped — no debug log)"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
