#!/usr/bin/env bash
# TWC-5816 fixture: run server/start.sh with Vault and Deno stubbed, then check
# the key sets it hands the server. The inversion below mirrors tw-serve.ts
# cognateKeyMap and resolveSeat: key -> cognate, empty keys dropped, an
# unmapped valid key resolves to "service".
# Run: bash server/test-start-keys.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fail=0

run_start() {  # run_start WITH_CJW(0|1) -> prints the captured env as JSON
  local tmp; tmp="$(mktemp -d)"
  mkdir -p "$tmp/lib" "$tmp/home/.deno/bin"
  cat > "$tmp/lib/tw-vault-bootstrap.sh" <<EOF
tw_log() { :; }
tw_vault_wait() { :; }
tw_vault_approle_login() { :; }
_fixture() {
  case "\$1|\$2" in
    "kv/services/ob1/seats/claude-jim-web|api_key") if [ "$1" = 1 ]; then printf key-cjw; fi ;;
    kv/services/ob1/mcp\|*_OB1_KEY) printf 'key-%s' "\$(printf %s "\$2" | sed 's/_OB1_KEY//' | tr 'A-Z_' 'a-z-')" ;;
    *) printf 'v-%s' "\$2" ;;
  esac
}
tw_vault_export() { local v; v="\$(_fixture "\$2" "\$3")"; [ -n "\$v" ] || exit 1; printf -v "\$1" '%s' "\$v"; export "\$1"; }
tw_vault_export_optional() { local v; v="\$(_fixture "\$2" "\$3")"; [ -n "\$v" ] || v="\$4"; printf -v "\$1" '%s' "\$v"; export "\$1"; }
EOF
  cat > "$tmp/home/.deno/bin/deno" <<'EOF'
#!/usr/bin/env bash
python3 -c 'import json,os;print(json.dumps({"valid":os.environ["OB1_VALID_KEYS"],"map":json.loads(os.environ["OB1_COGNATE_KEYS"]),"primary":os.environ["MCP_ACCESS_KEY"]}))'
EOF
  chmod +x "$tmp/home/.deno/bin/deno"
  EP5_ROOT="$tmp" HOME="$tmp/home" bash "$here/start.sh"
  rm -rf "$tmp"
}

check() {  # check NAME WITH_CJW
  local out; out="$(run_start "$2")"
  python3 - "$1" "$2" "$out" <<'EOF' || fail=1
import json, sys
name, with_cjw, out = sys.argv[1], sys.argv[2] == "1", json.loads(sys.argv[3])
valid = {k.strip() for k in [out["primary"], *out["valid"].split(",")] if k.strip()}
inv = {k.strip(): c for c, k in out["map"].items() if k and k.strip()}
seat = lambda key: inv.get(key, "service")
existing = {"glasswork": "key-glasswork", "ember": "key-ember", "gabe": "key-gabe", "code": "key-code",
            "codex": "key-codex", "cursor": "key-cursor", "hermes": "key-hermes", "linear-c": "key-linear-c"}
errs = [f"{c}: {seat(k)}" for c, k in existing.items() if seat(k) != c or k not in valid]
if with_cjw:
    if "key-cjw" not in valid: errs.append("claude-jim-web key not accepted")
    if seat("key-cjw") != "claude-jim-web": errs.append(f"claude-jim-web resolves to {seat('key-cjw')}")
else:
    if "" in out["map"].values() and "" in valid: errs.append("empty key accepted")
    if "claude-jim-web" in inv.values(): errs.append("claude-jim-web mapped with no key")
if seat(out["primary"]) != "service": errs.append("primary key no longer resolves to service")
print(("FAIL " if errs else "PASS ") + name + ("" if not errs else ": " + "; ".join(errs)))
sys.exit(1 if errs else 0)
EOF
}

check "claude-jim-web key present" 1
check "claude-jim-web key absent (compatible)" 0
exit "$fail"
