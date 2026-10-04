import { access, constants } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import type { McpServer } from "./types.ts";

/**
 * Loads and selects from the MCP server manifest — mirrors HarnessPool's
 * shape (load/from/all/get/setEnabled) deliberately, since it's the same
 * kind of static, re-read-on-start descriptor list. Deliberately NOT a
 * single-pick `acquire(tool)` the way HarnessPool is: only one account
 * can drive a given CLI process, so HarnessPool.acquire() picks exactly
 * one harness. MCP servers don't work that way — a single agent run may
 * use multiple MCP servers at once (per its own `mcpAccess` grants,
 * wired in a later subtask), each independently acquired/released as its
 * own tools get called. So `acquire`/`release` here are per-server
 * in-flight bookkeeping for ONE named server, never a selector among
 * several. See docs/SDD-mcp-orchestration.md §3.1/§4.
 */
export class McpServerPool {
  private servers = new Map<string, McpServer>();
  /** In-process in-flight count per server id — same scope/shape as
   *  HarnessPool's own `inFlight`, just keyed to concurrency against one
   *  external tool surface instead of one credentialed process. */
  private inFlight = new Map<string, number>();

  static async load(path = "mcp-servers.yaml"): Promise<McpServerPool> {
    const raw = await readFile(path, "utf8");
    const parsed = parse(raw) as { "mcp-servers": McpServer[] };
    return McpServerPool.from(parsed["mcp-servers"] ?? []);
  }

  /** Builds a pool directly from a list — the manifest loader's own path,
   *  minus the file read. Used by tests that need a real McpServerPool
   *  without a mcp-servers.yaml on disk. Duplicate id throws, mirroring
   *  HarnessPool.from's own contract. */
  static from(servers: McpServer[]): McpServerPool {
    const pool = new McpServerPool();
    for (const server of servers) {
      if (pool.servers.has(server.id)) {
        throw new Error(`duplicate mcp server id: ${server.id}`);
      }
      pool.servers.set(server.id, server);
    }
    return pool;
  }

  all(): McpServer[] {
    return [...this.servers.values()];
  }

  get(id: string): McpServer | undefined {
    return this.servers.get(id);
  }

  /** Current in-flight call count for a server — 0 if it's never been
   *  acquired. Exposed so callers (the `/mcp-servers` endpoint) can
   *  report live load without duplicating this bookkeeping. */
  activeCount(id: string): number {
    return this.inFlight.get(id) ?? 0;
  }

  /** Marks one named server as having one more in-flight call against
   *  it — called once per actual tool call against that server, by
   *  whatever later subtask wires up the real tool-calling path. Unlike
   *  HarnessPool.acquire(), there's no selection to make: the caller
   *  always names the exact server it needs (from its own per-agent MCP
   *  grants), so an unknown id is a caller bug, not a "none available"
   *  case — thrown loudly rather than silently tolerated. */
  acquire(id: string): void {
    const server = this.servers.get(id);
    if (!server) throw new Error(`unknown mcp server id: ${id}`);
    this.inFlight.set(id, this.activeCount(id) + 1);
  }

  release(id: string): void {
    const n = this.activeCount(id);
    if (n <= 1) this.inFlight.delete(id);
    else this.inFlight.set(id, n - 1);
  }

  /** Adds a brand-new server to the live pool — the in-memory half of a
   *  human registering a new MCP server via the board's "Manage MCP
   *  servers" panel (`POST /mcp-servers`). The disk half is
   *  `addMcpServer` in mcp-manifest.ts, always called first by the
   *  caller, mirroring setEnabled/setToolTrust's own "disk first, then
   *  this" convention. Throws on a duplicate id, mirroring `from`'s own
   *  contract — the caller (the `POST /mcp-servers` handler) already
   *  checked `get(id)` and 400'd before ever reaching here, so a throw
   *  here is a caller bug, not a reachable runtime case (same "unknown
   *  id is a caller bug" discipline `acquire`'s own doc comment states
   *  for a different method). */
  add(server: McpServer): McpServer {
    if (this.servers.has(server.id)) {
      throw new Error(`duplicate mcp server id: ${server.id}`);
    }
    this.servers.set(server.id, server);
    return server;
  }

  /** Mutates the live pool's copy of a server in place — the in-memory
   *  half of a human enable/disable decision, mirroring
   *  HarnessPool.setEnabled exactly (the disk half is
   *  `setMcpServerEnabled` in mcp-manifest.ts, always done first by the
   *  caller). Returns undefined, changing nothing, for an unknown id. */
  setEnabled(id: string, enabled: boolean, disabledReason?: string): McpServer | undefined {
    const existing = this.servers.get(id);
    if (!existing) return undefined;
    const updated: McpServer = { ...existing, enabled, disabledReason };
    this.servers.set(id, updated);
    return updated;
  }

  /** Mutates the live pool's copy of one named tool's trust tier in
   *  place — the in-memory half of a human's trust-tier edit (board's
   *  Manage MCP Servers panel), mirroring setEnabled's exact shape (the
   *  disk half is `setMcpServerToolTrust` in mcp-manifest.ts, always
   *  done first by the caller). Returns undefined, changing nothing,
   *  for an unknown server id OR an unknown tool name on that server —
   *  same "caller must have already resolved both" contract setEnabled
   *  holds for the server id alone. */
  setToolTrust(id: string, toolName: string, trust: "auto" | "approval-required"): McpServer | undefined {
    const existing = this.servers.get(id);
    if (!existing) return undefined;
    if (!existing.tools.some((t) => t.name === toolName)) return undefined;
    const updated: McpServer = {
      ...existing,
      tools: existing.tools.map((t) => (t.name === toolName ? { ...t, trust } : t)),
    };
    this.servers.set(id, updated);
    return updated;
  }
}

/** Injectable so tests never hit the real filesystem PATH or spend a
 *  real network round-trip. `env` scopes the stdio PATH-lookup (defaults
 *  to `process.env`); `fetchImpl` scopes the sse/http probe (defaults to
 *  global `fetch`); `timeoutMs` bounds the sse/http probe. */
export interface CheckMcpServerReachableOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Pragmatic, conservative reachability check — mirrors
 * checkHarnessAuth's role (src/core/harness-discovery.ts) but checks MCP
 * connectivity instead of CLI auth. This is deliberately NOT a full MCP
 * handshake/protocol client: for `stdio`, it only checks the named
 * command exists on PATH (or is an absolute path that exists and is
 * executable) — it never spawns the process. For `sse`/`http`, it's a
 * basic HTTP reachability probe (HEAD, short timeout) — it never speaks
 * the MCP protocol itself. A genuine MCP handshake is a real gap this
 * check doesn't close; if that turns out to be necessary to know a
 * server is truly usable (not just "something is listening"), that's
 * later work (the real tool-calling wiring), not this subtask.
 */
export async function checkMcpServerReachable(
  server: McpServer,
  opts: CheckMcpServerReachableOptions = {},
): Promise<{ reachable: boolean; reason?: string }> {
  if (server.transport.kind === "stdio") {
    const env = opts.env ?? process.env;
    const found = await commandExistsOnPath(server.transport.command, env);
    return found ? { reachable: true } : { reachable: false, reason: `command "${server.transport.command}" not found on PATH` };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(server.transport.url, { method: "HEAD", signal: AbortSignal.timeout(opts.timeoutMs ?? 3000) });
    // A non-5xx response (even a 404/405 — plenty of MCP endpoints don't
    // support HEAD) still proves something is listening and responding.
    // Only a server-side failure or a thrown network error (connection
    // refused, DNS failure, timeout) counts as unreachable.
    if (res.status >= 500) return { reachable: false, reason: `HTTP ${res.status}` };
    return { reachable: true };
  } catch (e) {
    return { reachable: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

async function commandExistsOnPath(command: string, env: Record<string, string | undefined>): Promise<boolean> {
  if (isAbsolute(command)) {
    return access(command, constants.X_OK).then(
      () => true,
      () => false,
    );
  }
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    const ok = await access(join(dir, command), constants.X_OK).then(
      () => true,
      () => false,
    );
    if (ok) return true;
  }
  return false;
}

/** Raw, not-yet-validated shape of a `POST /mcp-servers` request body —
 *  every field `unknown` at this layer since it comes straight off the
 *  wire. */
export interface McpServerCreateInput {
  id?: unknown;
  label?: unknown;
  transport?: unknown;
  tools?: unknown;
  env?: unknown;
}

/**
 * Validates a raw `POST /mcp-servers` body into a real `McpServer`
 * (minus `disabledReason`, which is never settable at creation — a
 * derived/runtime annotation, never hand-written, same rule
 * `setMcpServerEnabled`'s own comment states for the YAML side). Mirrors
 * the discipline `POST /projects/local`'s own body validation holds
 * (required-field 400s with a clear message) but goes one level deeper:
 * unlike a project's `path` (a bare string), `McpServer.transport` is a
 * tagged union whose required fields differ by `kind`, so `kind` itself
 * has to be checked before anything inside it can be validated.
 *
 * Pure and synchronous — no I/O, no reachability check. Reachability is
 * `checkMcpServerReachable`'s job, called separately by the `POST
 * /mcp-servers` handler only after this succeeds (see
 * docs/SDD-mcp-server-registration.md §3.2/§3.3 for why creation reuses
 * that check's existing cheap scope instead of a real MCP handshake, and
 * refuses to persist anything when it fails).
 */
export function parseMcpServerCreateInput(body: McpServerCreateInput): { server: Omit<McpServer, "disabledReason"> } | { error: string } {
  if (typeof body.id !== "string" || !body.id.trim()) return { error: "id is required" };
  if (typeof body.label !== "string" || !body.label.trim()) return { error: "label is required" };

  const transport = parseMcpTransportInput(body.transport);
  if ("error" in transport) return transport;

  const tools = parseMcpToolsInput(body.tools);
  if ("error" in tools) return tools;

  if (body.env !== undefined) {
    if (typeof body.env !== "object" || body.env === null || Array.isArray(body.env)) {
      return { error: "env must be an object mapping names to env var names" };
    }
    for (const [key, value] of Object.entries(body.env as Record<string, unknown>)) {
      if (typeof value !== "string") return { error: `env.${key} must be a string (an env var name, never a secret value)` };
    }
  }

  return {
    server: {
      id: body.id.trim(),
      label: body.label.trim(),
      transport: transport.transport,
      tools: tools.tools,
      enabled: true,
      ...(body.env ? { env: body.env as Record<string, string> } : {}),
    },
  };
}

function parseMcpTransportInput(input: unknown): { transport: McpServer["transport"] } | { error: string } {
  if (typeof input !== "object" || input === null) return { error: "transport is required" };
  const t = input as Record<string, unknown>;

  if (t.kind === "stdio") {
    if (typeof t.command !== "string" || !t.command.trim()) return { error: "transport.command is required for a stdio server" };
    if (t.args !== undefined && !(Array.isArray(t.args) && t.args.every((a) => typeof a === "string"))) {
      return { error: "transport.args must be an array of strings" };
    }
    return { transport: { kind: "stdio", command: t.command.trim(), args: (t.args as string[] | undefined) ?? [] } };
  }

  if (t.kind === "sse" || t.kind === "http") {
    if (typeof t.url !== "string" || !t.url.trim()) return { error: `transport.url is required for a ${t.kind} server` };
    return { transport: { kind: t.kind, url: t.url.trim() } };
  }

  return { error: 'transport.kind must be "stdio", "sse", or "http"' };
}

function parseMcpToolsInput(input: unknown): { tools: McpServer["tools"] } | { error: string } {
  if (input === undefined) return { tools: [] };
  if (!Array.isArray(input)) return { error: "tools must be an array" };

  const tools: McpServer["tools"] = [];
  for (const item of input) {
    if (typeof item !== "object" || item === null) return { error: "each tool must be an object with a name" };
    const t = item as Record<string, unknown>;
    if (typeof t.name !== "string" || !t.name.trim()) return { error: "each tool.name is required" };
    const trust = t.trust ?? "approval-required";
    if (trust !== "auto" && trust !== "approval-required") {
      return { error: `tool "${t.name}".trust must be "auto" or "approval-required"` };
    }
    tools.push({ name: t.name.trim(), trust });
  }
  return { tools };
}
