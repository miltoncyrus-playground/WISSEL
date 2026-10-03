import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkMcpServerReachable, McpServerPool } from "../src/core/mcp-server-pool.ts";
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

test("from() rejects a duplicate id, mirroring HarnessPool", () => {
  expect(() => McpServerPool.from([server({ id: "a" }), server({ id: "a" })])).toThrow(/duplicate mcp server id: a/);
});

test("all()/get() round-trip what from() was built with", () => {
  const pool = McpServerPool.from([server({ id: "a" }), server({ id: "b" })]);
  expect(pool.all().map((s) => s.id)).toEqual(["a", "b"]);
  expect(pool.get("a")?.id).toBe("a");
  expect(pool.get("missing")).toBeUndefined();
});

test("acquire()/release() track per-server in-flight counts independently — not a single pick across servers", () => {
  const pool = McpServerPool.from([server({ id: "a" }), server({ id: "b" })]);
  pool.acquire("a");
  pool.acquire("a");
  pool.acquire("b");

  // Both servers can be active at once — this is the semantic difference
  // from HarnessPool.acquire(), which picks exactly one harness per call.
  expect(pool.activeCount("a")).toBe(2);
  expect(pool.activeCount("b")).toBe(1);

  pool.release("a");
  expect(pool.activeCount("a")).toBe(1);
  pool.release("a");
  expect(pool.activeCount("a")).toBe(0);
  expect(pool.activeCount("b")).toBe(1);
});

test("acquire() with an unknown id throws rather than silently tolerating it", () => {
  const pool = McpServerPool.from([server({ id: "a" })]);
  expect(() => pool.acquire("missing")).toThrow(/unknown mcp server id: missing/);
});

test("release() on a server never acquired is a no-op, not an error", () => {
  const pool = McpServerPool.from([server({ id: "a" })]);
  expect(() => pool.release("a")).not.toThrow();
  expect(pool.activeCount("a")).toBe(0);
});

test("setEnabled() mutates the live copy, visible to a subsequent get()", () => {
  const pool = McpServerPool.from([server({ id: "a" })]);
  const updated = pool.setEnabled("a", false, "not reachable");
  expect(updated?.enabled).toBe(false);
  expect(updated?.disabledReason).toBe("not reachable");
  expect(pool.get("a")?.enabled).toBe(false);
});

test("setEnabled() returns undefined and changes nothing for an unknown id", () => {
  const pool = McpServerPool.from([server({ id: "a" })]);
  expect(pool.setEnabled("missing", false)).toBeUndefined();
  expect(pool.get("a")?.enabled).toBe(true);
});

test("setEnabled() clears disabledReason when a human enables a server — their choice supersedes the auto-diagnosis", () => {
  const pool = McpServerPool.from([server({ id: "a", enabled: false, disabledReason: "not reachable" })]);
  const updated = pool.setEnabled("a", true);
  expect(updated?.enabled).toBe(true);
  expect(updated?.disabledReason).toBeUndefined();
});

test("setToolTrust() mutates the one named tool in place, leaving every other tool on the server untouched", () => {
  const pool = McpServerPool.from([
    server({ id: "a", tools: [{ name: "foo", trust: "approval-required" }, { name: "bar", trust: "auto" }] }),
  ]);
  const updated = pool.setToolTrust("a", "foo", "auto");
  expect(updated?.tools).toEqual([{ name: "foo", trust: "auto" }, { name: "bar", trust: "auto" }]);
  expect(pool.get("a")?.tools).toEqual([{ name: "foo", trust: "auto" }, { name: "bar", trust: "auto" }]);
});

test("setToolTrust() returns undefined and changes nothing for an unknown server id", () => {
  const pool = McpServerPool.from([server({ id: "a", tools: [{ name: "foo", trust: "auto" }] })]);
  expect(pool.setToolTrust("missing", "foo", "approval-required")).toBeUndefined();
  expect(pool.get("a")?.tools).toEqual([{ name: "foo", trust: "auto" }]);
});

test("setToolTrust() returns undefined and changes nothing for an unknown tool name on a known server", () => {
  const pool = McpServerPool.from([server({ id: "a", tools: [{ name: "foo", trust: "auto" }] })]);
  expect(pool.setToolTrust("a", "missing-tool", "approval-required")).toBeUndefined();
  expect(pool.get("a")?.tools).toEqual([{ name: "foo", trust: "auto" }]);
});

test("disabling an already-acquired server doesn't interrupt what's already running under it", () => {
  const pool = McpServerPool.from([server({ id: "a" })]);
  pool.acquire("a");
  pool.setEnabled("a", false);
  expect(pool.activeCount("a")).toBe(1);
  pool.release("a");
  expect(pool.activeCount("a")).toBe(0);
});

test("load() reads a real mcp-servers.yaml fixture", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-mcp-pool-test-"));
  const path = join(dir, "mcp-servers.yaml");
  try {
    await writeFile(
      path,
      "mcp-servers:\n" +
        "  - id: a\n" +
        "    label: A\n" +
        "    enabled: true\n" +
        "    transport:\n" +
        "      kind: stdio\n" +
        "      command: /bin/true\n" +
        "      args: []\n" +
        "    tools:\n" +
        "      - name: foo\n" +
        '        trust: "approval-required"\n',
    );
    const pool = await McpServerPool.load(path);
    expect(pool.all().map((s) => s.id)).toEqual(["a"]);
    expect(pool.get("a")?.tools).toEqual([{ name: "foo", trust: "approval-required" }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("load() throws on a missing file, mirroring HarnessPool.load()", async () => {
  await expect(McpServerPool.load("/does/not/exist/mcp-servers.yaml")).rejects.toThrow();
});

// --- checkMcpServerReachable ---

test("stdio transport: reachable when the command is an absolute, executable path", async () => {
  const result = await checkMcpServerReachable(server({ id: "a", transport: { kind: "stdio", command: "/bin/sh", args: [] } }));
  expect(result.reachable).toBe(true);
});

test("stdio transport: unreachable when the absolute command path doesn't exist", async () => {
  const result = await checkMcpServerReachable(server({ id: "a", transport: { kind: "stdio", command: "/no/such/binary", args: [] } }));
  expect(result.reachable).toBe(false);
  expect(result.reason).toContain("/no/such/binary");
});

test("stdio transport: reachable when a bare command name resolves on an injected PATH", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-mcp-pool-test-"));
  const binPath = join(dir, "fake-mcp-server");
  try {
    await writeFile(binPath, "#!/bin/sh\necho hi\n");
    await chmod(binPath, 0o755);
    const result = await checkMcpServerReachable(server({ id: "a", transport: { kind: "stdio", command: "fake-mcp-server", args: [] } }), {
      env: { PATH: dir },
    });
    expect(result.reachable).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stdio transport: unreachable when a bare command name isn't on the injected PATH", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-mcp-pool-test-"));
  try {
    const result = await checkMcpServerReachable(server({ id: "a", transport: { kind: "stdio", command: "fake-mcp-server", args: [] } }), {
      env: { PATH: dir },
    });
    expect(result.reachable).toBe(false);
    expect(result.reason).toContain("fake-mcp-server");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("http transport: reachable when the injected fetch resolves with a non-5xx status", async () => {
  const fetchImpl = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
  const result = await checkMcpServerReachable(server({ id: "a", transport: { kind: "http", url: "https://example.invalid/mcp" } }), { fetchImpl });
  expect(result.reachable).toBe(true);
});

test("http transport: unreachable when the injected fetch resolves with a 5xx status", async () => {
  const fetchImpl = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
  const result = await checkMcpServerReachable(server({ id: "a", transport: { kind: "http", url: "https://example.invalid/mcp" } }), { fetchImpl });
  expect(result.reachable).toBe(false);
  expect(result.reason).toBe("HTTP 503");
});

test("sse transport: unreachable when the injected fetch throws (connection refused/DNS failure)", async () => {
  const fetchImpl = (async () => {
    throw new Error("connection refused");
  }) as unknown as typeof fetch;
  const result = await checkMcpServerReachable(server({ id: "a", transport: { kind: "sse", url: "https://example.invalid/mcp" } }), { fetchImpl });
  expect(result.reachable).toBe(false);
  expect(result.reason).toBe("connection refused");
});
