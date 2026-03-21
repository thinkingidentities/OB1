#!/usr/bin/env bash
# OB1 Open Brain MCP Server — start script
# Reads all secrets from Vault, never from .env files.
set -euo pipefail

VAULT_ADDR="${VAULT_ADDR:-http://127.0.0.1:8200}"
export VAULT_ADDR

# Read secrets from Vault (opaque — never echo values)
export SUPABASE_URL="$(vault kv get -field=SUPABASE_URL kv/services/ob1/supabase)"
export SUPABASE_SERVICE_ROLE_KEY="$(vault kv get -field=SUPABASE_SECRET_KEY kv/services/ob1/supabase)"
export OPENROUTER_API_KEY="$(vault kv get -field=OPENROUTER_API_KEY kv/services/ob1/openrouter)"
export MCP_ACCESS_KEY="$(vault kv get -field=MCP_ACCESS_KEY kv/services/ob1/mcp)"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DENO="$HOME/.deno/bin/deno"

export OB1_PORT="${OB1_PORT:-3037}"

echo "[ob1] Starting OB1 MCP server on port $OB1_PORT..."
exec "$DENO" run \
  --allow-net \
  --allow-env \
  --allow-read \
  "$SCRIPT_DIR/tw-serve.ts"
