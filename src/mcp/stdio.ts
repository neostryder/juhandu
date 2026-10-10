// The stdio door for assistants that start their server as a command: it forwards each JSON-RPC line to the running Juhandu over HTTP.
//   node src/mcp/stdio.ts
// JUHANDU_URL (default http://127.0.0.1:8787) is where Juhandu listens; JUHANDU_MCP_TOKEN is the access token if one is set.
import { createInterface } from "node:readline";

const base = (process.env["JUHANDU_URL"] ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const token = process.env["JUHANDU_MCP_TOKEN"];

function reply(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

async function forward(line: string): Promise<void> {
  let id: unknown = null;
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) id = (parsed as { id?: unknown }).id ?? null;
  } catch {
    reply({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  try {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: line,
      signal: AbortSignal.timeout(60_000),
    });
    if (response.status === 202) return;
    if (!response.ok) {
      reply({ jsonrpc: "2.0", id, error: { code: -32000, message: response.status === 401 || response.status === 403 ? "Juhandu refused the request. Check JUHANDU_MCP_TOKEN." : `Juhandu answered ${response.status}` } });
      return;
    }
    reply(await response.json());
  } catch {
    reply({ jsonrpc: "2.0", id, error: { code: -32000, message: `Juhandu is not reachable at ${base}` } });
  }
}

const lines = createInterface({ input: process.stdin });
const running = new Set<Promise<void>>();
lines.on("line", (line) => {
  if (!line.trim()) return;
  const job = forward(line).finally(() => running.delete(job));
  running.add(job);
});
lines.on("close", () => {
  void Promise.all(running).then(() => process.exit(0));
});
