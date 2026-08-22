/**
 * OB1 Open Brain — stdio MCP transport for Claude Code.
 *
 * This is the local entrypoint: reads JSON-RPC from stdin, writes to stdout.
 * No HTTP server, no access key needed (process isolation is the auth boundary).
 * Credentials come from environment variables (sourced from Vault by wrapper script).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY");

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !OPENROUTER_API_KEY) {
  console.error("[ob1-stdio] Missing required env vars. Check Vault.");
  Deno.exit(1);
}

// Cognate identity — set by the MCP dispatcher from the per-clone .tw-cognate file.
// Process isolation is the auth boundary: each cognate's clone spawns its own stdio server
// process, so this env var cannot be spoofed from the client side. When OB1_COGNATE is
// unset we resolve to "service" (mapped=false) rather than "unknown" so no capture lands
// with blank/unknown provenance.
const RAW_COGNATE = Deno.env.get("OB1_COGNATE");
const OB1_COGNATE = (RAW_COGNATE || "service").toLowerCase();
const OB1_SEAT_MAPPED = Boolean(RAW_COGNATE) && OB1_COGNATE !== "unknown" && OB1_COGNATE !== "service";

// Extract the first [Bracket Tag] token from content as the subject preamble.
// Distinguishes "who wrote this" (server-stamped captured_by) from "what this is about"
// (client-authored subject_preamble). Cross-reference is expected in the meta-pair workflow.
function extractSubjectPreamble(content: string): string | null {
  const match = content.match(/^\s*\[([^\]]+)\]/);
  return match ? match[1].trim() : null;
}

// Cognate seats recognized for content-author reconciliation. Injected via
// OB1_KNOWN_COGNATES (comma-sep) at deploy time; the current seat is always
// included so self-authored content is recognized. Not hardcoded in source.
const KNOWN_COGNATES = new Set<string>(
  [OB1_COGNATE, ...(Deno.env.get("OB1_KNOWN_COGNATES") || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)],
);

// Parse a content-declared author from the leading [Cognate ...] preamble.
//   "[Code 🔧 Mac] ..." -> "code"     "[a24-fingerprint] ..." -> null (not a cognate)
// Lets capture_thought record who *wrote* content that may be *relayed* through a
// different seat (e.g. Code content pasted via Ember).
function extractAuthoredBy(content: string): string | null {
  const preamble = extractSubjectPreamble(content);
  if (!preamble) return null;
  const firstToken = preamble.split(/[\s/,|]/)[0]?.toLowerCase().trim();
  return firstToken && KNOWN_COGNATES.has(firstToken) ? firstToken : null;
}

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/text-embedding-3-small",
      input: text,
    }),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(`OpenRouter embeddings failed: ${r.status} ${msg}`);
  }
  const d = await r.json();
  return d.data[0].embedding;
}

const THOUGHT_TYPES = ["observation", "task", "idea", "reference", "person_note", "experiential_memory"];

function detectExplicitThoughtType(text: string): string | null {
  const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (normalized.includes("experiential_memory")) return "experiential_memory";
  return null;
}

function applyExplicitThoughtType(text: string, metadata: Record<string, unknown>): Record<string, unknown> {
  const explicitType = detectExplicitThoughtType(text);
  if (!explicitType) return metadata;
  return {
    ...metadata,
    type: explicitType,
  };
}

type EntityType = "person" | "seat" | "host" | "identifier" | "account";

const ENTITY_GUARD_VERSION = "tw-entity-type-guard-v1";
const PERSON_ALIASES = new Map([["jim", "Jim Meck"], ["jim meck", "Jim Meck"]]);
const SEAT_ALIASES = new Map([
  ["codex", "Codex"],
  ["codex trace", "Codex"],
  ["ember", "Ember"],
  ["hermes", "Hermes"],
  ["glasswork", "Glasswork"],
  ["code", "Code"],
  ["cursor", "Cursor"],
  ["linear-c", "Linear-C"],
]);
const ACCOUNT_ALIASES = new Map([["gabe", "gabe"], ["twdevgabe", "twdevgabe"]]);

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function canonicalKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textContainsAlias(text: string, alias: string): boolean {
  return new RegExp(`\\b${escapeRegExp(alias)}\\b`, "i").test(text);
}

function identifiersInText(text: string): string[] {
  return unique(text.match(/\b(?:[A-Z]{2,6}-)+(?:\d{1,6})\b/g) || []);
}

function hostsInText(text: string): string[] {
  return unique(text.match(/\b(?:dgx|mac)-[a-z]+-\d+\b/gi) || []).map((value) =>
    value.toLowerCase()
  );
}

function classifyEntityCandidate(
  rawValue: string,
  textIdentifiers: string[],
): { type: EntityType; value: string; reason: string } | null {
  const raw = rawValue.trim();
  if (!raw) return null;
  const key = canonicalKey(raw);
  const identifierPrefix = textIdentifiers.find((identifier) => identifier.startsWith(`${raw}-`));
  if (identifierPrefix && /^[A-Z]{2,6}$/.test(raw)) {
    return { type: "identifier", value: identifierPrefix, reason: "identifier_prefix" };
  }
  if (/^(?:[A-Z]{2,6}-)+(?:\d{1,6})$/.test(raw)) {
    return { type: "identifier", value: raw, reason: "identifier_pattern" };
  }
  if (/^(dgx|mac)-[a-z]+-\d+$/i.test(raw)) {
    return { type: "host", value: raw.toLowerCase(), reason: "host_pattern" };
  }
  const seat = SEAT_ALIASES.get(key);
  if (seat) return { type: "seat", value: seat, reason: "seat_alias" };
  const account = ACCOUNT_ALIASES.get(key);
  if (account) return { type: "account", value: account, reason: "account_alias" };
  const person = PERSON_ALIASES.get(key);
  if (person) return { type: "person", value: person, reason: "person_alias" };
  return { type: "person", value: raw, reason: "default_person" };
}

function normalizeExtractedEntities(text: string, metadata: Record<string, unknown>): Record<string, unknown> {
  const originalPeople = Array.isArray(metadata.people) ? (metadata.people as unknown[]).filter((value): value is string => typeof value === "string") : [];
  const textIdentifiers = identifiersInText(text);
  const textHosts = hostsInText(text);
  const entities: Record<EntityType, string[]> = {
    person: [],
    seat: [],
    host: [...textHosts],
    identifier: [...textIdentifiers],
    account: [],
  };
  const corrections: Array<{ raw: string; type: EntityType; value: string; reason: string }> = [];

  for (const [alias, value] of PERSON_ALIASES) {
    if (textContainsAlias(text, alias)) entities.person.push(value);
  }
  for (const [alias, value] of SEAT_ALIASES) {
    if (alias !== "code" && textContainsAlias(text, alias)) entities.seat.push(value);
  }
  for (const [alias, value] of ACCOUNT_ALIASES) {
    if (textContainsAlias(text, alias)) entities.account.push(value);
  }

  for (const raw of originalPeople) {
    const classified = classifyEntityCandidate(raw, textIdentifiers);
    if (!classified) continue;
    entities[classified.type].push(classified.value);
    if (classified.value !== raw || classified.type !== "person" || classified.reason !== "default_person") {
      corrections.push({ raw, ...classified });
    }
  }

  for (const key of Object.keys(entities) as EntityType[]) {
    entities[key] = unique(entities[key]);
  }

  return {
    ...metadata,
    people: entities.person,
    entities,
    entity_extraction: {
      version: ENTITY_GUARD_VERSION,
      original_people: originalPeople,
      corrections,
    },
  };
}

async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned (empty if none)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of ${THOUGHT_TYPES.map((type) => `"${type}"`).join(", ")}
Only extract what's explicitly there.`,
        },
        { role: "user", content: text },
      ],
    }),
  });
  const d = await r.json();
  try {
    return normalizeExtractedEntities(
      text,
      applyExplicitThoughtType(text, JSON.parse(d.choices[0].message.content)),
    );
  } catch {
    return normalizeExtractedEntities(
      text,
      applyExplicitThoughtType(text, { topics: ["uncategorized"], type: "observation" }),
    );
  }
}

// --- MCP Server ---

const server = new McpServer({
  name: "open-brain",
  version: "1.0.0",
});

server.registerTool(
  "search_thoughts",
  {
    title: "Search Thoughts",
    description:
      "Search captured thoughts by meaning. Use this when the user asks about a topic, person, or idea they've previously captured.",
    inputSchema: {
      query: z.string().describe("What to search for"),
      limit: z.number().optional().default(10),
      threshold: z.number().optional().default(0.5),
    },
  },
  async ({ query, limit, threshold }) => {
    try {
      const qEmb = await getEmbedding(query);
      const { data, error } = await supabase.rpc("match_thoughts", {
        query_embedding: qEmb,
        match_threshold: threshold,
        match_count: limit,
        filter: {},
      });
      if (error) {
        return { content: [{ type: "text" as const, text: `Search error: ${error.message}` }], isError: true };
      }
      if (!data || data.length === 0) {
        return { content: [{ type: "text" as const, text: `No thoughts found matching "${query}".` }] };
      }
      const results = data.map(
        (t: { content: string; metadata: Record<string, unknown>; similarity: number; created_at: string }, i: number) => {
          const m = t.metadata || {};
          const relay = m.authored_by && m.authored_by !== m.captured_by ? ` (relay for ${m.authored_by})` : "";
          const parts = [
            `--- Result ${i + 1} (${(t.similarity * 100).toFixed(1)}% match) ---`,
            `Captured: ${new Date(t.created_at).toLocaleDateString()}`,
            `By: ${m.captured_by || "unknown"}${relay}`,
            `Type: ${m.type || "unknown"}`,
          ];
          if (Array.isArray(m.topics) && m.topics.length) parts.push(`Topics: ${(m.topics as string[]).join(", ")}`);
          if (Array.isArray(m.people) && m.people.length) parts.push(`People: ${(m.people as string[]).join(", ")}`);
          if (Array.isArray(m.action_items) && m.action_items.length) parts.push(`Actions: ${(m.action_items as string[]).join("; ")}`);
          parts.push(`\n${t.content}`);
          return parts.join("\n");
        }
      );
      return { content: [{ type: "text" as const, text: `Found ${data.length} thought(s):\n\n${results.join("\n\n")}` }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.registerTool(
  "list_thoughts",
  {
    title: "List Recent Thoughts",
    description: "List recently captured thoughts with optional filters by type, topic, person, or time range.",
    inputSchema: {
      limit: z.number().optional().default(10),
      type: z.string().optional().describe(`Filter by type: ${THOUGHT_TYPES.join(", ")}`),
      topic: z.string().optional().describe("Filter by topic tag"),
      person: z.string().optional().describe("Filter by person mentioned"),
      seat: z.string().optional().describe("Filter by seat entity"),
      host: z.string().optional().describe("Filter by host entity"),
      identifier: z.string().optional().describe("Filter by identifier entity"),
      account: z.string().optional().describe("Filter by account entity"),
      days: z.number().optional().describe("Only thoughts from the last N days"),
    },
  },
  async ({ limit, type, topic, person, seat, host, identifier, account, days }) => {
    try {
      // Fetch 3x requested limit to allow for dedup without shortchanging the result.
      // Same content posted under different metadata type/topic categorizations
      // creates duplicate rows; we collapse them to the most recent instance.
      const fetchLimit = Math.max(limit * 3, 30);
      let q = supabase.from("thoughts").select("content, metadata, created_at").order("created_at", { ascending: false }).limit(fetchLimit);
      if (type) q = q.contains("metadata", { type });
      if (topic) q = q.contains("metadata", { topics: [topic] });
      if (person) q = q.contains("metadata", { people: [person] });
      if (seat) q = q.contains("metadata", { entities: { seat: [seat] } });
      if (host) q = q.contains("metadata", { entities: { host: [host] } });
      if (identifier) q = q.contains("metadata", { entities: { identifier: [identifier] } });
      if (account) q = q.contains("metadata", { entities: { account: [account] } });
      if (days) {
        const since = new Date();
        since.setDate(since.getDate() - days);
        q = q.gte("created_at", since.toISOString());
      }
      const { data, error } = await q;
      if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }], isError: true };
      if (!data || !data.length) return { content: [{ type: "text" as const, text: "No thoughts found." }] };

      // Dedup by content — keep the most recent occurrence (first, since order DESC).
      // Normalize whitespace so near-identical content collapses too.
      const seen = new Set<string>();
      const deduped: typeof data = [];
      for (const t of data) {
        const key = t.content.replace(/\s+/g, " ").trim();
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(t);
        if (deduped.length >= limit) break;
      }

      const results = deduped.map(
        (t: { content: string; metadata: Record<string, unknown>; created_at: string }, i: number) => {
          const m = t.metadata || {};
          const tags = Array.isArray(m.topics) ? (m.topics as string[]).join(", ") : "";
          const relay = m.authored_by && m.authored_by !== m.captured_by ? ` (relay for ${m.authored_by})` : "";
          const by = m.captured_by ? ` by ${m.captured_by}${relay}` : "";
          return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}${by}] (${m.type || "??"}${tags ? " - " + tags : ""})\n   ${t.content}`;
        }
      );
      const dupNote = data.length > deduped.length ? ` (${data.length - deduped.length} duplicate row(s) collapsed)` : "";
      return { content: [{ type: "text" as const, text: `${deduped.length} recent thought(s)${dupNote}:\n\n${results.join("\n\n")}` }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.registerTool(
  "thought_stats",
  {
    title: "Thought Statistics",
    description: "Get a summary of all captured thoughts: totals, types, top topics, and people.",
    inputSchema: {},
  },
  async () => {
    try {
      const { count } = await supabase.from("thoughts").select("*", { count: "exact", head: true });
      const { data } = await supabase.from("thoughts").select("metadata, created_at").order("created_at", { ascending: false });
      const types: Record<string, number> = {};
      const topics: Record<string, number> = {};
      const people: Record<string, number> = {};
      const entityCounts: Record<string, Record<string, number>> = {
        seat: {},
        host: {},
        identifier: {},
        account: {},
      };
      for (const r of data || []) {
        const m = (r.metadata || {}) as Record<string, unknown>;
        if (m.type) types[m.type as string] = (types[m.type as string] || 0) + 1;
        if (Array.isArray(m.topics)) for (const t of m.topics) topics[t as string] = (topics[t as string] || 0) + 1;
        if (Array.isArray(m.people)) for (const p of m.people) people[p as string] = (people[p as string] || 0) + 1;
        const entities = m.entities as Record<string, unknown> | undefined;
        for (const kind of Object.keys(entityCounts)) {
          const values = entities?.[kind];
          if (Array.isArray(values)) {
            for (const value of values) entityCounts[kind][value as string] = (entityCounts[kind][value as string] || 0) + 1;
          }
        }
      }
      const sort = (o: Record<string, number>): [string, number][] => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 10);
      const lines: string[] = [
        `Total thoughts: ${count}`,
        `Date range: ${data?.length ? new Date(data[data.length - 1].created_at).toLocaleDateString() + " → " + new Date(data[0].created_at).toLocaleDateString() : "N/A"}`,
        "", "Types:", ...sort(types).map(([k, v]) => `  ${k}: ${v}`),
      ];
      if (Object.keys(topics).length) { lines.push("", "Top topics:"); for (const [k, v] of sort(topics)) lines.push(`  ${k}: ${v}`); }
      if (Object.keys(people).length) { lines.push("", "People mentioned:"); for (const [k, v] of sort(people)) lines.push(`  ${k}: ${v}`); }
      for (const [kind, counts] of Object.entries(entityCounts)) {
        if (!Object.keys(counts).length) continue;
        lines.push("", `${kind[0].toUpperCase()}${kind.slice(1)} entities:`);
        for (const [k, v] of sort(counts)) lines.push(`  ${k}: ${v}`);
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.registerTool(
  "capture_thought",
  {
    title: "Capture Thought",
    description: "Save a new thought to the Open Brain. Generates an embedding and extracts metadata automatically.",
    inputSchema: {
      content: z.string().describe("The thought to capture — a clear, standalone statement that will make sense when retrieved later by any AI"),
      assert_seat: z
        .string()
        .optional()
        .describe("Optional. If set, the capture is rejected unless it matches the seat this process is authenticated as. Call whoami first if unsure."),
    },
  },
  async ({ content, assert_seat }) => {
    try {
      // T4 — capture-time seat assertion. Fail loudly rather than mis-stamp.
      if (assert_seat && assert_seat.toLowerCase().trim() !== OB1_COGNATE.toLowerCase()) {
        return {
          content: [{ type: "text" as const, text: `Seat assertion failed: you asserted "${assert_seat}" but this process is authenticated as "${OB1_COGNATE}". Capture rejected — nothing was written.` }],
          isError: true,
        };
      }
      const [embedding, metadata] = await Promise.all([getEmbedding(content), extractMetadata(content)]);
      const subjectPreamble = extractSubjectPreamble(content);
      // Reconcile transport seat (captured_by) with content-declared author; diverging = relay.
      const authoredBy = extractAuthoredBy(content);
      const isRelay = Boolean(authoredBy && authoredBy !== OB1_COGNATE);
      const { error } = await supabase.from("thoughts").insert({
        content,
        embedding,
        metadata: {
          ...metadata,
          source: "mcp",
          captured_by: OB1_COGNATE,
          ...(OB1_SEAT_MAPPED ? {} : { seat_unmapped: true }),
          ...(subjectPreamble ? { subject_preamble: subjectPreamble } : {}),
          ...(authoredBy ? { authored_by: authoredBy } : {}),
          ...(isRelay ? { relay: true } : {}),
        },
      });
      if (error) return { content: [{ type: "text" as const, text: `Failed to capture: ${error.message}` }], isError: true };
      const meta = metadata as Record<string, unknown>;
      let confirmation = `Captured as ${meta.type || "thought"} for ${OB1_COGNATE}`;
      if (isRelay) confirmation += ` (relay for ${authoredBy})`;
      if (!OB1_SEAT_MAPPED) confirmation += ` [seat unmapped — set OB1_COGNATE]`;
      if (Array.isArray(meta.topics) && meta.topics.length) confirmation += ` — ${(meta.topics as string[]).join(", ")}`;
      if (Array.isArray(meta.people) && meta.people.length) confirmation += ` | People: ${(meta.people as string[]).join(", ")}`;
      if (Array.isArray(meta.action_items) && meta.action_items.length) confirmation += ` | Actions: ${(meta.action_items as string[]).join("; ")}`;
      return { content: [{ type: "text" as const, text: confirmation }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.registerTool(
  "whoami",
  {
    title: "Who Am I",
    description: "Return the cognate seat this OB1 connection is authenticated as. Call before capture_thought to verify your attribution — captures are stamped with this seat.",
    inputSchema: {},
  },
  // deno-lint-ignore require-await
  async () => {
    const note = OB1_SEAT_MAPPED
      ? `Authenticated as "${OB1_COGNATE}". Captures will be stamped captured_by=${OB1_COGNATE}.`
      : `OB1_COGNATE is not set to a named cognate (seat="${OB1_COGNATE}", mapped=false). Captures will be stamped captured_by=${OB1_COGNATE} with seat_unmapped=true. Set OB1_COGNATE in the launch wrapper to attribute this process to a named seat.`;
    return {
      content: [{ type: "text" as const, text: `${JSON.stringify({ seat: OB1_COGNATE, mapped: OB1_SEAT_MAPPED }, null, 2)}\n\n${note}` }],
    };
  }
);

// --- Connect stdio transport ---
const transport = new StdioServerTransport();
await server.connect(transport);
