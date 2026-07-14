# TW-CLAUDE.md — TrustedWork Fork Instructions

This file supplements the upstream `CLAUDE.md` with TrustedWork-specific context.
When instructions conflict, this file takes precedence over `CLAUDE.md`.

## Fork Context

This is a TrustedWork fork of [NateBJones-Projects/OB1](https://github.com/NateBJones-Projects/OB1) (Open Brain).

- **Upstream:** `upstream/main` → `NateBJones-Projects/OB1`
- **Fork origin:** `origin` → `thinkingidentities/OB1`
- **Local clone:** `/home/jim00/ob1` (DGX)
- **Linear project:** OB1 — Open Brain Unified Memory
- **Parent epic:** TWC-1849

## Branch Model

```
main                       ← TW trunk on our fork. All TW work merges here via PR.
feat|fix|chore/twc-NNNN-*  ← Work branches, PRed into main. Named by ThinkJob.
contrib/*                  ← (rare) Upstream contribution branches, PR to NateBJones.
```

### Rules

1. **`main` is the TW trunk** on our fork `thinkingidentities/OB1`. All TW work lands here via PR — branch protection requires a PR (no direct push). Standard PR merges (see PRs #7–#10).
2. **Work branches** are `feat|fix|chore/twc-NNNN-description`, matching the driving ThinkJob, PRed into `main`.
3. **Upstream (`NateBJones-Projects/OB1`) is never modified by us.** We do not push to it. A future upstream contribution would use a `contrib/*` branch off a clean upstream sync and PR to NateBJones — not yet exercised.
4. **Upstream sync (if ever needed):** fetch upstream into a temp branch and merge deliberately; do NOT treat `main` as a read-only upstream mirror — it is our trunk and diverges from upstream.

> Historical note: an earlier version described a `main=upstream-read-only / tw/main=trunk` model. It was never adopted — all TW PRs merge to `main` on the fork. Corrected 2026-07-14 (TWC-3528).

### Branch Naming

```
feat/twc-NNNN-description    ← new capability
fix/twc-NNNN-description     ← bug fix
chore/twc-NNNN-description   ← ops, docs, cleanup
contrib/...                  ← (rare) upstream contribution (follows NateBJones convention)
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

- Create a `feat|fix|chore/twc-NNNN-description` branch for each piece of work
- Reference the TWC issue number in commits
- PR into `main` with a clear description
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

## Running Services (DGX)

### Supabase (local)
- **API:** http://127.0.0.1:54321
- **DB:** postgresql://postgres:postgres@127.0.0.1:54322/postgres
- **Studio:** http://127.0.0.1:54323
- **Schema:** `thoughts` table with pgvector (1536-dim), `match_thoughts` RPC
- **Init:** `cd ~/ob1 && supabase start`

### OB1 MCP Server
- **Port:** 3037
- **systemd:** `tw-ob1-mcp.service` (user) — restart via `systemctl --user restart tw-ob1-mcp.service`
- **Entrypoint:** `server/tw-serve.ts` (HTTP, TW wrapper, configurable port via OB1_PORT). Local stdio callers use `server/tw-serve-stdio.ts` (same tools; seat from `OB1_COGNATE` env). Keep the two files in sync.
- **Auth:** `x-brain-key` header (or `Bearer` / `?key=`), key from `kv/services/ob1/mcp`
- **Start:** `bash server/start.sh` (reads Vault, no .env)

### Vault Paths
- `kv/services/ob1/supabase` — SUPABASE_URL, SUPABASE_SECRET_KEY, SUPABASE_PUBLISHABLE_KEY
- `kv/services/ob1/openrouter` — OPENROUTER_API_KEY (embeddings via OpenRouter)
- `kv/services/ob1/mcp` — MCP_ACCESS_KEY

### MCP Tools
- `capture_thought` — Save a thought (auto-embeds + extracts metadata via OpenRouter). Optional `assert_seat` rejects the capture pre-write if the asserted seat ≠ the authenticated seat.
- `search_thoughts` — Semantic search by meaning (pgvector cosine similarity)
- `list_thoughts` — List recent thoughts with filters (type, topic, person, days)
- `thought_stats` — Summary statistics (counts, types, topics, people)
- `whoami` — Return the cognate seat this connection is authenticated as: `{seat, mapped}`. Call before capturing to verify attribution.

### Identity & Attribution (TWC-3519)

OB1 stamps every capture with the caller's seat and is honest about relays:

- **`captured_by`** — the authenticated seat. HTTP (`tw-serve.ts`) resolves it from the presented key via `cognateKeyMap` (built from `OB1_COGNATE_KEYS` in `start.sh`); stdio (`tw-serve-stdio.ts`) reads it from the `OB1_COGNATE` env var.
- **Never blank** — a valid-but-unmapped key, or unset `OB1_COGNATE`, resolves to `seat="service"` with `mapped=false`, and the capture carries `seat_unmapped=true`. No silent `"unknown"`.
- **Relay attribution** — `capture_thought` parses the leading `[Cognate …]` content preamble into `metadata.authored_by`. If it differs from `captured_by`, the row gets `relay=true` and `list`/`search` render `by X (relay for Y)`. So relaying another cognate's words is visible, not mis-stamped.
- **Recognized cognates** — derived from the key map plus the `OB1_KNOWN_COGNATES` env var (comma-separated), injected at deploy time. Not hardcoded in source.
- **`assert_seat`** — optional guard; see `capture_thought` above.

## Current Focus

Standing up vanilla OB1 on DGX:
1. ~~TWC-1850: Supabase project + pgvector schema + Vault secrets~~ DONE
2. ~~TWC-1851: Deno/Hono MCP server running as systemd unit~~ DONE
3. TWC-1852: MCP integration into Claude Code
4. TWC-1853: Seed ThinkTeam knowledge base

Later (TWC-1855): Port Supabase → bare Postgres, add trust metadata, upstream PRs.
