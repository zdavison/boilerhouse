#!/bin/bash
# kadai:name Preset: OpenClaw
# kadai:emoji 🤖
# kadai:description Batteries included preset for running OpenClaw workloads.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/_lib.sh"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║       Boilerhouse: OpenClaw Preset       ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── Load existing config ─────────────────────────────────────────────────────

load_env

# ── Prerequisites ─────────────────────────────────────────────────────────────

echo "Prerequisites:"
ensure_bun_version
ensure_compose_up
echo ""

# ── Core settings ────────────────────────────────────────────────────────────

echo "Core settings:"
ensure_secret_key
ensure_runtime_type
ensure_env_var STORAGE_PATH "Storage path" "./data"
echo ""

# ── Stage workloads ──────────────────────────────────────────────────────────

echo "Staging workloads:"
stage_workloads \
  openclaw.workload.ts \
  tg-openclaw.trigger.ts \
  openclaw/
echo ""

# ── OpenClaw-specific settings ───────────────────────────────────────────────

echo "OpenClaw settings:"
ensure_env_var ALLOWLIST_TENANT_IDS "Telegram allowlist tenant IDs (comma-separated, e.g. tg-yourusername)"
ensure_env_var ANTHROPIC_API_KEY "Anthropic API key (sk-ant-...)" --secret
ensure_env_var TELEGRAM_BOT_TOKEN "Telegram bot token"

if ! _is_set TELEGRAM_SECRET_TOKEN; then
  TELEGRAM_SECRET_TOKEN=$(openssl rand -hex 24)
  export TELEGRAM_SECRET_TOKEN
  _set_env "TELEGRAM_SECRET_TOKEN" "$TELEGRAM_SECRET_TOKEN"
  echo "  Generated TELEGRAM_SECRET_TOKEN"
fi

echo ""

# ── Summary ──────────────────────────────────────────────────────────────────

echo "Configuration written to apps/api/.env"
echo ""
echo "  Runtime:         $RUNTIME_TYPE"
echo "  Storage:         $STORAGE_PATH"
echo "  Workloads:       openclaw.workload.ts, tg-openclaw.trigger.ts"
echo "  Allowlist:       $ALLOWLIST_TENANT_IDS"
echo "  Telegram bot:    ${TELEGRAM_BOT_TOKEN:0:10}..."
echo "  Anthropic key:   ${ANTHROPIC_API_KEY:0:12}..."
echo ""

# ── Launch ───────────────────────────────────────────────────────────────────

read -rp "Start boilerhouse now? [Y/n] " start_choice
if [[ "${start_choice:-Y}" =~ ^[nN]$ ]]; then
  echo ""
  echo "To start later, run: bunx kadai run dev"
  echo ""
  echo "After the API is up, seed your Anthropic key for each tenant:"
  echo "  curl -X PUT http://localhost:3000/api/v1/tenants/TENANT_ID/secrets/ANTHROPIC_API_KEY \\"
  echo "    -H 'Content-Type: application/json' \\"
  echo "    -d '{\"value\":\"$ANTHROPIC_API_KEY\"}'"
  exit 0
fi

echo ""

# Start dev.sh (which handles runtime validation, dashboard + API startup)
exec bash "$SCRIPT_DIR/../dev.sh"
