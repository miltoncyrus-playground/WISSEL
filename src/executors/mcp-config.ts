import type { AgentDef, McpServer } from "../core/types.ts";
import type { McpServerPool } from "../core/mcp-server-pool.ts";

/** One of an agent's declared `mcpAccess` grants, resolved against a real
 *  McpServerPool — the server it points to actually exists and is
 *  enabled. A grant naming a missing or disabled server is silently
 *  dropped here (never thrown) — same tolerant-of-routine-unavailability
 *  discipline HarnessPool.acquire() already holds for "no candidate
 *  available" (an MCP server being down/disabled is an operational fact,
 *  not a caller bug), distinct from an explicit override like
 *  TaskCard.harnessOverride that fails loud when unresolvable. */
export interface ResolvedMcpGrant {
  server: McpServer;
  tools: string[];
}

/** Resolves an agent's `mcpAccess` declarations against a live pool,
 *  dropping any grant whose server doesn't exist, isn't enabled, or
 *  names zero tools. Returns `[]` (never throws) for `undefined`/empty
 *  `mcpAccess`, or when no pool is given — the exact "no MCP grants at
 *  all" case every existing agent in agents/manifest.yaml is in today.
 *  `[]` is the signal every caller in this module treats as "build
 *  nothing, change nothing." */
export function resolveMcpGrants(mcpAccess: AgentDef["mcpAccess"], pool: McpServerPool | undefined): ResolvedMcpGrant[] {
  if (!mcpAccess || mcpAccess.length === 0 || !pool) return [];
  const grants: ResolvedMcpGrant[] = [];
  for (const access of mcpAccess) {
    const server = pool.get(access.server);
    if (!server || !server.enabled) continue;
    if (access.tools.length === 0) continue;
    grants.push({ server, tools: access.tools });
  }
  return grants;
}

/** The exact tool-naming convention Claude Code itself uses for an MCP
 *  tool once it's attached — confirmed against the current official docs
 *  (code.claude.com/docs/en/mcp): `mcp__<server-name>__<tool-name>`. Used
 *  both to build --allowedTools entries and to recognize a granted MCP
 *  tool_use block's `name` field when parsing mcpCalls out of the
 *  stream-json event stream (see parse-mcp-calls.ts). */
export function mcpToolName(serverId: string, tool: string): string {
  return `mcp__${serverId}__${tool}`;
}

/** Every `mcp__<server>__<tool>` name this run is granted — fed straight
 *  into claude's --allowedTools alongside whatever else the caller
 *  already allows (see claude-cli.ts). `[]` for no grants, so a caller
 *  that only checks "any tools to allow at all" sees no behavior change. */
export function mcpAllowedToolNames(grants: ResolvedMcpGrant[]): string[] {
  return grants.flatMap((g) => g.tools.map((t) => mcpToolName(g.server.id, t)));
}

/** Builds the `--mcp-config` JSON payload for exactly this run's granted
 *  servers — the standard `{"mcpServers": {...}}` shape `claude`'s own
 *  `--mcp-config <json-or-file>` flag reads (confirmed via `claude
 *  --help`). Each entry carries only `command`/`args` (stdio) or
 *  `type`/`url` (sse/http) plus, when the server declares one, an `env`
 *  block whose values are `${VAR}` references — never the real secret
 *  inline in the generated config, same "pointer, not value" discipline
 *  McpServer.env's own doc comment holds. The real values those
 *  references resolve against are merged into the spawned CLI process's
 *  own env by the caller (see mcpServerEnvOverrides below), the same way
 *  a Harness's `env` already is.
 *
 *  Returns `undefined` for zero grants — the exact "don't pass
 *  --mcp-config/--strict-mcp-config at all" signal claude-cli.ts/
 *  codex-cli.ts need to keep an agent with no mcpAccess byte-identical to
 *  today. Only ever includes the servers actually granted — never every
 *  registered server — per docs/SDD-mcp-orchestration.md §3.2's explicit
 *  requirement. */
export function buildMcpConfigJson(grants: ResolvedMcpGrant[]): { mcpServers: Record<string, unknown> } | undefined {
  if (grants.length === 0) return undefined;
  const mcpServers: Record<string, unknown> = {};
  for (const { server } of grants) {
    const envKeys = server.env ? Object.keys(server.env) : [];
    const env = envKeys.length > 0 ? Object.fromEntries(envKeys.map((k) => [k, `\${${k}}`])) : undefined;
    if (server.transport.kind === "stdio") {
      mcpServers[server.id] = {
        command: server.transport.command,
        args: server.transport.args,
        ...(env ? { env } : {}),
      };
    } else {
      mcpServers[server.id] = {
        type: server.transport.kind,
        url: server.transport.url,
        ...(env ? { env } : {}),
      };
    }
  }
  return { mcpServers };
}

/** Every granted server's own `env` pointers, merged (last-wins, same as
 *  every other env merge in this codebase) into one object — passed
 *  straight through to the CommandRunner alongside the harness's own env
 *  overrides, so the `${VAR}` references buildMcpConfigJson's generated
 *  config carries actually resolve to something in the spawned CLI
 *  process's environment. `{}` for zero grants, so merging it into an
 *  existing env object is always a no-op when there's nothing to add. */
export function mcpServerEnvOverrides(grants: ResolvedMcpGrant[]): Record<string, string> {
  let merged: Record<string, string> = {};
  for (const { server } of grants) {
    if (server.env) merged = { ...merged, ...server.env };
  }
  return merged;
}
