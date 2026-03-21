/**
 * MCP stdio-to-HTTP bridge for OB1.
 * Reads JSON-RPC from stdin, forwards to OB1 HTTP server, returns responses on stdout.
 * Usage: deno run --allow-net --allow-env --allow-read --allow-write mcp-stdio-bridge.ts <server-url> <access-key>
 */

const serverUrl = Deno.args[0];
const accessKey = Deno.args[1];

if (!serverUrl || !accessKey) {
  console.error("Usage: mcp-stdio-bridge.ts <server-url> <access-key>");
  Deno.exit(1);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Read lines from stdin
async function* readLines(): AsyncGenerator<string> {
  const buf = new Uint8Array(65536);
  let carry = "";
  while (true) {
    const n = await Deno.stdin.read(buf);
    if (n === null) break;
    carry += decoder.decode(buf.subarray(0, n));
    const lines = carry.split("\n");
    carry = lines.pop() || "";
    for (const line of lines) {
      if (line.trim()) yield line.trim();
    }
  }
  if (carry.trim()) yield carry.trim();
}

// Forward a JSON-RPC request to the HTTP server
async function forward(jsonRpc: string): Promise<void> {
  try {
    const resp = await fetch(serverUrl + "/?key=" + accessKey, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      },
      body: jsonRpc,
    });

    const contentType = resp.headers.get("content-type") || "";

    if (contentType.includes("text/event-stream")) {
      // SSE response — extract JSON-RPC results from data: lines
      const text = await resp.text();
      for (const line of text.split("\n")) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim();
          if (data) {
            await Deno.stdout.write(encoder.encode(data + "\n"));
          }
        }
      }
    } else {
      // Direct JSON response
      const text = await resp.text();
      if (text.trim()) {
        await Deno.stdout.write(encoder.encode(text.trim() + "\n"));
      }
    }
  } catch (err) {
    // Return a JSON-RPC error
    let id = null;
    try {
      id = JSON.parse(jsonRpc).id;
    } catch { /* ignore */ }
    const errResp = JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: `Bridge error: ${(err as Error).message}` },
    });
    await Deno.stdout.write(encoder.encode(errResp + "\n"));
  }
}

// Main loop
for await (const line of readLines()) {
  await forward(line);
}
