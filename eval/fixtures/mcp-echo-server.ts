#!/usr/bin/env bun
/**
 * A real, minimal MCP server over stdio — not the official
 * `@modelcontextprotocol/sdk` (not a dependency anywhere in this repo;
 * `node_modules/@modelcontextprotocol` doesn't exist), but a genuine,
 * complete-enough hand-rolled implementation of MCP's stdio transport
 * (newline-delimited JSON-RPC 2.0 messages on stdin/stdout) to prove
 * wissel's MCP wiring against a real attached server, end to end — not a
 * scripted stand-in. The only caller is
 * eval/pipeline-mcp-integration.eval.ts (see docs/SDD-mcp-orchestration.md
 * §6 Subtask 7), which spawns this via `bun run <this file>` as the
 * `command`/`args` of a stdio McpServer.transport.
 *
 * Two tools, matching the eval's own McpServerPool fixture's trust
 * tiers:
 * - `echo` (trust: "auto" in the eval's pool) — the tool the main
 *   coding+MCP-step proof actually calls; echoes its `text` argument
 *   back as the tool result.
 * - `echo_sensitive` (trust: "approval-required" in the eval's pool) —
 *   behaviorally identical, included so a well-formed `tools/call`
 *   would still succeed if it were ever actually reached. It never
 *   should be: wissel's own trust-tier gate (splitGrantsByTrust,
 *   src/executors/mcp-config.ts) excludes an approval-required tool
 *   from `--allowedTools` regardless of what an agent's `mcpAccess`
 *   declares — this server enforces nothing itself, the gate is
 *   entirely wissel-side, not an MCP-protocol concept.
 *
 * Handles exactly the three methods a real `claude -p` MCP client round
 * trip needs: `initialize` (echoes back whatever protocolVersion the
 * client requested, the documented-safe way to avoid a version
 * mismatch), `notifications/initialized` (a notification — no `id`, no
 * response), and `tools/list`/`tools/call`. Anything else gets a plain
 * JSON-RPC "method not found" error. A line that fails to JSON.parse is
 * skipped, not thrown — same tolerant-of-a-partial-line discipline every
 * other JSONL reader in this codebase holds (see e.g.
 * src/executors/parse-mcp-calls.ts).
 */

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

function send(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function respond(id: string | number, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id: string | number, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

const TOOLS = [
  {
    name: "echo",
    description: "Echoes back whatever `text` argument it's given.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "echo_sensitive",
    description: "Same as echo — for a tool a caller's own trust config declares approval-required.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
];

function handleRequest(req: JsonRpcRequest): void {
  if (req.method === "initialize") {
    respond(req.id!, {
      protocolVersion: (req.params?.protocolVersion as string | undefined) ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "wissel-echo-mcp", version: "0.0.0" },
    });
    return;
  }

  if (req.method === "notifications/initialized") {
    return; // notification — no id, no response, per JSON-RPC 2.0
  }

  if (req.method === "tools/list") {
    respond(req.id!, { tools: TOOLS });
    return;
  }

  if (req.method === "tools/call") {
    const name = req.params?.name as string | undefined;
    const args = req.params?.arguments ?? {};
    if (name !== "echo" && name !== "echo_sensitive") {
      respondError(req.id!, -32602, `unknown tool: ${name}`);
      return;
    }
    respond(req.id!, { content: [{ type: "text", text: JSON.stringify(args) }], isError: false });
    return;
  }

  if (req.id !== undefined) respondError(req.id, -32601, `method not found: ${req.method}`);
}

let buffer = "";
process.stdin.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf8");
  let idx: number;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      handleRequest(JSON.parse(line) as JsonRpcRequest);
    } catch {
      // malformed/partial line — tolerated, see file doc comment.
    }
  }
});
process.stdin.on("end", () => process.exit(0));
