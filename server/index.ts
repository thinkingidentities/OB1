import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;

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

// --- MCP Server Setup ---

const server = new McpServer({
  name: "open-brain",
  version: "1.0.0",
});

// Tool 1: Semantic Search
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
        return {
          content: [{ type: "text" as const, text: `Search error: ${error.message}` }],
          isError: true,
        };
      }

      if (!data || data.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No thoughts found matching "${query}".` }],
        };
      }

      const results = data.map(
        (
          t: {
            content: string;
            metadata: Record<string, unknown>;
            similarity: number;
            created_at: string;
          },
          i: number
        ) => {
          const m = t.metadata || {};
          const parts = [
            `--- Result ${i + 1} (${(t.similarity * 100).toFixed(1)}% match) ---`,
            `Captured: ${new Date(t.created_at).toLocaleDateString()}`,
            `Type: ${m.type || "unknown"}`,
          ];
          if (Array.isArray(m.topics) && m.topics.length)
            parts.push(`Topics: ${(m.topics as string[]).join(", ")}`);
          if (Array.isArray(m.people) && m.people.length)
            parts.push(`People: ${(m.people as string[]).join(", ")}`);
          if (Array.isArray(m.action_items) && m.action_items.length)
            parts.push(`Actions: ${(m.action_items as string[]).join("; ")}`);
          parts.push(`\n${t.content}`);
          return parts.join("\n");
        }
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${data.length} thought(s):\n\n${results.join("\n\n")}`,
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 2: List Recent
server.registerTool(
  "list_thoughts",
  {
    title: "List Recent Thoughts",
    description:
      "List recently captured thoughts with optional filters by type, topic, person, or time range.",
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
      let q = supabase
        .from("thoughts")
        .select("content, metadata, created_at")
        .order("created_at", { ascending: false })
        .limit(limit);

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

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      }

      if (!data || !data.length) {
        return { content: [{ type: "text" as const, text: "No thoughts found." }] };
      }

      const results = data.map(
        (
          t: { content: string; metadata: Record<string, unknown>; created_at: string },
          i: number
        ) => {
          const m = t.metadata || {};
          const tags = Array.isArray(m.topics) ? (m.topics as string[]).join(", ") : "";
          return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] (${m.type || "??"}${tags ? " - " + tags : ""})\n   ${t.content}`;
        }
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `${data.length} recent thought(s):\n\n${results.join("\n\n")}`,
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 3: Stats
server.registerTool(
  "thought_stats",
  {
    title: "Thought Statistics",
    description: "Get a summary of all captured thoughts: totals, types, top topics, and people.",
    inputSchema: {},
  },
  async () => {
    try {
      const { count } = await supabase
        .from("thoughts")
        .select("*", { count: "exact", head: true });

      const { data } = await supabase
        .from("thoughts")
        .select("metadata, created_at")
        .order("created_at", { ascending: false });

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
        if (Array.isArray(m.topics))
          for (const t of m.topics) topics[t as string] = (topics[t as string] || 0) + 1;
        if (Array.isArray(m.people))
          for (const p of m.people) people[p as string] = (people[p as string] || 0) + 1;
        const entities = m.entities as Record<string, unknown> | undefined;
        for (const kind of Object.keys(entityCounts)) {
          const values = entities?.[kind];
          if (Array.isArray(values)) {
            for (const value of values) {
              entityCounts[kind][value as string] = (entityCounts[kind][value as string] || 0) + 1;
            }
          }
        }
      }

      const sort = (o: Record<string, number>): [string, number][] =>
        Object.entries(o)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10);

      const lines: string[] = [
        `Total thoughts: ${count}`,
        `Date range: ${
          data?.length
            ? new Date(data[data.length - 1].created_at).toLocaleDateString() +
              " → " +
              new Date(data[0].created_at).toLocaleDateString()
            : "N/A"
        }`,
        "",
        "Types:",
        ...sort(types).map(([k, v]) => `  ${k}: ${v}`),
      ];

      if (Object.keys(topics).length) {
        lines.push("", "Top topics:");
        for (const [k, v] of sort(topics)) lines.push(`  ${k}: ${v}`);
      }

      if (Object.keys(people).length) {
        lines.push("", "People mentioned:");
        for (const [k, v] of sort(people)) lines.push(`  ${k}: ${v}`);
      }
      for (const [kind, counts] of Object.entries(entityCounts)) {
        if (!Object.keys(counts).length) continue;
        lines.push("", `${kind[0].toUpperCase()}${kind.slice(1)} entities:`);
        for (const [k, v] of sort(counts)) lines.push(`  ${k}: ${v}`);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 4: Capture Thought
server.registerTool(
  "capture_thought",
  {
    title: "Capture Thought",
    description:
      "Save a new thought to the Open Brain. Generates an embedding and extracts metadata automatically. Use this when the user wants to save something to their brain directly from any AI client — notes, insights, decisions, or migrated content from other systems.",
    inputSchema: {
      content: z.string().describe("The thought to capture — a clear, standalone statement that will make sense when retrieved later by any AI"),
    },
  },
  async ({ content }) => {
    try {
      const [embedding, metadata] = await Promise.all([
        getEmbedding(content),
        extractMetadata(content),
      ]);

      const { error } = await supabase.from("thoughts").insert({
        content,
        embedding,
        metadata: { ...metadata, source: "mcp" },
      });

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to capture: ${error.message}` }],
          isError: true,
        };
      }

      const meta = metadata as Record<string, unknown>;
      let confirmation = `Captured as ${meta.type || "thought"}`;
      if (Array.isArray(meta.topics) && meta.topics.length)
        confirmation += ` — ${(meta.topics as string[]).join(", ")}`;
      if (Array.isArray(meta.people) && meta.people.length)
        confirmation += ` | People: ${(meta.people as string[]).join(", ")}`;
      if (Array.isArray(meta.action_items) && meta.action_items.length)
        confirmation += ` | Actions: ${(meta.action_items as string[]).join("; ")}`;

      return {
        content: [{ type: "text" as const, text: confirmation }],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// --- Hono App with Auth Check ---

const app = new Hono();

app.all("*", async (c) => {
  // Accept access key via header OR URL query parameter
  const provided = c.req.header("x-brain-key") || new URL(c.req.url).searchParams.get("key");
  if (!provided || provided !== MCP_ACCESS_KEY) {
    return c.json({ error: "Invalid or missing access key" }, 401);
  }

  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

Deno.serve(app.fetch);
