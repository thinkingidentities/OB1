// TW entrypoint — wraps upstream index.ts with configurable port
// This avoids modifying upstream code for TW-specific deployment.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { AsyncLocalStorage } from "node:async_hooks";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
// Accept multiple keys: primary + per-cognate keys (comma-separated in OB1_VALID_KEYS)
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY") || "";
const OB1_VALID_KEYS = new Set(
  [MCP_ACCESS_KEY, ...(Deno.env.get("OB1_VALID_KEYS") || "").split(",")]
    .map(k => k.trim())
    .filter(Boolean)
);

// Build key→cognate reverse map from OB1_COGNATE_KEYS JSON env var.
// start.sh constructs this as {"glasswork":"<key>","ember":"<key>",...}. We invert it here
// so the middleware can derive the authenticated cognate from the presented key.
const cognateKeyMap: Map<string, string> = (() => {
  const raw = Deno.env.get("OB1_COGNATE_KEYS") || "{}";
  const map = new Map<string, string>();
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    for (const [cognate, key] of Object.entries(parsed)) {
      const trimmed = key?.trim();
      if (trimmed) map.set(trimmed, cognate);
    }
  } catch (err) {
    console.error("[ob1] Failed to parse OB1_COGNATE_KEYS:", (err as Error).message);
  }
  return map;
})();

// AsyncLocalStorage threads the authenticated cognate from the Hono middleware
// to the MCP tool handlers. MCP handlers don't receive Hono context, so we can't
// use c.set/c.get — AsyncLocalStorage is the standard Deno/Node mechanism for
// request-scoped identity propagation across async boundaries.
// Request-scoped seat identity. `seat` is the resolved cognate name (or "service"
// for a valid-but-unmapped key — never "unknown"); `mapped` says whether the key
// resolved to a named cognate in OB1_COGNATE_KEYS.
interface SeatInfo {
  seat: string;
  mapped: boolean;
}
const cognateStore = new AsyncLocalStorage<SeatInfo>();

// Resolve the seat for a presented key. A valid key that isn't in the cognate map
// (e.g. the primary MCP_ACCESS_KEY or an automation/service key) resolves to
// "service" with mapped=false — failure-visible, but never a blank/"unknown" stamp.
function resolveSeat(providedKey: string): SeatInfo {
  const mapped = cognateKeyMap.get(providedKey);
  return { seat: mapped || "service", mapped: Boolean(mapped) };
}

// Extract the first [Bracket Tag] token from content as the subject preamble.
// Distinguishes "who wrote this" (server-stamped captured_by) from "what this is about"
// (client-authored subject_preamble). Cross-reference is expected in the meta-pair workflow.
function extractSubjectPreamble(content: string): string | null {
  const match = content.match(/^\s*\[([^\]]+)\]/);
  return match ? match[1].trim() : null;
}

// Cognate seats recognized for content-author reconciliation. Derived from the
// registered key map (never hardcoded); additional non-keyed seats — carbon Jim,
// or cognates without an OB1 key — can be injected via OB1_KNOWN_COGNATES (comma-sep).
const KNOWN_COGNATES = new Set<string>([
  ...cognateKeyMap.values(),
  ...(Deno.env.get("OB1_KNOWN_COGNATES") || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
]);

// Parse a content-declared author from the leading [Cognate ...] preamble.
//   "[Code 🔧 Mac] ..." -> "code"     "[a24-fingerprint] ..." -> null (not a cognate)
// Returns the canonical cognate name when the first token of the first bracket tag
// names a known cognate. Lets capture_thought record who *wrote* content that may be
// *relayed* through a different seat's key (e.g. Code content pasted via Ember).
function extractAuthoredBy(content: string): string | null {
  const preamble = extractSubjectPreamble(content);
  if (!preamble) return null;
  const firstToken = preamble.split(/[\s/,|]/)[0]?.toLowerCase().trim();
  return firstToken && KNOWN_COGNATES.has(firstToken) ? firstToken : null;
}

const PORT = parseInt(Deno.env.get("OB1_PORT") || "3037");

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
- "type": one of "observation", "task", "idea", "reference", "person_note"
Only extract what's explicitly there.`,
        },
        { role: "user", content: text },
      ],
    }),
  });
  const d = await r.json();
  try {
    return JSON.parse(d.choices[0].message.content);
  } catch {
    return { topics: ["uncategorized"], type: "observation" };
  }
}

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
          const relay = m.authored_by && m.authored_by !== m.captured_by ? ` (relay for ${m.authored_by})` : "";
          const parts = [
            `--- Result ${i + 1} (${(t.similarity * 100).toFixed(1)}% match) ---`,
            `Captured: ${new Date(t.created_at).toLocaleDateString()}`,
            `By: ${m.captured_by || "unknown"}${relay}`,
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

server.registerTool(
  "list_thoughts",
  {
    title: "List Recent Thoughts",
    description:
      "List recently captured thoughts with optional filters by type, topic, person, or time range.",
    inputSchema: {
      limit: z.number().optional().default(10),
      type: z.string().optional().describe("Filter by type: observation, task, idea, reference, person_note"),
      topic: z.string().optional().describe("Filter by topic tag"),
      person: z.string().optional().describe("Filter by person mentioned"),
      days: z.number().optional().describe("Only thoughts from the last N days"),
    },
  },
  async ({ limit, type, topic, person, days }) => {
    try {
      let q = supabase
        .from("thoughts")
        .select("content, metadata, created_at")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (type) q = q.contains("metadata", { type });
      if (topic) q = q.contains("metadata", { topics: [topic] });
      if (person) q = q.contains("metadata", { people: [person] });
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
          const relay = m.authored_by && m.authored_by !== m.captured_by ? ` (relay for ${m.authored_by})` : "";
          const by = m.captured_by ? ` by ${m.captured_by}${relay}` : "";
          return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}${by}] (${m.type || "??"}${tags ? " - " + tags : ""})\n   ${t.content}`;
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

      for (const r of data || []) {
        const m = (r.metadata || {}) as Record<string, unknown>;
        if (m.type) types[m.type as string] = (types[m.type as string] || 0) + 1;
        if (Array.isArray(m.topics))
          for (const t of m.topics) topics[t as string] = (topics[t as string] || 0) + 1;
        if (Array.isArray(m.people))
          for (const p of m.people) people[p as string] = (people[p as string] || 0) + 1;
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

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

server.registerTool(
  "capture_thought",
  {
    title: "Capture Thought",
    description:
      "Save a new thought to the Open Brain. Generates an embedding and extracts metadata automatically.",
    inputSchema: {
      content: z.string().describe("The thought to capture"),
      assert_seat: z
        .string()
        .optional()
        .describe(
          "Optional. If set, the capture is rejected unless it matches the seat this connection is authenticated as. Guards against mis-attributed captures — call whoami first if unsure."
        ),
    },
  },
  async ({ content, assert_seat }) => {
    try {
      const seatInfo = cognateStore.getStore();
      const capturedBy = seatInfo?.seat || "unknown";
      const seatMapped = seatInfo?.mapped ?? false;

      // T4 — capture-time seat assertion. Fail loudly rather than mis-stamp.
      if (assert_seat && assert_seat.toLowerCase().trim() !== capturedBy.toLowerCase()) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Seat assertion failed: you asserted "${assert_seat}" but this connection is authenticated as "${capturedBy}". Capture rejected — nothing was written.`,
            },
          ],
          isError: true,
        };
      }

      const [embedding, metadata] = await Promise.all([
        getEmbedding(content),
        extractMetadata(content),
      ]);

      const subjectPreamble = extractSubjectPreamble(content);
      // Reconcile the transport seat (captured_by) with the content-declared author.
      // When they diverge, this is a relay (e.g. Code content pushed through Ember's key).
      const authoredBy = extractAuthoredBy(content);
      const isRelay = Boolean(authoredBy && authoredBy !== capturedBy);

      const { error } = await supabase.from("thoughts").insert({
        content,
        embedding,
        metadata: {
          ...metadata,
          source: "mcp",
          captured_by: capturedBy,
          ...(seatMapped ? {} : { seat_unmapped: true }),
          ...(subjectPreamble ? { subject_preamble: subjectPreamble } : {}),
          ...(authoredBy ? { authored_by: authoredBy } : {}),
          ...(isRelay ? { relay: true } : {}),
        },
      });

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to capture: ${error.message}` }],
          isError: true,
        };
      }

      const meta = metadata as Record<string, unknown>;
      let confirmation = `Captured as ${meta.type || "thought"} for ${capturedBy}`;
      if (isRelay) confirmation += ` (relay for ${authoredBy})`;
      if (!seatMapped) confirmation += ` [seat unmapped — register this key in OB1_COGNATE_KEYS]`;
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

server.registerTool(
  "whoami",
  {
    title: "Who Am I",
    description:
      "Return the cognate seat this OB1 connection is authenticated as. Call before capture_thought to verify your attribution — captures are stamped with this seat.",
    inputSchema: {},
  },
  // deno-lint-ignore require-await
  async () => {
    const info = cognateStore.getStore();
    const seat = info?.seat || "unknown";
    const mapped = info?.mapped ?? false;
    const note = mapped
      ? `Authenticated as "${seat}". Captures will be stamped captured_by=${seat}.`
      : `Key is valid but not mapped to a named cognate (seat="${seat}", mapped=false). Captures will be stamped captured_by=${seat} with seat_unmapped=true. Register this key in OB1_COGNATE_KEYS to attribute it to a named seat.`;
    return {
      content: [
        { type: "text" as const, text: `${JSON.stringify({ seat, mapped }, null, 2)}\n\n${note}` },
      ],
    };
  }
);

const app = new Hono();

app.get("/api/whoami", (c) => {
  const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
  const provided = c.req.header("x-brain-key") || bearer || new URL(c.req.url).searchParams.get("key");
  if (!provided || !OB1_VALID_KEYS.has(provided)) {
    return c.json({ error: "Invalid or missing access key", authenticated: false }, 401);
  }
  const { seat, mapped } = resolveSeat(provided);
  return c.json({ authenticated: true, cognate: seat, mapped });
});

app.all("*", async (c) => {
  const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
  const provided = c.req.header("x-brain-key") || bearer || new URL(c.req.url).searchParams.get("key");
  if (!provided || !OB1_VALID_KEYS.has(provided)) {
    return c.json({ error: "Invalid or missing access key" }, 401);
  }

  // Resolve cognate from the presented key. Legitimate keys not in the cognate map
  // (e.g. MCP_ACCESS_KEY primary, or automation/service keys) resolve to seat="service"
  // with mapped=false — never a blank/"unknown" stamp. This is failure-visible: the
  // stamped thought carries seat_unmapped=true so which keys need mapping is queryable,
  // without rejecting the capture.
  const seatInfo = resolveSeat(provided);

  // Detect whether client supports SSE (Streamable HTTP).
  // Some MCP clients may not send Accept: text/event-stream (the MCP spec
  // requires it, but @hono/mcp's enforcement is stricter than some clients
  // in practice). Fall back to JSON response mode for those clients so tools
  // still work. This is defensive — currently Code, Glasswork, Code-Mac, and
  // claude.ai (both web and iOS) all send text/event-stream correctly.
  const acceptHeader = c.req.header("Accept") || "";
  const clientAcceptsSSE = acceptHeader.includes("text/event-stream");

  const transport = new StreamableHTTPTransport({
    enableJsonResponse: !clientAcceptsSSE,
  });

  if (!clientAcceptsSSE) {
    // Override Accept header so the transport's strict check doesn't 406.
    // The transport will return plain JSON instead of SSE when enableJsonResponse is true.
    const origHeader = c.req.header.bind(c.req);
    (c.req.header as Function) = (name?: string) => {
      if (typeof name === "string" && name.toLowerCase() === "accept") {
        return "application/json, text/event-stream";
      }
      return origHeader(name);
    };
  }

  // Propagate cognate identity through to MCP tool handlers via AsyncLocalStorage.
  // capture_thought reads cognateStore.getStore() to stamp metadata.captured_by.
  return await cognateStore.run(seatInfo, async () => {
    await server.connect(transport);
    return transport.handleRequest(c);
  });
});

Deno.serve({ port: PORT, hostname: "0.0.0.0" }, app.fetch);
