# TW-CLAUDE.md — TrustedWork Fork Instructions

This file supplements the upstream `CLAUDE.md` with TrustedWork-specific context.
When instructions conflict, this file takes precedence over `CLAUDE.md`.

## Fork Context

This is a TrustedWork fork of [NateBJones-Projects/OB1](https://github.com/NateBJones-Projects/OB1) (Open Brain).

- **Upstream:** `upstream/main` → `NateBJones-Projects/OB1`
- **Fork origin:** `origin` → `twdevjim/OB1`
- **Local clone:** `/home/jim00/ob1` (DGX)
- **Linear project:** OB1 — Open Brain Unified Memory
- **Parent epic:** TWC-1849

## Branch Model

```
main          ← Tracks upstream. No direct commits. Sync via: git fetch upstream && git merge upstream/main
tw/main       ← TW integration branch. All TW work merges here.
tw/<topic>    ← Feature branches for TW work. PR into tw/main.
contrib/*     ← Upstream contribution branches. Branch off main, PR to NateBJones.
```

### Rules

1. **`main` is read-only.** No direct commits. It exists solely to track upstream.
2. **`tw/main` is the TW working trunk.** All TW-specific work lands here via PR.
3. **Feature work** goes on `tw/<topic>` branches, PRed into `tw/main`.
4. **Upstream contributions** branch off `main` (not `tw/main`), keeping them clean of TW-specific changes.
5. **Upstream sync:** `git fetch upstream && git checkout main && git merge upstream/main && git push origin main`. Then rebase `tw/main` if needed.

### Branch Naming

```
tw/supabase-setup       ← TW feature work
tw/mcp-integration      ← TW feature work
tw/postgres-port        ← TW adaptation
contrib/twdevjim/...    ← Upstream contribution (follows NateBJones convention)
```

### Commit Messages

Follow upstream convention on `contrib/*` branches:
```
[category] description    ← e.g., [recipes] Add ThinkTeam memory seed
```

On `tw/*` branches, use TW convention:
```
feat: description [TWC-NNNN]
fix: description [TWC-NNNN]
chore: description [TWC-NNNN]
```

## Secrets Management

- **All secrets via Vault.** Path: `kv/services/ob1/`
- **No `.env` files committed.** Start scripts read Vault, export env, exec process.
- **Never echo secrets.** Same rules as EP5 — confirm via result, not value.
- **Supabase keys** (URL, SERVICE_ROLE_KEY, ANON_KEY) stored in Vault, not flat files.

## ThinkJob Governance

OB1 uses **lightweight governance** — no ThinkJob packets or External RAM threads required per branch. The Linear project and issue hierarchy provide sufficient traceability.

- Create a `tw/<topic>` branch for each piece of work
- Reference the TWC issue number in commits
- PR into `tw/main` with a clear description
- No worktree ceremony required (single-cognate repo for now)

If OB1 grows to multi-cognate writes, escalate to full ThinkJob governance.

## Relationship to EP5

OB1 is a **separate repo**, not a submodule or subdirectory of EP5.

| Need | Location |
|------|----------|
| OB1 source | `/home/jim00/ob1` |
| OB1 ports | Registered in EP5 `infrastructure/ports.yaml` |
| OB1 secrets | Vault `kv/services/ob1/` |
| OB1 systemd units | `~/.config/systemd/user/tw-ob1*.service` |
| OB1 Linear issues | TWC-1849 (parent) + sub-issues |

## Upstream Guard Rails (inherited)

From the upstream `CLAUDE.md` — these apply to ALL branches:

- **Never modify the core `thoughts` table structure** (adding columns OK, altering/dropping not).
- **No credentials in any file.** Environment variables only.
- **No binary blobs** over 1MB.
- **No destructive SQL** (`DROP TABLE`, `TRUNCATE`, unqualified `DELETE FROM`).

## Current Focus

Standing up vanilla OB1 on DGX:
1. TWC-1850: Supabase project + pgvector schema + Vault secrets
2. TWC-1851: Deno/Hono MCP server running as systemd unit
3. TWC-1852: MCP integration into Claude Code
4. TWC-1853: Seed ThinkTeam knowledge base

Later (TWC-1855): Port Supabase → bare Postgres, add trust metadata, upstream PRs.
