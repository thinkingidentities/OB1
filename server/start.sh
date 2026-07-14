#!/usr/bin/env bash
# OB1 Open Brain MCP Server — start script
# Reads all secrets from Vault, never from .env files.
#
# Vault auth (TWC-3271): self-authenticate via a cognate-scoped AppRole login —
# a pure vault call, exactly like the rest of the TW service fleet. Do NOT rely
# on an ambient ~/.vault-token file: systemd never provisions it, so bare
# `vault kv get` returns 403 and the service crash-loops the moment its
# hand-started process is restarted or the box reboots. Seat is `code` because
# OB1 is Code-owned infrastructure (the code AppRole has read on kv/services/ob1/*).
set -euo pipefail

export TW_SERVICE_NAME="ob1"
export VAULT_ADDR="${VAULT_ADDR:-http://127.0.0.1:8200}"
export TW_VAULT_APPROLE_NAME="${TW_VAULT_APPROLE_NAME:-code}"

EP5_ROOT="${EP5_ROOT:-/home/jim00/ep5}"
# shellcheck source=/dev/null
source "${EP5_ROOT}/lib/tw-vault-bootstrap.sh"

tw_vault_wait
tw_vault_approle_login

# Read secrets from Vault (opaque — never echo values; gotcha-proof exports)
tw_vault_export SUPABASE_URL              "kv/services/ob1/supabase"   "SUPABASE_URL"
tw_vault_export SUPABASE_SERVICE_ROLE_KEY "kv/services/ob1/supabase"   "SUPABASE_SECRET_KEY"
tw_vault_export OPENROUTER_API_KEY        "kv/services/ob1/openrouter" "OPENROUTER_API_KEY"
tw_vault_export MCP_ACCESS_KEY            "kv/services/ob1/mcp"        "MCP_ACCESS_KEY"

# Per-cognate keys
tw_vault_export GLASSWORK_KEY "kv/services/ob1/mcp" "GLASSWORK_OB1_KEY"
tw_vault_export EMBER_KEY     "kv/services/ob1/mcp" "EMBER_OB1_KEY"
tw_vault_export GABE_KEY      "kv/services/ob1/mcp" "GABE_OB1_KEY"
tw_vault_export CODE_KEY      "kv/services/ob1/mcp" "CODE_OB1_KEY"
tw_vault_export CODEX_KEY     "kv/services/ob1/mcp" "CODEX_OB1_KEY"
tw_vault_export CURSOR_KEY    "kv/services/ob1/mcp" "CURSOR_OB1_KEY"
tw_vault_export HERMES_KEY    "kv/services/ob1/mcp" "HERMES_OB1_KEY"
tw_vault_export LINEAR_C_KEY  "kv/services/ob1/mcp" "LINEAR_C_OB1_KEY"

# Flat set for backwards-compat auth (server checks membership only).
export OB1_VALID_KEYS="${GLASSWORK_KEY},${EMBER_KEY},${GABE_KEY},${CODE_KEY},${CODEX_KEY},${CURSOR_KEY},${HERMES_KEY},${LINEAR_C_KEY}"

# Structured cognate→key map for server-side attribution stamping (captured_by).
# Server inverts this to a key→cognate lookup at startup so middleware can derive
# the authenticated cognate from the presented Bearer/x-brain-key.
#
# Keys that are valid (in OB1_VALID_KEYS) but absent from this map — e.g. the primary
# MCP_ACCESS_KEY or an automation caller — resolve at the server to seat="service"
# with mapped=false, and their captures carry seat_unmapped=true. That is failure-
# visible, never a blank/"unknown" stamp. To give an automation its own named seat
# (e.g. a dedicated a24-sync key), add it to OB1_VALID_KEYS above and register it in
# the jq object below.
export OB1_COGNATE_KEYS=$(jq -n \
  --arg glasswork "$GLASSWORK_KEY" \
  --arg ember "$EMBER_KEY" \
  --arg gabe "$GABE_KEY" \
  --arg code "$CODE_KEY" \
  --arg codex "$CODEX_KEY" \
  --arg cursor "$CURSOR_KEY" \
  --arg hermes "$HERMES_KEY" \
  --arg linear_c "$LINEAR_C_KEY" \
  '{glasswork:$glasswork, ember:$ember, gabe:$gabe, code:$code, codex:$codex, cursor:$cursor, hermes:$hermes, "linear-c":$linear_c}')

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DENO="$HOME/.deno/bin/deno"

export OB1_PORT="${OB1_PORT:-3037}"

tw_log "Starting OB1 MCP server on port $OB1_PORT..."
exec "$DENO" run \
  --allow-net \
  --allow-env \
  --allow-read \
  "$SCRIPT_DIR/tw-serve.ts"
