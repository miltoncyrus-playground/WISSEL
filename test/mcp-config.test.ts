import { expect, test } from "bun:test";
import { buildMcpConfigJson, mcpAllowedToolNames, mcpServerEnvOverrides, mcpToolName, resolveMcpGrants } from "../src/executors/mcp-config.ts";
import { McpServerPool } from "../src/core/mcp-server-pool.ts";
import type { McpServer } from "../src/core/types.ts";

function server(overrides: Partial<McpServer> & Pick<McpServer, "id">): McpServer {
  return {
    label: overrides.id,
    transport: { kind: "stdio", command: "/bin/true", args: [] },
    tools: [],
    enabled: true,
    ...overrides,
  };
}

// --- resolveMcpGrants ---

test("resolveMcpGrants returns [] for undefined mcpAccess — the exact 'no grants at all' case every existing agent is in", () => {
  const pool = McpServerPool.from([server({ id: "a" })]);
  expect(resolveMcpGrants(undefined, pool)).toEqual([]);
});

test("resolveMcpGrants returns [] for an empty mcpAccess array", () => {
  const pool = McpServerPool.from([server({ id: "a" })]);
  expect(resolveMcpGrants([], pool)).toEqual([]);
});

test("resolveMcpGrants returns [] when no pool is given at all", () => {
  expect(resolveMcpGrants([{ server: "a", tools: ["x"] }], undefined)).toEqual([]);
});

test("resolveMcpGrants resolves a real grant against the pool's own server object", () => {
  const pool = McpServerPool.from([server({ id: "a", label: "A server" })]);
  const grants = resolveMcpGrants([{ server: "a", tools: ["x", "y"] }], pool);
  expect(grants).toEqual([{ server: pool.get("a")!, tools: ["x", "y"] }]);
});

test("resolveMcpGrants silently drops a grant naming a server not in the pool", () => {
  const pool = McpServerPool.from([server({ id: "a" })]);
  expect(resolveMcpGrants([{ server: "missing", tools: ["x"] }], pool)).toEqual([]);
});

test("resolveMcpGrants silently drops a grant naming a disabled server", () => {
  const pool = McpServerPool.from([server({ id: "a", enabled: false })]);
  expect(resolveMcpGrants([{ server: "a", tools: ["x"] }], pool)).toEqual([]);
});

test("resolveMcpGrants silently drops a grant with zero tools named", () => {
  const pool = McpServerPool.from([server({ id: "a" })]);
  expect(resolveMcpGrants([{ server: "a", tools: [] }], pool)).toEqual([]);
});

test("resolveMcpGrants resolves multiple grants independently, dropping only the bad ones", () => {
  const pool = McpServerPool.from([server({ id: "a" }), server({ id: "b", enabled: false })]);
  const grants = resolveMcpGrants(
    [
      { server: "a", tools: ["x"] },
      { server: "b", tools: ["y"] },
      { server: "missing", tools: ["z"] },
    ],
    pool,
  );
  expect(grants).toEqual([{ server: pool.get("a")!, tools: ["x"] }]);
});

// --- mcpToolName / mcpAllowedToolNames ---

test("mcpToolName follows Claude Code's own mcp__<server>__<tool> convention", () => {
  expect(mcpToolName("slack", "send_message")).toBe("mcp__slack__send_message");
});

test("mcpAllowedToolNames flattens every grant's tools into mcp__ names, empty for zero grants", () => {
  const pool = McpServerPool.from([server({ id: "slack" }), server({ id: "jira" })]);
  const grants = resolveMcpGrants(
    [
      { server: "slack", tools: ["send_message", "read_messages"] },
      { server: "jira", tools: ["get_issue"] },
    ],
    pool,
  );
  expect(mcpAllowedToolNames(grants)).toEqual(["mcp__slack__send_message", "mcp__slack__read_messages", "mcp__jira__get_issue"]);
  expect(mcpAllowedToolNames([])).toEqual([]);
});

// --- buildMcpConfigJson ---

test("buildMcpConfigJson returns undefined for zero grants — the signal callers use to omit --mcp-config entirely", () => {
  expect(buildMcpConfigJson([])).toBeUndefined();
});

test("buildMcpConfigJson builds a stdio server entry with command/args, no env block when the server declares none", () => {
  const pool = McpServerPool.from([server({ id: "a", transport: { kind: "stdio", command: "/usr/bin/foo", args: ["--flag"] } })]);
  const grants = resolveMcpGrants([{ server: "a", tools: ["x"] }], pool);
  expect(buildMcpConfigJson(grants)).toEqual({ mcpServers: { a: { command: "/usr/bin/foo", args: ["--flag"] } } });
});

test("buildMcpConfigJson includes an env block of ${VAR} pointers, never the real value, when the server declares env", () => {
  const pool = McpServerPool.from([server({ id: "a", env: { SLACK_BOT_TOKEN: "SLACK_BOT_TOKEN" } })]);
  const grants = resolveMcpGrants([{ server: "a", tools: ["x"] }], pool);
  const config = buildMcpConfigJson(grants);
  expect(config).toEqual({ mcpServers: { a: { command: "/bin/true", args: [], env: { SLACK_BOT_TOKEN: "${SLACK_BOT_TOKEN}" } } } });
});

test("buildMcpConfigJson builds an sse/http server entry with type/url", () => {
  const pool = McpServerPool.from([server({ id: "a", transport: { kind: "http", url: "https://example.internal/mcp" } })]);
  const grants = resolveMcpGrants([{ server: "a", tools: ["x"] }], pool);
  expect(buildMcpConfigJson(grants)).toEqual({ mcpServers: { a: { type: "http", url: "https://example.internal/mcp" } } });
});

test("buildMcpConfigJson includes ONLY the granted servers, never every registered server in the pool", () => {
  const pool = McpServerPool.from([server({ id: "granted" }), server({ id: "not-granted" })]);
  const grants = resolveMcpGrants([{ server: "granted", tools: ["x"] }], pool);
  const config = buildMcpConfigJson(grants)!;
  expect(Object.keys(config.mcpServers)).toEqual(["granted"]);
});

// --- mcpServerEnvOverrides ---

test("mcpServerEnvOverrides returns {} for zero grants", () => {
  expect(mcpServerEnvOverrides([])).toEqual({});
});

test("mcpServerEnvOverrides merges every granted server's own env, last-wins on key collision", () => {
  const pool = McpServerPool.from([server({ id: "a", env: { FOO: "1" } }), server({ id: "b", env: { FOO: "2", BAR: "3" } })]);
  const grants = resolveMcpGrants(
    [
      { server: "a", tools: ["x"] },
      { server: "b", tools: ["y"] },
    ],
    pool,
  );
  expect(mcpServerEnvOverrides(grants)).toEqual({ FOO: "2", BAR: "3" });
});
