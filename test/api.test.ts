import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { createApp, servePipelineEditorAsset, type CreateAppOptions } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { McpServerPool } from "../src/core/mcp-server-pool.ts";
import type { AgentDef, Executor, Harness, McpServer, TaskCard, TaskResult } from "../src/core/types.ts";
import type { CommandRunner } from "../src/executors/claude-cli.ts";
import type { AnthropicMessagesClient } from "../src/executors/anthropic-api.ts";
import type Anthropic from "@anthropic-ai/sdk";

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

async function makeApp(board = new SqliteBoard(), opts?: CreateAppOptions) {
  const registry = await Registry.load();
  return createApp(board, registry, undefined, opts);
}

/** A fake write executor for `/tasks/:id/run` tests — never spawns a
 *  real `claude` process. */
function fakeWriteExecutor(run: Executor["run"]): Executor {
  return { id: "fake-write", canHandle: (agent: AgentDef) => agent.tier === "write", run };
}

test("GET /health", async () => {
  const app = await makeApp();
  const res = await app(req("/health"));
  expect(await res.text()).toBe("ok");
});

test("GET /version", async () => {
  const app = await makeApp();
  const res = await app(req("/version"));
  const body = (await res.json()) as {
    commit: string;
    commitShort: string;
    branch: string;
    dirty: boolean;
    packageVersion: string;
    startedAt: string;
  };
  // Shape/types only, not the literal SHA — that would flake on every commit.
  expect(typeof body.commit).toBe("string");
  expect(typeof body.commitShort).toBe("string");
  expect(typeof body.branch).toBe("string");
  expect(typeof body.dirty).toBe("boolean");
  expect(body.packageVersion).toBe("0.0.0");
  expect(typeof body.startedAt).toBe("string");
});

test("GET / and GET /board serve the board UI", async () => {
  const app = await makeApp();
  for (const path of ["/", "/board"]) {
    const res = await app(req(path));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<title>wissel board</title>");
  }
});

test("GET /agents returns the fleet from the manifest", async () => {
  const app = await makeApp();
  const res = await app(req("/agents"));
  const agents = (await res.json()) as { id: string }[];
  expect(agents.some((a) => a.id === "triager")).toBe(true);
});

test("GET /harnesses defaults to empty, and returns configured harnesses with a live activeCount and availableModels", async () => {
  const empty = await makeApp();
  expect(await (await empty(req("/harnesses"))).json()).toEqual([]);

  const harnesses = HarnessPool.from([{ id: "claude-personal", tool: "claude-cli", label: "Claude — personal", enabled: true }]);
  const withHarness = await makeApp(new SqliteBoard(), { harnesses });
  const res = await withHarness(req("/harnesses"));
  const body = (await res.json()) as { id: string; tool: string; label: string; enabled: boolean; activeCount: number; availableModels: string[] }[];
  // No cache configured/found for this harness id yet — a cache-miss
  // reports [], never an error.
  expect(body).toEqual([{ id: "claude-personal", tool: "claude-cli", label: "Claude — personal", enabled: true, activeCount: 0, availableModels: [] }]);
});

test("GET /harnesses reports availableModels from an injected fake cache, keyed by harness id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-api-models-cache-test-"));
  try {
    const modelsCachePath = join(dir, "models-cache.json");
    await writeFile(
      modelsCachePath,
      JSON.stringify({
        "claude-personal": { models: ["claude-sonnet-5", "claude-opus-5"], fetchedAt: new Date().toISOString() },
      }),
    );
    const harnesses = HarnessPool.from([
      { id: "claude-personal", tool: "claude-cli", label: "Claude — personal", enabled: true },
      { id: "codex-personal", tool: "codex-cli", label: "Codex — personal", enabled: true },
    ]);
    const app = await makeApp(new SqliteBoard(), { harnesses, modelsCachePath });

    const body = (await (await app(req("/harnesses"))).json()) as { id: string; availableModels: string[] }[];
    expect(body.find((h) => h.id === "claude-personal")?.availableModels).toEqual(["claude-sonnet-5", "claude-opus-5"]);
    // codex-personal has no cache entry at all — a miss, not an error.
    expect(body.find((h) => h.id === "codex-personal")?.availableModels).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GET /memory returns undefined content when nothing has been curated yet, and the real content once it has", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-api-memory-test-"));
  try {
    const memoryPath = join(dir, "lessons.md");
    const empty = await makeApp(new SqliteBoard(), { memoryPath });
    const emptyBody = (await (await empty(req("/memory"))).json()) as { content: string | undefined; path: string };
    expect(emptyBody.content).toBeUndefined();
    expect(emptyBody.path).toBe(memoryPath);

    await writeFile(memoryPath, "# Lessons\n\nSome curated content.");
    const withContent = await makeApp(new SqliteBoard(), { memoryPath });
    const body = (await (await withContent(req("/memory"))).json()) as { content: string | undefined };
    expect(body.content).toBe("# Lessons\n\nSome curated content.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// docs/SDD-memory-injection-toggle.md §3.4/§4 test 5 — GET /memory's
// `injected` field mirrors createApp's own `injectMemory` flag exactly,
// not whether curation has produced any content.
test("GET /memory reports injected: false by default and injected: true when createApp gets injectMemory: true", async () => {
  const defaultApp = await makeApp();
  const defaultBody = (await (await defaultApp(req("/memory"))).json()) as { injected: boolean };
  expect(defaultBody.injected).toBe(false);

  const injectingApp = await makeApp(new SqliteBoard(), { injectMemory: true });
  const injectingBody = (await (await injectingApp(req("/memory"))).json()) as { injected: boolean };
  expect(injectingBody.injected).toBe(true);
});

test("GET /memory/history returns [] with no telemetry configured, and real runs most-recent-first once it is", async () => {
  const { TelemetryLog } = await import("../src/services/telemetry.ts");
  const noTelemetryApp = await makeApp();
  expect(await (await noTelemetryApp(req("/memory/history"))).json()).toEqual([]);

  const dir = await mkdtemp(join(tmpdir(), "wissel-api-memory-history-test-"));
  try {
    const telemetryPath = join(dir, "telemetry.jsonl");
    const telemetry = new TelemetryLog(telemetryPath);
    await telemetry.record({ type: "result", taskId: "run-1", agentId: "memory-curator", actualCost: 0.1, harnessId: "claude" });
    await new Promise((resolve) => setTimeout(resolve, 5)); // distinct `at` timestamps, so ordering is unambiguous
    await telemetry.record({ type: "result", taskId: "run-2", agentId: "memory-curator", actualCost: 0.2, harnessId: "claude" });
    // A non-memory-curator result must never show up in curation history.
    await telemetry.record({ type: "result", taskId: "run-3", agentId: "implementer", actualCost: 5, harnessId: "claude" });

    const board = new SqliteBoard();
    await board.create({ title: "t", body: "", labels: [], repo: "r" }); // just to exercise a real id space
    await board.recordResult({ taskId: "run-1", agentId: "memory-curator", ok: true, summary: "first curation" });
    await board.recordResult({ taskId: "run-2", agentId: "memory-curator", ok: true, summary: "second curation" });

    const registry = await Registry.load();
    const app = createApp(board, registry, telemetry, {});
    const runs = (await (await app(req("/memory/history"))).json()) as { taskId: string; summary: string | undefined; actualCost: number }[];

    expect(runs.map((r) => r.taskId)).toEqual(["run-2", "run-1"]); // most recent first
    expect(runs[0]!.summary).toBe("second curation");
    expect(runs[1]!.summary).toBe("first curation");
    expect(runs.some((r) => r.taskId === "run-3")).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function harnessesFixture(content: string): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "wissel-api-harnesses-test-"));
  const path = join(dir, "harnesses.yaml");
  await writeFile(path, content);
  return { dir, path };
}

test("POST /harnesses/:id/disable persists to harnesses.yaml and updates the live pool, no re-validation needed", async () => {
  const { dir, path } = await harnessesFixture("harnesses:\n  - id: a\n    tool: claude-cli\n    label: A\n    enabled: true\n");
  try {
    const harnesses = HarnessPool.from([{ id: "a", tool: "claude-cli", label: "A", enabled: true }]);
    let runnerCalled = false;
    const app = await makeApp(new SqliteBoard(), {
      harnesses,
      harnessesPath: path,
      harnessRunner: async () => {
        runnerCalled = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    const res = await app(req("/harnesses/a/disable", { method: "POST" }));

    expect(res.status).toBe(200);
    expect(((await res.json()) as Harness).enabled).toBe(false);
    expect(harnesses.get("a")?.enabled).toBe(false);
    expect(runnerCalled).toBe(false);
    const onDisk = parse(await readFile(path, "utf8")) as { harnesses: Harness[] };
    expect(onDisk.harnesses.find((h) => h.id === "a")?.enabled).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /harnesses/:id/enable re-validates first — succeeds and clears disabledReason when still authenticated", async () => {
  const { dir, path } = await harnessesFixture("harnesses:\n  - id: a\n    tool: claude-cli\n    label: A\n    enabled: false\n    disabledReason: not authenticated\n");
  try {
    const harnesses = HarnessPool.from([{ id: "a", tool: "claude-cli", label: "A", enabled: false, disabledReason: "not authenticated" }]);
    const runner: CommandRunner = async () => ({ stdout: JSON.stringify({ loggedIn: true }), stderr: "", exitCode: 0 });
    const app = await makeApp(new SqliteBoard(), { harnesses, harnessesPath: path, harnessRunner: runner });

    const res = await app(req("/harnesses/a/enable", { method: "POST" }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as Harness;
    expect(body.enabled).toBe(true);
    expect(body.disabledReason).toBeUndefined();
    expect(harnesses.get("a")?.enabled).toBe(true);
    const onDisk = parse(await readFile(path, "utf8")) as { harnesses: Harness[] };
    expect(onDisk.harnesses.find((h) => h.id === "a")?.enabled).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /harnesses/:id/enable refuses with 409 when still not authenticated, and never touches harnesses.yaml", async () => {
  const { dir, path } = await harnessesFixture("harnesses:\n  - id: a\n    tool: claude-cli\n    label: A\n    enabled: false\n");
  const before = await readFile(path, "utf8");
  try {
    const harnesses = HarnessPool.from([{ id: "a", tool: "claude-cli", label: "A", enabled: false }]);
    const runner: CommandRunner = async () => ({ stdout: JSON.stringify({ loggedIn: false }), stderr: "", exitCode: 0 });
    const app = await makeApp(new SqliteBoard(), { harnesses, harnessesPath: path, harnessRunner: runner });

    const res = await app(req("/harnesses/a/enable", { method: "POST" }));

    expect(res.status).toBe(409);
    expect(harnesses.get("a")?.enabled).toBe(false);
    expect(harnesses.get("a")?.disabledReason).toBe("not authenticated");
    expect(await readFile(path, "utf8")).toBe(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /harnesses/:id/enable and /disable 404 for an unknown id", async () => {
  const app = await makeApp(new SqliteBoard(), { harnesses: HarnessPool.from([]) });
  expect((await app(req("/harnesses/missing/enable", { method: "POST" }))).status).toBe(404);
  expect((await app(req("/harnesses/missing/disable", { method: "POST" }))).status).toBe(404);
});

test("POST /harnesses/:id/model sets, rejects an invalid model with 400, clears with null, and 404s on unknown id", async () => {
  const { dir, path: harnessesPath } = await harnessesFixture("harnesses:\n  - id: a\n    tool: claude-cli\n    label: A\n    enabled: true\n");
  try {
    const modelsCachePath = join(dir, "models-cache.json");
    await writeFile(
      modelsCachePath,
      JSON.stringify({ a: { models: ["claude-sonnet-5", "claude-opus-5"], fetchedAt: new Date().toISOString() } }),
    );
    const harnesses = HarnessPool.from([{ id: "a", tool: "claude-cli", label: "A", enabled: true }]);
    const app = await makeApp(new SqliteBoard(), { harnesses, harnessesPath, modelsCachePath });

    // Invalid model against a harness with a non-empty known list: 400,
    // never persisted.
    const invalid = await app(req("/harnesses/a/model", { method: "POST", body: JSON.stringify({ model: "not-a-real-model" }) }));
    expect(invalid.status).toBe(400);
    expect(harnesses.get("a")?.model).toBeUndefined();

    // Valid model: 200, persisted to disk and in memory.
    const res = await app(req("/harnesses/a/model", { method: "POST", body: JSON.stringify({ model: "claude-opus-5" }) }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Harness).model).toBe("claude-opus-5");
    expect(harnesses.get("a")?.model).toBe("claude-opus-5");
    const onDisk = parse(await readFile(harnessesPath, "utf8")) as { harnesses: Harness[] };
    expect(onDisk.harnesses.find((h) => h.id === "a")?.model).toBe("claude-opus-5");

    // null clears the override back to the agent default.
    const cleared = await app(req("/harnesses/a/model", { method: "POST", body: JSON.stringify({ model: null }) }));
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as Harness).model).toBeUndefined();
    expect(harnesses.get("a")?.model).toBeUndefined();
    const onDiskAfterClear = parse(await readFile(harnessesPath, "utf8")) as { harnesses: Harness[] };
    expect(onDiskAfterClear.harnesses.find((h) => h.id === "a")?.model).toBeUndefined();

    const missing = await app(req("/harnesses/missing/model", { method: "POST", body: JSON.stringify({ model: "claude-opus-5" }) }));
    expect(missing.status).toBe(404);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /harnesses/:id/model accepts any model unvalidated when the harness has no cached availableModels yet", async () => {
  const { dir, path: harnessesPath } = await harnessesFixture("harnesses:\n  - id: a\n    tool: claude-cli\n    label: A\n    enabled: true\n");
  try {
    const harnesses = HarnessPool.from([{ id: "a", tool: "claude-cli", label: "A", enabled: true }]);
    // modelsCachePath deliberately points at a file that doesn't exist —
    // a cache-miss, never refreshed yet.
    const app = await makeApp(new SqliteBoard(), { harnesses, harnessesPath, modelsCachePath: join(dir, "no-such-cache.json") });

    const res = await app(req("/harnesses/a/model", { method: "POST", body: JSON.stringify({ model: "anything-goes" }) }));
    expect(res.status).toBe(200);
    expect(harnesses.get("a")?.model).toBe("anything-goes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function mcpServersFixture(content: string): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "wissel-api-mcp-servers-test-"));
  const path = join(dir, "mcp-servers.yaml");
  await writeFile(path, content);
  return { dir, path };
}

test("GET /mcp-servers defaults to empty, and returns configured servers with a live activeCount", async () => {
  const empty = await makeApp();
  expect(await (await empty(req("/mcp-servers"))).json()).toEqual([]);

  const mcpServers = McpServerPool.from([
    { id: "a", label: "A", transport: { kind: "stdio", command: "/bin/true", args: [] }, tools: [], enabled: true },
  ]);
  const withServer = await makeApp(new SqliteBoard(), { mcpServers });
  const res = await withServer(req("/mcp-servers"));
  const body = (await res.json()) as (McpServer & { activeCount: number })[];
  expect(body).toHaveLength(1);
  expect(body[0]!.id).toBe("a");
  expect(body[0]!.activeCount).toBe(0);
});

test("POST /mcp-servers/:id/disable persists to mcp-servers.yaml and updates the live pool, no re-validation needed", async () => {
  const { dir, path } = await mcpServersFixture(
    "mcp-servers:\n  - id: a\n    label: A\n    enabled: true\n    transport:\n      kind: stdio\n      command: /bin/true\n      args: []\n    tools: []\n",
  );
  try {
    const mcpServers = McpServerPool.from([
      { id: "a", label: "A", transport: { kind: "stdio", command: "/bin/true", args: [] }, tools: [], enabled: true },
    ]);
    let fetchCalled = false;
    const app = await makeApp(new SqliteBoard(), {
      mcpServers,
      mcpServersPath: path,
      mcpServerReachabilityOpts: { fetchImpl: (async () => { fetchCalled = true; return new Response(null, { status: 200 }); }) as unknown as typeof fetch },
    });

    const res = await app(req("/mcp-servers/a/disable", { method: "POST" }));

    expect(res.status).toBe(200);
    expect(((await res.json()) as McpServer).enabled).toBe(false);
    expect(mcpServers.get("a")?.enabled).toBe(false);
    expect(fetchCalled).toBe(false);
    const onDisk = parse(await readFile(path, "utf8")) as { "mcp-servers": McpServer[] };
    expect(onDisk["mcp-servers"].find((s) => s.id === "a")?.enabled).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /mcp-servers/:id/enable re-validates first — succeeds and clears disabledReason when reachable", async () => {
  const { dir, path } = await mcpServersFixture(
    "mcp-servers:\n  - id: a\n    label: A\n    enabled: false\n    disabledReason: not reachable\n    transport:\n      kind: stdio\n      command: /bin/true\n      args: []\n    tools: []\n",
  );
  try {
    const mcpServers = McpServerPool.from([
      { id: "a", label: "A", transport: { kind: "stdio", command: "/bin/true", args: [] }, tools: [], enabled: false, disabledReason: "not reachable" },
    ]);
    const app = await makeApp(new SqliteBoard(), { mcpServers, mcpServersPath: path });

    const res = await app(req("/mcp-servers/a/enable", { method: "POST" }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as McpServer;
    expect(body.enabled).toBe(true);
    expect(body.disabledReason).toBeUndefined();
    expect(mcpServers.get("a")?.enabled).toBe(true);
    const onDisk = parse(await readFile(path, "utf8")) as { "mcp-servers": McpServer[] };
    expect(onDisk["mcp-servers"].find((s) => s.id === "a")?.enabled).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /mcp-servers/:id/enable refuses with 409 when still not reachable, and never touches mcp-servers.yaml", async () => {
  const { dir, path } = await mcpServersFixture(
    "mcp-servers:\n  - id: a\n    label: A\n    enabled: false\n    transport:\n      kind: stdio\n      command: /no/such/binary\n      args: []\n    tools: []\n",
  );
  const before = await readFile(path, "utf8");
  try {
    const mcpServers = McpServerPool.from([
      { id: "a", label: "A", transport: { kind: "stdio", command: "/no/such/binary", args: [] }, tools: [], enabled: false },
    ]);
    const app = await makeApp(new SqliteBoard(), { mcpServers, mcpServersPath: path });

    const res = await app(req("/mcp-servers/a/enable", { method: "POST" }));

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("/no/such/binary");
    expect(mcpServers.get("a")?.enabled).toBe(false);
    expect(mcpServers.get("a")?.disabledReason).toContain("/no/such/binary");
    expect(await readFile(path, "utf8")).toBe(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /mcp-servers/:id/enable and /disable 404 for an unknown id", async () => {
  const app = await makeApp(new SqliteBoard(), { mcpServers: McpServerPool.from([]) });
  expect((await app(req("/mcp-servers/missing/enable", { method: "POST" }))).status).toBe(404);
  expect((await app(req("/mcp-servers/missing/disable", { method: "POST" }))).status).toBe(404);
});

test("POST /mcp-servers/:id/tools/:tool/trust persists to mcp-servers.yaml and updates the live pool", async () => {
  const { dir, path } = await mcpServersFixture(
    "mcp-servers:\n  - id: a\n    label: A\n    enabled: true\n    transport:\n      kind: stdio\n      command: /bin/true\n      args: []\n    tools:\n      - name: foo\n        trust: approval-required\n",
  );
  try {
    const mcpServers = McpServerPool.from([
      {
        id: "a",
        label: "A",
        transport: { kind: "stdio", command: "/bin/true", args: [] },
        tools: [{ name: "foo", trust: "approval-required" }],
        enabled: true,
      },
    ]);
    const app = await makeApp(new SqliteBoard(), { mcpServers, mcpServersPath: path });

    const res = await app(
      req("/mcp-servers/a/tools/foo/trust", { method: "POST", body: JSON.stringify({ trust: "auto" }) }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as McpServer;
    expect(body.tools).toEqual([{ name: "foo", trust: "auto" }]);
    expect(mcpServers.get("a")?.tools).toEqual([{ name: "foo", trust: "auto" }]);
    const onDisk = parse(await readFile(path, "utf8")) as { "mcp-servers": McpServer[] };
    expect(onDisk["mcp-servers"].find((s) => s.id === "a")?.tools).toEqual([{ name: "foo", trust: "auto" }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /mcp-servers/:id/tools/:tool/trust 404s for an unknown server id, and 404s for an unknown tool on a known server", async () => {
  const mcpServers = McpServerPool.from([
    { id: "a", label: "A", transport: { kind: "stdio", command: "/bin/true", args: [] }, tools: [{ name: "foo", trust: "auto" }], enabled: true },
  ]);
  const app = await makeApp(new SqliteBoard(), { mcpServers });

  const missingServer = await app(
    req("/mcp-servers/missing/tools/foo/trust", { method: "POST", body: JSON.stringify({ trust: "auto" }) }),
  );
  expect(missingServer.status).toBe(404);

  const missingTool = await app(
    req("/mcp-servers/a/tools/missing-tool/trust", { method: "POST", body: JSON.stringify({ trust: "auto" }) }),
  );
  expect(missingTool.status).toBe(404);
});

test("POST /mcp-servers/:id/tools/:tool/trust 400s on an invalid trust value and never touches mcp-servers.yaml", async () => {
  const { dir, path } = await mcpServersFixture(
    "mcp-servers:\n  - id: a\n    label: A\n    enabled: true\n    transport:\n      kind: stdio\n      command: /bin/true\n      args: []\n    tools:\n      - name: foo\n        trust: auto\n",
  );
  const before = await readFile(path, "utf8");
  try {
    const mcpServers = McpServerPool.from([
      { id: "a", label: "A", transport: { kind: "stdio", command: "/bin/true", args: [] }, tools: [{ name: "foo", trust: "auto" }], enabled: true },
    ]);
    const app = await makeApp(new SqliteBoard(), { mcpServers, mcpServersPath: path });

    const res = await app(
      req("/mcp-servers/a/tools/foo/trust", { method: "POST", body: JSON.stringify({ trust: "not-a-real-trust-value" }) }),
    );

    expect(res.status).toBe(400);
    expect(mcpServers.get("a")?.tools).toEqual([{ name: "foo", trust: "auto" }]);
    expect(await readFile(path, "utf8")).toBe(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- POST /mcp-servers (create) ---

test("POST /mcp-servers registers a well-formed stdio entry — persists, shows up in GET, survives a fresh load from disk", async () => {
  const { dir, path } = await mcpServersFixture("mcp-servers: []\n");
  try {
    const mcpServers = McpServerPool.from([]);
    const app = await makeApp(new SqliteBoard(), { mcpServers, mcpServersPath: path });

    const res = await app(
      req("/mcp-servers", {
        method: "POST",
        body: JSON.stringify({
          id: "new-stdio",
          label: "New Stdio Server",
          transport: { kind: "stdio", command: "/bin/true", args: [] },
          tools: [{ name: "do_thing", trust: "approval-required" }],
        }),
      }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as McpServer;
    expect(body.id).toBe("new-stdio");
    expect(mcpServers.get("new-stdio")?.enabled).toBe(true);

    const listRes = await app(req("/mcp-servers"));
    const list = (await listRes.json()) as (McpServer & { activeCount: number })[];
    expect(list.find((s) => s.id === "new-stdio")).toBeTruthy();

    const reloaded = await McpServerPool.load(path);
    expect(reloaded.get("new-stdio")?.transport).toEqual({ kind: "stdio", command: "/bin/true", args: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /mcp-servers registers a well-formed sse/http entry via a mocked reachable fetch", async () => {
  const { dir, path } = await mcpServersFixture("mcp-servers: []\n");
  try {
    const mcpServers = McpServerPool.from([]);
    const fetchImpl = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const app = await makeApp(new SqliteBoard(), {
      mcpServers,
      mcpServersPath: path,
      mcpServerReachabilityOpts: { fetchImpl },
    });

    const res = await app(
      req("/mcp-servers", {
        method: "POST",
        body: JSON.stringify({
          id: "new-http",
          label: "New HTTP Server",
          transport: { kind: "http", url: "https://example.internal/mcp" },
        }),
      }),
    );

    expect(res.status).toBe(201);
    expect(mcpServers.get("new-http")?.transport).toEqual({ kind: "http", url: "https://example.internal/mcp" });
    const onDisk = parse(await readFile(path, "utf8")) as { "mcp-servers": McpServer[] };
    expect(onDisk["mcp-servers"].find((s) => s.id === "new-http")).toBeTruthy();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /mcp-servers 400s on a malformed body (missing transport.command for stdio) and never touches mcp-servers.yaml", async () => {
  const { dir, path } = await mcpServersFixture("mcp-servers: []\n");
  const before = await readFile(path, "utf8");
  try {
    const mcpServers = McpServerPool.from([]);
    const app = await makeApp(new SqliteBoard(), { mcpServers, mcpServersPath: path });

    const res = await app(
      req("/mcp-servers", {
        method: "POST",
        body: JSON.stringify({ id: "bad", label: "Bad", transport: { kind: "stdio" } }),
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("transport.command is required for a stdio server");
    expect(mcpServers.get("bad")).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /mcp-servers 400s on a duplicate id and never touches mcp-servers.yaml", async () => {
  const { dir, path } = await mcpServersFixture(
    "mcp-servers:\n  - id: a\n    label: A\n    enabled: true\n    transport:\n      kind: stdio\n      command: /bin/true\n      args: []\n    tools: []\n",
  );
  const before = await readFile(path, "utf8");
  try {
    const mcpServers = McpServerPool.from([
      { id: "a", label: "A", transport: { kind: "stdio", command: "/bin/true", args: [] }, tools: [], enabled: true },
    ]);
    const app = await makeApp(new SqliteBoard(), { mcpServers, mcpServersPath: path });

    const res = await app(
      req("/mcp-servers", {
        method: "POST",
        body: JSON.stringify({ id: "a", label: "A (again)", transport: { kind: "stdio", command: "/bin/true", args: [] } }),
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("already registered");
    expect(await readFile(path, "utf8")).toBe(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /mcp-servers 400s when the stdio command isn't reachable (not on PATH) and never persists it — proves creation re-validates, doesn't just trust the body", async () => {
  const { dir, path } = await mcpServersFixture("mcp-servers: []\n");
  const before = await readFile(path, "utf8");
  try {
    const mcpServers = McpServerPool.from([]);
    const app = await makeApp(new SqliteBoard(), { mcpServers, mcpServersPath: path });

    const res = await app(
      req("/mcp-servers", {
        method: "POST",
        body: JSON.stringify({
          id: "unreachable",
          label: "Unreachable",
          transport: { kind: "stdio", command: "/no/such/binary", args: [] },
        }),
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("/no/such/binary");
    expect(mcpServers.get("unreachable")).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /tasks then GET /tasks round-trips, defaulting dependsOn to []", async () => {
  const app = await makeApp();
  const create = await app(
    req("/tasks", {
      method: "POST",
      body: JSON.stringify({ title: "t", body: "b", labels: ["x"], repo: "r" }),
    }),
  );
  expect(create.status).toBe(201);
  const created = (await create.json()) as TaskCard;
  expect(created.status).toBe("inbox");
  expect(created.dependsOn).toEqual([]);

  const list = await app(req("/tasks"));
  expect(await list.json()).toEqual([created]);

  const single = await app(req(`/tasks/${created.id}`));
  expect(await single.json()).toEqual(created);
});

test("POST /tasks accepts a valid harnessOverride+model, 400s on an invalid model against a known harness, 400s on an unknown harnessOverride, and accepts an unvalidated model with no harnessOverride", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-api-tasks-model-test-"));
  try {
    const modelsCachePath = join(dir, "models-cache.json");
    await writeFile(
      modelsCachePath,
      JSON.stringify({ a: { models: ["claude-sonnet-5", "claude-opus-5"], fetchedAt: new Date().toISOString() } }),
    );
    const harnesses = HarnessPool.from([{ id: "a", tool: "claude-cli", label: "A", enabled: true }]);
    const app = await makeApp(new SqliteBoard(), { harnesses, modelsCachePath });

    // Valid harnessOverride + a model that's in that harness's cached list.
    const ok = await app(
      req("/tasks", {
        method: "POST",
        body: JSON.stringify({ title: "t", body: "", labels: [], repo: "r", harnessOverride: "a", model: "claude-opus-5" }),
      }),
    );
    expect(ok.status).toBe(201);
    const okTask = (await ok.json()) as TaskCard;
    expect(okTask.harnessOverride).toBe("a");
    expect(okTask.model).toBe("claude-opus-5");

    // Invalid model against a known harness: 400, never created.
    const invalidModel = await app(
      req("/tasks", {
        method: "POST",
        body: JSON.stringify({ title: "t2", body: "", labels: [], repo: "r", harnessOverride: "a", model: "not-a-real-model" }),
      }),
    );
    expect(invalidModel.status).toBe(400);

    // Unknown harnessOverride id: 400, never created.
    const unknownHarness = await app(
      req("/tasks", {
        method: "POST",
        body: JSON.stringify({ title: "t3", body: "", labels: [], repo: "r", harnessOverride: "does-not-exist" }),
      }),
    );
    expect(unknownHarness.status).toBe(400);

    // A model with no harnessOverride is accepted unvalidated — the
    // harness/tool isn't known until routing runs.
    const modelOnly = await app(
      req("/tasks", {
        method: "POST",
        body: JSON.stringify({ title: "t4", body: "", labels: [], repo: "r", model: "totally-made-up-model" }),
      }),
    );
    expect(modelOnly.status).toBe(201);
    const modelOnlyTask = (await modelOnly.json()) as TaskCard;
    expect(modelOnlyTask.model).toBe("totally-made-up-model");
    expect(modelOnlyTask.harnessOverride).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- optional repo / scratch workspace (docs/SDD-mcp-orchestration.md §3.3/§4, Subtask 5) ---

test("POST /tasks with no repo and labels that resolve to a write/bash-capable agent 400s with a clear error, and never creates the task", async () => {
  const board = new SqliteBoard();
  const app = await makeApp(board);

  const res = await app(
    req("/tasks", {
      method: "POST",
      body: JSON.stringify({ title: "fix the bug", body: "", labels: ["code", "typescript"] }),
    }),
  );

  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(body.error).toContain("repo is required");
  expect(body.error).toContain("implementer");
  expect(await board.list()).toEqual([]);
});

test("POST /tasks with no repo and labels that resolve to a readonly, no-file-access agent succeeds with repo left undefined", async () => {
  const app = await makeApp();

  const res = await app(
    req("/tasks", {
      method: "POST",
      body: JSON.stringify({ title: "triage this", body: "raw input", labels: ["intake", "unstructured"] }),
    }),
  );

  expect(res.status).toBe(201);
  const task = (await res.json()) as TaskCard;
  expect(task.repo).toBeUndefined();
});

// Ambiguous/no-match labels at creation time are allowed through without
// a repo — Orchestrator.process's own write/bash-access check is the
// dispatch-time safety net if a later label edit routes it to a
// write-tier agent (see orchestrator.ts).
test("POST /tasks with no repo and labels that don't confidently resolve to anything succeeds without a repo", async () => {
  const app = await makeApp();

  const res = await app(
    req("/tasks", {
      method: "POST",
      body: JSON.stringify({ title: "ambiguous", body: "", labels: ["totally-unknown-label"] }),
    }),
  );

  expect(res.status).toBe(201);
  const task = (await res.json()) as TaskCard;
  expect(task.repo).toBeUndefined();
});

// Regression: every existing repo-supplied creation path (write-tier and
// readonly alike) is completely unaffected by the no-repo validation
// above.
test("POST /tasks with a real repo is unaffected regardless of which agent the labels resolve to", async () => {
  const app = await makeApp();

  const writeTier = await app(
    req("/tasks", { method: "POST", body: JSON.stringify({ title: "fix the bug", body: "", labels: ["code", "typescript"], repo: "/real/repo" }) }),
  );
  expect(writeTier.status).toBe(201);
  expect(((await writeTier.json()) as TaskCard).repo).toBe("/real/repo");

  const readonlyTier = await app(
    req("/tasks", { method: "POST", body: JSON.stringify({ title: "triage this", body: "", labels: ["intake", "unstructured"], repo: "/real/repo" }) }),
  );
  expect(readonlyTier.status).toBe(201);
  expect(((await readonlyTier.json()) as TaskCard).repo).toBe("/real/repo");
});

test("GET /tasks?status=escalated finds an escalated task — the human queue for a review-pushback lineage that hit its limit", async () => {
  const board = new SqliteBoard();
  const app = await makeApp(board);

  const other = (await (
    await app(req("/tasks", { method: "POST", body: JSON.stringify({ title: "not escalated", body: "", labels: [], repo: "r" }) }))
  ).json()) as TaskCard;
  const escalatee = await board.create({ title: "escalated one", body: "", labels: ["code"], repo: "r" });
  await board.escalate(escalatee.id, "Attempt 1: still broken\n\nAttempt 2: still broken");

  const res = await app(req("/tasks?status=escalated"));
  const tasks = (await res.json()) as TaskCard[];
  expect(tasks.map((t) => t.id)).toEqual([escalatee.id]);
  expect(tasks[0]!.escalationContext).toBe("Attempt 1: still broken\n\nAttempt 2: still broken");
  expect(tasks.some((t) => t.id === other.id)).toBe(false);
});

test("GET /tasks/:id 404s for unknown id", async () => {
  const app = await makeApp();
  const res = await app(req("/tasks/nope"));
  expect(res.status).toBe(404);
});

test("GET /render-task-output.js serves the pure render function as a static script", async () => {
  const app = await makeApp();
  const res = await app(req("/render-task-output.js"));
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain("function renderTaskOutputRows");
});

test("GET /tasks/:id/output 404s for an unknown task, and returns accumulated lines for a known one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-task-output-api-test-"));
  try {
    const board = new SqliteBoard();
    const app = await makeApp(board, { taskOutputDir: dir });
    const task = await board.create({ title: "t", body: "", labels: [], repo: "r" });

    const missing = await app(req("/tasks/nope/output"));
    expect(missing.status).toBe(404);

    const empty = await app(req(`/tasks/${task.id}/output`));
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ taskId: task.id, lines: [] });

    const { appendTaskOutput } = await import("../src/services/task-output.ts");
    await appendTaskOutput(task.id, { type: "system", subtype: "init" }, dir);
    await appendTaskOutput(task.id, { type: "result", subtype: "success", is_error: false, result: "done" }, dir);

    const populated = await app(req(`/tasks/${task.id}/output`));
    expect(populated.status).toBe(200);
    const body = (await populated.json()) as { taskId: string; lines: string[] };
    expect(body.taskId).toBe(task.id);
    expect(body.lines.map((l) => JSON.parse(l))).toEqual([
      { type: "system", subtype: "init" },
      { type: "result", subtype: "success", is_error: false, result: "done" },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GET /tasks/:id/output/stream 404s for an unknown task", async () => {
  const app = await makeApp();
  const res = await app(req("/tasks/nope/output/stream"));
  expect(res.status).toBe(404);
});

test("GET /tasks/:id/output/stream delivers chunks live as they're appended, sends the ring-buffer backlog on connect, and ends with event: done when the task's TaskResult lands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-task-output-api-test-"));
  try {
    const board = new SqliteBoard();
    const app = await makeApp(board, { taskOutputDir: dir });
    const task = await board.create({ title: "t", body: "", labels: [], repo: "r" });

    const { appendTaskOutput } = await import("../src/services/task-output.ts");
    // Written before the stream connects — must still arrive as backlog.
    await appendTaskOutput(task.id, { type: "system", subtype: "init" }, dir);

    const sse = await app(req(`/tasks/${task.id}/output/stream`));
    expect(sse.status).toBe(200);
    expect(sse.headers.get("content-type")).toContain("text/event-stream");
    const reader = sse.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";

    async function readUntil(marker: string): Promise<void> {
      while (!buffered.includes(marker)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`stream ended before seeing ${JSON.stringify(marker)}`);
        buffered += decoder.decode(value);
      }
    }

    await readUntil(JSON.stringify({ type: "system", subtype: "init" }));

    // A chunk appended after the connection is already open must also
    // arrive live, not just the pre-connect backlog.
    await appendTaskOutput(task.id, { type: "stream_event", event: { type: "message_start" } }, dir);
    await readUntil(JSON.stringify({ type: "stream_event", event: { type: "message_start" } }));

    // The task's own result landing is the signal the stream is over —
    // not any particular JSONL line's content.
    await board.recordResult({ taskId: task.id, agentId: "implementer", ok: true, summary: "done" });
    await readUntil("event: done");

    const done = await reader.read();
    expect(done.done).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /tasks/:id/move updates status, 404s on unknown id", async () => {
  const app = await makeApp();
  const create = await app(
    req("/tasks", { method: "POST", body: JSON.stringify({ title: "t", body: "", labels: [], repo: "r" }) }),
  );
  const created = (await create.json()) as TaskCard;

  const move = await app(req(`/tasks/${created.id}/move`, { method: "POST", body: JSON.stringify({ status: "running" }) }));
  expect(((await move.json()) as TaskCard).status).toBe("running");

  const missing = await app(req("/tasks/nope/move", { method: "POST", body: JSON.stringify({ status: "done" }) }));
  expect(missing.status).toBe(404);
});

test("POST /tasks/:id/archive returns every card touched by the cascade, 404s on unknown id, and fans out one task.archived event over SSE", async () => {
  const board = new SqliteBoard();
  const app = await makeApp(board);
  const root = await board.create({ title: "root", body: "", labels: [], repo: "r" });
  const child = await board.create({ title: "child", body: "", labels: [], repo: "r", parentTaskId: root.id });

  const sse = await app(req("/events"));
  const reader = sse.body!.getReader();
  await reader.read(); // ": connected" preamble

  const res = await app(req(`/tasks/${root.id}/archive`, { method: "POST" }));
  expect(res.status).toBe(200);
  const touched = (await res.json()) as TaskCard[];
  expect(touched.map((t) => t.id).sort()).toEqual([root.id, child.id].sort());
  touched.forEach((t) => expect(t.archivedAt).toBeDefined());

  const decoder = new TextDecoder();
  const chunk = decoder.decode((await reader.read()).value);
  expect(chunk).toContain("task.archived");
  await reader.cancel();

  const missing = await app(req("/tasks/nope/archive", { method: "POST" }));
  expect(missing.status).toBe(404);
});

test("POST /tasks/:id/unarchive returns the single restored card, 404s on unknown id, and fans out task.unarchived over SSE", async () => {
  const board = new SqliteBoard();
  const app = await makeApp(board);
  const task = await board.create({ title: "t", body: "", labels: [], repo: "r" });
  await board.archive(task.id);

  const sse = await app(req("/events"));
  const reader = sse.body!.getReader();
  await reader.read(); // ": connected" preamble

  const res = await app(req(`/tasks/${task.id}/unarchive`, { method: "POST" }));
  expect(res.status).toBe(200);
  const restored = (await res.json()) as TaskCard;
  expect(restored.id).toBe(task.id);
  expect(restored.archivedAt).toBeUndefined();

  const decoder = new TextDecoder();
  const chunk = decoder.decode((await reader.read()).value);
  expect(chunk).toContain("task.unarchived");
  await reader.cancel();

  const missing = await app(req("/tasks/nope/unarchive", { method: "POST" }));
  expect(missing.status).toBe(404);
});

// Off by default, matching every other opt-in scheduler flag
// (WISSEL_ORCHESTRATOR, WISSEL_MEMORY_CURATION) — createApp must never
// start the auto-archive scheduler unless autoArchiveEnabled is set, even
// with a real done-and-old-enough root sitting on the board.
test("createApp never starts the auto-archive scheduler unless autoArchiveEnabled is set", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-api-archive-off-test-"));
  try {
    const dbPath = join(dir, "board.sqlite");
    const board = new SqliteBoard(dbPath);
    const root = await board.create({ title: "root", body: "", labels: [], repo: "r" });
    await board.move(root.id, "done");
    const legacyDb = new Database(dbPath);
    legacyDb.run("UPDATE tasks SET doneAt = ? WHERE id = ?", [new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), root.id]);
    legacyDb.close();

    await makeApp(board); // autoArchiveEnabled not set — the scheduler must never start
    await new Promise((r) => setTimeout(r, 100));
    expect((await board.get(root.id))!.archivedAt).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createApp starts the auto-archive scheduler when autoArchiveEnabled is set, and it archives an eligible root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-api-archive-on-test-"));
  try {
    const dbPath = join(dir, "board.sqlite");
    const board = new SqliteBoard(dbPath);
    const root = await board.create({ title: "root", body: "", labels: [], repo: "r" });
    await board.move(root.id, "done");
    const legacyDb = new Database(dbPath);
    legacyDb.run("UPDATE tasks SET doneAt = ? WHERE id = ?", [new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), root.id]);
    legacyDb.close();

    await makeApp(board, { autoArchiveEnabled: true }); // ticks immediately, per startArchiveScheduler's own doc comment

    const deadline = Date.now() + 1000;
    let archivedAt: string | undefined;
    while (Date.now() < deadline) {
      archivedAt = (await board.get(root.id))!.archivedAt;
      if (archivedAt) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(archivedAt).toBeDefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Off by default, matching every other opt-in scheduler flag — GET
// /merge-health must report [] (not an error) when mergeHealthEnabled
// was never set, same "empty, not broken" contract GET /harnesses
// already holds for a cache-miss.
test("GET /merge-health returns [] when mergeHealthEnabled is unset", async () => {
  const app = await makeApp();
  const res = await app(req("/merge-health"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual([]);
});

test("GET /merge-health returns the merge-health scheduler's real detected set — a real dangling merge and a clean repo", async () => {
  const conflict = await mkdtemp(join(tmpdir(), "wissel-api-merge-health-conflict-"));
  const clean = await mkdtemp(join(tmpdir(), "wissel-api-merge-health-clean-"));
  try {
    const gitSync = (args: string[], cwd: string) => Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    gitSync(["init", "-q", "-b", "main"], conflict);
    gitSync(["config", "user.email", "wissel-test@example.com"], conflict);
    gitSync(["config", "user.name", "wissel test"], conflict);
    await writeFile(join(conflict, "file.txt"), "main line\n");
    gitSync(["add", "-A"], conflict);
    gitSync(["commit", "-q", "-m", "seed"], conflict);
    gitSync(["checkout", "-q", "-b", "feature"], conflict);
    await writeFile(join(conflict, "file.txt"), "feature line\n");
    gitSync(["commit", "-q", "-am", "feature change"], conflict);
    gitSync(["checkout", "-q", "main"], conflict);
    await writeFile(join(conflict, "file.txt"), "main line, changed\n");
    gitSync(["commit", "-q", "-am", "main change"], conflict);
    const merge = gitSync(["merge", "feature"], conflict);
    if (merge.exitCode === 0) throw new Error("test fixture bug: merge was expected to conflict but succeeded");

    gitSync(["init", "-q", "-b", "main"], clean);
    gitSync(["config", "user.email", "wissel-test@example.com"], clean);
    gitSync(["config", "user.name", "wissel test"], clean);
    gitSync(["commit", "-q", "--allow-empty", "-m", "seed"], clean);

    const board = new SqliteBoard();
    await board.create({ title: "conflicted", body: "", labels: [], repo: conflict });
    await board.create({ title: "clean", body: "", labels: [], repo: clean });

    const app = await makeApp(board, { mergeHealthEnabled: true, mergeHealthIntervalHours: 24 });

    const deadline = Date.now() + 2000;
    let body: unknown = [];
    while (Date.now() < deadline) {
      body = await (await app(req("/merge-health"))).json();
      if (Array.isArray(body) && body.length > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(body).toEqual([{ repo: conflict, branch: "feature" }]);
  } finally {
    await rm(conflict, { recursive: true, force: true });
    await rm(clean, { recursive: true, force: true });
  }
});

test("DELETE /tasks/:id removes the task, 404s on unknown id", async () => {
  const app = await makeApp();
  const created = (await (await app(req("/tasks", { method: "POST", body: JSON.stringify({ title: "t", body: "", labels: [], repo: "r" }) }))).json()) as TaskCard;

  const del = await app(req(`/tasks/${created.id}`, { method: "DELETE" }));
  expect(del.status).toBe(204);
  expect((await app(req(`/tasks/${created.id}`))).status).toBe(404);

  const missing = await app(req("/tasks/nope", { method: "DELETE" }));
  expect(missing.status).toBe(404);
});

test("POST /tasks/:id/depends-on updates dependsOn, 404s on unknown id", async () => {
  const app = await makeApp();
  const a = (await (await app(req("/tasks", { method: "POST", body: JSON.stringify({ title: "a", body: "", labels: [], repo: "r" }) }))).json()) as TaskCard;
  const b = (await (await app(req("/tasks", { method: "POST", body: JSON.stringify({ title: "b", body: "", labels: [], repo: "r" }) }))).json()) as TaskCard;

  const dep = await app(req(`/tasks/${b.id}/depends-on`, { method: "POST", body: JSON.stringify({ dependsOn: [a.id] }) }));
  expect(((await dep.json()) as TaskCard).dependsOn).toEqual([a.id]);

  const missing = await app(req("/tasks/nope/depends-on", { method: "POST", body: JSON.stringify({ dependsOn: [] }) }));
  expect(missing.status).toBe(404);
});

test("POST /tasks/:id/decision, /result, /override return 204 and fan out over SSE", async () => {
  const board = new SqliteBoard();
  const app = await makeApp(board);
  const create = await app(
    req("/tasks", { method: "POST", body: JSON.stringify({ title: "t", body: "", labels: [], repo: "r" }) }),
  );
  const created = (await create.json()) as TaskCard;

  const sse = await app(req("/events"));
  const reader = sse.body!.getReader();
  await reader.read(); // ": connected" preamble

  const decision = await app(
    req(`/tasks/${created.id}/decision`, {
      method: "POST",
      body: JSON.stringify({
        matchedTags: [],
        candidates: [],
        selected: "a",
        confident: true,
        reason: "r",
        strategy: "rule",
        decidedAt: new Date().toISOString(),
      }),
    }),
  );
  expect(decision.status).toBe(204);

  const result = await app(
    req(`/tasks/${created.id}/result`, {
      method: "POST",
      body: JSON.stringify({ agentId: "a", ok: true, summary: "done" }),
    }),
  );
  expect(result.status).toBe(204);

  const override = await app(
    req(`/tasks/${created.id}/override`, {
      method: "POST",
      body: JSON.stringify({ routerPick: "a", humanPick: "b" }),
    }),
  );
  expect(override.status).toBe(204);

  const decoder = new TextDecoder();
  const chunk = decoder.decode((await reader.read()).value);
  expect(chunk).toContain("task.decided");
  await reader.cancel();
});

test("GET /tasks/:id/decision returns the recorded decision, 404s with none", async () => {
  const app = await makeApp();
  const create = await app(
    req("/tasks", { method: "POST", body: JSON.stringify({ title: "t", body: "", labels: [], repo: "r" }) }),
  );
  const created = (await create.json()) as TaskCard;

  const before = await app(req(`/tasks/${created.id}/decision`));
  expect(before.status).toBe(404);

  await app(
    req(`/tasks/${created.id}/decision`, {
      method: "POST",
      body: JSON.stringify({
        matchedTags: ["x"],
        candidates: [{ agentId: "triager", score: 1, reason: "tag match" }],
        selected: "triager",
        confident: true,
        reason: "tag match",
        strategy: "rule",
        decidedAt: new Date().toISOString(),
      }),
    }),
  );

  const after = await app(req(`/tasks/${created.id}/decision`));
  expect(after.status).toBe(200);
  const decision = (await after.json()) as { selected: string; confident: boolean };
  expect(decision.selected).toBe("triager");
  expect(decision.confident).toBe(true);
});

test("POST /route/preview confidently matches real manifest tags without creating a task", async () => {
  const app = await makeApp();
  const res = await app(req("/route/preview", { method: "POST", body: JSON.stringify({ labels: ["intake"] }) }));
  expect(res.status).toBe(200);
  const decision = (await res.json()) as { selected: string; confident: boolean; candidates: unknown[] };
  expect(decision.confident).toBe(true);
  expect(decision.selected).toBe("triager");
  expect(decision.candidates.length).toBeGreaterThan(1);
});

test("POST /route/preview reports no-match without confident selection, and empty labels the same way", async () => {
  const app = await makeApp();

  const noMatch = await app(req("/route/preview", { method: "POST", body: JSON.stringify({ labels: ["totally-unknown"] }) }));
  const noMatchDecision = (await noMatch.json()) as { selected: string | null; confident: boolean };
  expect(noMatchDecision.confident).toBe(false);
  expect(noMatchDecision.selected).toBeNull();

  const empty = await app(req("/route/preview", { method: "POST", body: JSON.stringify({ labels: [] }) }));
  const emptyDecision = (await empty.json()) as { selected: string | null; confident: boolean };
  expect(emptyDecision.confident).toBe(false);
  expect(emptyDecision.selected).toBeNull();

  const missing = await app(req("/route/preview", { method: "POST", body: JSON.stringify({}) }));
  expect(missing.status).toBe(200);
});

test("POST /route/preview restricts to a routed parent's declared handoffs", async () => {
  const app = await makeApp();

  const parent = await app(
    req("/tasks", { method: "POST", body: JSON.stringify({ title: "p", body: "", labels: [], repo: "r" }) }),
  );
  const parentTask = (await parent.json()) as TaskCard;
  await app(
    req(`/tasks/${parentTask.id}/decision`, {
      method: "POST",
      body: JSON.stringify({
        matchedTags: ["intake"], candidates: [], selected: "triager", confident: true,
        reason: "r", strategy: "rule", decidedAt: new Date().toISOString(),
      }),
    }),
  );

  // "ci" matches fixer perfectly, but triager's only declared handoff is planner.
  const res = await app(
    req("/route/preview", { method: "POST", body: JSON.stringify({ labels: ["ci"], parentTaskId: parentTask.id }) }),
  );
  const decision = (await res.json()) as { selected: string | null; confident: boolean; candidates: { agentId: string }[]; reason: string };
  expect(decision.candidates.map((c) => c.agentId)).toEqual(["planner"]);
  expect(decision.confident).toBe(false);
  expect(decision.reason).toContain("restricted to declared handoffs: planner");
});

test("POST /tasks round-trips parentTaskId", async () => {
  const app = await makeApp();
  const parent = await app(
    req("/tasks", { method: "POST", body: JSON.stringify({ title: "p", body: "", labels: [], repo: "r" }) }),
  );
  const parentTask = (await parent.json()) as TaskCard;

  const child = await app(
    req("/tasks", { method: "POST", body: JSON.stringify({ title: "c", body: "", labels: [], repo: "r", parentTaskId: parentTask.id }) }),
  );
  const childTask = (await child.json()) as TaskCard;
  expect(childTask.parentTaskId).toBe(parentTask.id);

  const fetched = await app(req(`/tasks/${childTask.id}`));
  expect(((await fetched.json()) as TaskCard).parentTaskId).toBe(parentTask.id);
});

test("POST /tasks/:id/result routes a write-tier report to pending-review (implementer auto-hands-off to reviewer), a readonly one to done", async () => {
  const app = await makeApp();

  const writeTask = (await (
    await app(req("/tasks", { method: "POST", body: JSON.stringify({ title: "w", body: "", labels: [], repo: "r" }) }))
  ).json()) as TaskCard;
  await app(
    req(`/tasks/${writeTask.id}/result`, {
      method: "POST",
      body: JSON.stringify({ agentId: "implementer", ok: true, summary: "opened a PR" }),
    }),
  );
  // "implementer" declares handoffs: [reviewer] — a plain write-tier
  // agent with no such handoff still lands on "review" directly, see
  // orchestrator.test.ts's "no reviewer handoff" regression test.
  expect((await (await app(req(`/tasks/${writeTask.id}`))).json() as TaskCard).status).toBe("pending-review");

  const readonlyTask = (await (
    await app(req("/tasks", { method: "POST", body: JSON.stringify({ title: "r", body: "", labels: [], repo: "r" }) }))
  ).json()) as TaskCard;
  await app(
    req(`/tasks/${readonlyTask.id}/result`, {
      method: "POST",
      body: JSON.stringify({ agentId: "triager", ok: true, summary: "triaged" }),
    }),
  );
  expect((await (await app(req(`/tasks/${readonlyTask.id}`))).json() as TaskCard).status).toBe("done");
});

test("GET /tasks/:id/result returns the most recent result, 404s with none", async () => {
  const app = await makeApp();
  const created = (await (
    await app(req("/tasks", { method: "POST", body: JSON.stringify({ title: "t", body: "", labels: [], repo: "r" }) }))
  ).json()) as TaskCard;

  const before = await app(req(`/tasks/${created.id}/result`));
  expect(before.status).toBe(404);

  await app(req(`/tasks/${created.id}/result`, { method: "POST", body: JSON.stringify({ agentId: "triager", ok: true, summary: "triaged" }) }));

  const after = await app(req(`/tasks/${created.id}/result`));
  expect(after.status).toBe(200);
  expect(((await after.json()) as TaskResult).summary).toBe("triaged");
});

test("GET /tasks/:id/diff reports isGitRepo: false for a task whose repo isn't a git working tree, 404s on unknown id", async () => {
  const app = await makeApp();
  const created = (await (
    await app(req("/tasks", { method: "POST", body: JSON.stringify({ title: "t", body: "", labels: [], repo: "/tmp" }) }))
  ).json()) as TaskCard;

  const res = await app(req(`/tasks/${created.id}/diff`));
  expect(res.status).toBe(200);
  const diff = (await res.json()) as { isGitRepo: boolean };
  expect(diff.isGitRepo).toBe(false);

  const missing = await app(req("/tasks/nope/diff"));
  expect(missing.status).toBe(404);
});

// A repo-less task (docs/SDD-mcp-orchestration.md §3.3/§4, Subtask 5)
// never touches a filesystem at all, so there's nothing to diff — not
// just an empty one.
test("GET /tasks/:id/diff 409s for a repo-less task with no worktree", async () => {
  const app = await makeApp();
  const created = (await (
    await app(req("/tasks", { method: "POST", body: JSON.stringify({ title: "triage this", body: "", labels: ["intake", "unstructured"] }) }))
  ).json()) as TaskCard;
  expect(created.repo).toBeUndefined();

  const res = await app(req(`/tasks/${created.id}/diff`));
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toContain("no filesystem workspace");
});

test("GET /tasks/:id/mcp-calls returns [] when the task has no recorded result, the actual calls once recorded, 404s on unknown id", async () => {
  const app = await makeApp();
  const created = (await (
    await app(req("/tasks", { method: "POST", body: JSON.stringify({ title: "t", body: "", labels: [], repo: "/tmp" }) }))
  ).json()) as TaskCard;

  const beforeResult = await app(req(`/tasks/${created.id}/mcp-calls`));
  expect(beforeResult.status).toBe(200);
  expect(await beforeResult.json()).toEqual([]);

  const mcpCalls = [{ server: "slack", tool: "send_message", args: { text: "hi" }, result: "sent", ok: true }];
  await app(
    req(`/tasks/${created.id}/result`, {
      method: "POST",
      body: JSON.stringify({ agentId: "triager", ok: true, summary: "done", mcpCalls }),
    }),
  );

  const afterResult = await app(req(`/tasks/${created.id}/mcp-calls`));
  expect(afterResult.status).toBe(200);
  expect(await afterResult.json()).toEqual(mcpCalls);

  const missing = await app(req("/tasks/nope/mcp-calls"));
  expect(missing.status).toBe(404);
});

test("POST /tasks/:id/run routes and runs a task on the injected manual executor, 404s on unknown id", async () => {
  const seen: TaskCard[] = [];
  const app = await makeApp(new SqliteBoard(), {
    manualExecutors: [
      fakeWriteExecutor(async (task, agent) => {
        seen.push(task);
        return { taskId: task.id, agentId: agent.id, ok: true, summary: "opened a PR" };
      }),
    ],
  });

  const created = (await (
    await app(req("/tasks", { method: "POST", body: JSON.stringify({ title: "t", body: "", labels: ["code"], repo: "r" }) }))
  ).json()) as TaskCard;

  const run = await app(req(`/tasks/${created.id}/run`, { method: "POST" }));
  expect(run.status).toBe(202);

  // /run returns once the task is in flight, not once it's done — poll
  // for the background process() to land, same as the real board UI would.
  const deadline = Date.now() + 1000;
  let status: TaskCard["status"] = "inbox";
  while (Date.now() < deadline) {
    status = ((await (await app(req(`/tasks/${created.id}`))).json()) as TaskCard).status;
    if (status !== "inbox" && status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // "implementer" (routed via the "code" label) declares handoffs:
  // [reviewer], so a successful run lands on pending-review with an
  // auto-created reviewer task, not a bare review.
  expect(status).toBe("pending-review");
  expect(seen.map((t) => t.id)).toEqual([created.id]);

  const missing = await app(req("/tasks/nope/run", { method: "POST" }));
  expect(missing.status).toBe(404);
});

test("POST /tasks/:id/escalation/approve forces an escalated task to review, recording an audited override; 400 when not escalated", async () => {
  const board = new SqliteBoard();
  const app = await makeApp(board);
  const escalated = await board.create({ title: "t", body: "", labels: [], repo: "r" });
  await board.escalate(escalated.id, "Attempt 1: still broken\n\nAttempt 2: still broken");

  const sse = await app(req("/events"));
  const reader = sse.body!.getReader();
  await reader.read(); // ": connected" preamble

  const missingFields = await app(req(`/tasks/${escalated.id}/escalation/approve`, { method: "POST", body: JSON.stringify({}) }));
  expect(missingFields.status).toBe(400);

  const res = await app(
    req(`/tasks/${escalated.id}/escalation/approve`, {
      method: "POST",
      body: JSON.stringify({ actor: "milton", reason: "read the diff myself, it's fine" }),
    }),
  );
  expect(res.status).toBe(200);
  const task = (await res.json()) as TaskCard;
  expect(task.status).toBe("review");
  expect((await (await app(req(`/tasks/${escalated.id}`))).json() as TaskCard).status).toBe("review");

  const decoder = new TextDecoder();
  const chunk = decoder.decode((await reader.read()).value);
  expect(chunk).toContain("task.override");
  expect(chunk).toContain("milton");
  expect(chunk).toContain("read the diff myself, it's fine");
  await reader.cancel();

  const notEscalated = await board.create({ title: "not escalated", body: "", labels: [], repo: "r" });
  const rejected = await app(
    req(`/tasks/${notEscalated.id}/escalation/approve`, {
      method: "POST",
      body: JSON.stringify({ actor: "milton", reason: "irrelevant" }),
    }),
  );
  expect(rejected.status).toBe(400);
  expect((await (await app(req(`/tasks/${notEscalated.id}`))).json() as TaskCard).status).toBe("inbox");

  const missingId = await app(
    req("/tasks/nope/escalation/approve", { method: "POST", body: JSON.stringify({ actor: "milton", reason: "x" }) }),
  );
  expect(missingId.status).toBe(404);
});

test("POST /tasks/:id/escalation/abandon marks an escalated task failed; 400 when not escalated", async () => {
  const board = new SqliteBoard();
  const app = await makeApp(board);
  const escalated = await board.create({ title: "t", body: "", labels: [], repo: "r" });
  await board.escalate(escalated.id, "Attempt 1: still broken");

  const res = await app(req(`/tasks/${escalated.id}/escalation/abandon`, { method: "POST" }));
  expect(res.status).toBe(200);
  expect(((await res.json()) as TaskCard).status).toBe("failed");
  expect((await (await app(req(`/tasks/${escalated.id}`))).json() as TaskCard).status).toBe("failed");

  const notEscalated = await board.create({ title: "not escalated", body: "", labels: [], repo: "r" });
  const rejected = await app(req(`/tasks/${notEscalated.id}/escalation/abandon`, { method: "POST" }));
  expect(rejected.status).toBe(400);

  const missingId = await app(req("/tasks/nope/escalation/abandon", { method: "POST" }));
  expect(missingId.status).toBe(404);
});

test("POST /tasks/:id/escalation/retry spawns a fresh pushback task with pushbackCount reset and a new reviewLineageId; 400 when not escalated or body missing", async () => {
  const board = new SqliteBoard();
  const app = await makeApp(board);
  const escalated = await board.create({ title: "t", body: "original body", labels: ["code"], repo: "r", pushbackCount: 5, reviewLineageId: "exhausted-lineage" });
  await board.escalate(escalated.id, "Attempt 1..6: same objection every time");

  const noBody = await app(req(`/tasks/${escalated.id}/escalation/retry`, { method: "POST", body: JSON.stringify({}) }));
  expect(noBody.status).toBe(400);

  const res = await app(
    req(`/tasks/${escalated.id}/escalation/retry`, { method: "POST", body: JSON.stringify({ body: "human-edited instructions" }) }),
  );
  expect(res.status).toBe(201);
  const nextAttempt = (await res.json()) as TaskCard;
  expect(nextAttempt.title).toBe("t");
  expect(nextAttempt.body).toBe("human-edited instructions");
  expect(nextAttempt.labels).toEqual(["code"]);
  expect(nextAttempt.repo).toBe("r");
  expect(nextAttempt.pushbackCount).toBe(0);
  expect(nextAttempt.status).toBe("inbox");
  expect(nextAttempt.reviewLineageId).toBeDefined();
  expect(nextAttempt.reviewLineageId).not.toBe("exhausted-lineage");

  // The old escalated card is superseded, not resurrected — mirrors
  // TaskCard.supersededBy's contract for a pushback re-attempt.
  const oldCard = (await (await app(req(`/tasks/${escalated.id}`))).json()) as TaskCard;
  expect(oldCard.status).toBe("escalated");
  expect(oldCard.supersededBy).toBe(nextAttempt.id);

  const notEscalated = await board.create({ title: "not escalated", body: "", labels: [], repo: "r" });
  const rejected = await app(
    req(`/tasks/${notEscalated.id}/escalation/retry`, { method: "POST", body: JSON.stringify({ body: "x" }) }),
  );
  expect(rejected.status).toBe(400);

  const missingId = await app(
    req("/tasks/nope/escalation/retry", { method: "POST", body: JSON.stringify({ body: "x" }) }),
  );
  expect(missingId.status).toBe(404);
});

test("POST /tasks/:id/mcp-approval/approve creates a real follow-up task scoped to exactly the one approved call, supersedes and moves the original to done; 400 when there's no pending request", async () => {
  const board = new SqliteBoard();
  const app = await makeApp(board);
  const original = await board.create({ title: "check Jira, maybe notify Slack", body: "", labels: ["intake"], repo: "r" });
  const request = { server: "slack", tool: "send_message", args: { text: "deploy finished" }, reason: "the team asked to be notified" };
  await board.requestMcpApproval(original.id, request);

  const res = await app(req(`/tasks/${original.id}/mcp-approval/approve`, { method: "POST" }));
  expect(res.status).toBe(201);
  const followUp = (await res.json()) as TaskCard;

  // The actual created task's grant, not just that a request fired —
  // scoped to EXACTLY the one approved server+tool, never the server's
  // other tools or any other server.
  expect(followUp.mcpAccessOverride).toEqual([{ server: "slack", tools: ["send_message"] }]);
  expect(followUp.title).toContain("slack/send_message");
  expect(followUp.body).toContain("deploy finished");
  expect(followUp.labels).toEqual(["intake"]);
  expect(followUp.repo).toBe("r");
  expect(followUp.parentTaskId).toBeUndefined(); // see server.ts's own doc comment: never restricts routing via resolveHandoffAllowlist

  const originalAfter = (await (await app(req(`/tasks/${original.id}`))).json()) as TaskCard;
  expect(originalAfter.status).toBe("done");
  expect(originalAfter.supersededBy).toBe(followUp.id);

  const noRequest = await board.create({ title: "plain task", body: "", labels: [], repo: "r" });
  const rejected = await app(req(`/tasks/${noRequest.id}/mcp-approval/approve`, { method: "POST" }));
  expect(rejected.status).toBe(400);

  const missingId = await app(req("/tasks/nope/mcp-approval/approve", { method: "POST" }));
  expect(missingId.status).toBe(404);
});

test("the follow-up task a real approve creates actually executes the approved call — not just a correctly-shaped mcpAccessOverride that re-blocks forever", async () => {
  // Regression coverage for a review-caught bug: the follow-up's
  // mcpAccessOverride names a tool that is, by construction, declared
  // approval-required on the server (that's the only reason it was ever
  // blocked) — so resolving it through the ordinary trust-tier split
  // would land it right back in pendingApproval, producing an
  // mcp-approval-request that can never execute. This test runs the
  // real follow-up task the real approve endpoint creates through the
  // real ReadOnlyExecutor/runClaude path and asserts the approved tool
  // actually reaches --allowedTools/--mcp-config.
  const { ReadOnlyExecutor } = await import("../src/executors/readonly.ts");

  const board = new SqliteBoard();
  const app = await makeApp(board);
  const original = await board.create({ title: "check Jira, maybe notify Slack", body: "", labels: ["intake"], repo: "r" });
  const request = { server: "slack", tool: "send_message", args: { text: "deploy finished" }, reason: "the team asked to be notified" };
  await board.requestMcpApproval(original.id, request);

  const res = await app(req(`/tasks/${original.id}/mcp-approval/approve`, { method: "POST" }));
  expect(res.status).toBe(201);
  const followUp = (await res.json()) as TaskCard;

  const mcpServer: McpServer = {
    id: "slack",
    label: "Slack",
    transport: { kind: "stdio", command: "/bin/true", args: [] },
    tools: [{ name: "send_message", trust: "approval-required" }],
    enabled: true,
  };
  const pool = McpServerPool.from([mcpServer]);
  // The routed agent declares no mcpAccess of its own — in production
  // the follow-up is routed by normal label/tag matching, but whatever
  // agent it lands on, the grant comes entirely from the task-level
  // override, never from the agent's own manifest entry.
  const noGrantAgent: AgentDef = {
    id: "triager",
    name: "Triager",
    kind: "agent",
    tier: "readonly",
    description: "x",
    whenToUse: "x",
    tags: ["intake"],
    executor: "readonly",
    inputs: [],
    outputs: [],
    trustLevel: "low",
    toolAccess: ["read"],
    costProfile: { model: "claude-sonnet-5", estUsdPerTask: 0.03 },
  };

  let seenCmd: string[] = [];
  const executor = new ReadOnlyExecutor({
    mcpServers: pool,
    runner: async (cmd) => {
      seenCmd = cmd;
      return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "sent" }), stderr: "", exitCode: 0 };
    },
  });
  const result = await executor.run(followUp, noGrantAgent);

  expect(result.ok).toBe(true);
  expect(seenCmd).toContain("--mcp-config");
  expect(seenCmd.join(" ")).toContain("mcp__slack__send_message");
  // The pending-approval prompt instruction must NOT appear — this run
  // is pre-approved, not blocked, so there's nothing left to describe
  // instead of calling.
  expect(seenCmd[2]).not.toContain("mcp-approval-request");
});

test("POST /tasks/:id/mcp-approval/deny moves the task to failed with no follow-up created; 400 when there's no pending request", async () => {
  const board = new SqliteBoard();
  const app = await makeApp(board);
  const original = await board.create({ title: "check Jira, maybe notify Slack", body: "", labels: ["intake"], repo: "r" });
  await board.requestMcpApproval(original.id, { server: "slack", tool: "send_message", args: {}, reason: "x" });

  const before = await board.list();
  const res = await app(req(`/tasks/${original.id}/mcp-approval/deny`, { method: "POST" }));
  expect(res.status).toBe(200);
  expect(((await res.json()) as TaskCard).status).toBe("failed");

  const after = await board.list();
  expect(after.length).toBe(before.length); // no follow-up task created

  const noRequest = await board.create({ title: "plain task", body: "", labels: [], repo: "r" });
  const rejected = await app(req(`/tasks/${noRequest.id}/mcp-approval/deny`, { method: "POST" }));
  expect(rejected.status).toBe(400);

  const missingId = await app(req("/tasks/nope/mcp-approval/deny", { method: "POST" }));
  expect(missingId.status).toBe(404);
});

test("POST /tasks/:id/run 409s when a run for that task is already in flight", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const app = await makeApp(new SqliteBoard(), {
    manualExecutors: [
      fakeWriteExecutor(async (task, agent) => {
        await blocked;
        return { taskId: task.id, agentId: agent.id, ok: true, summary: "ok" };
      }),
    ],
  });

  const created = (await (
    await app(req("/tasks", { method: "POST", body: JSON.stringify({ title: "t", body: "", labels: ["code"], repo: "r" }) }))
  ).json()) as TaskCard;

  const first = await app(req(`/tasks/${created.id}/run`, { method: "POST" }));
  expect(first.status).toBe(202);

  const second = await app(req(`/tasks/${created.id}/run`, { method: "POST" }));
  expect(second.status).toBe(409);
  release();
});

function pipelineHandoffAgent(id: string): AgentDef {
  return {
    id,
    name: id,
    kind: "agent",
    tier: "readonly",
    description: "test pipeline step agent",
    whenToUse: "test only",
    tags: ["test"],
    executor: "readonly",
    inputs: [],
    outputs: [],
    trustLevel: "low",
    toolAccess: ["read"],
    costProfile: { model: "claude-sonnet-5", estUsdPerTask: 0.01 },
    outputContract: "Your final message must end with a ```pipeline-handoff``` block.",
    outputContractFormat: "pipeline-handoff",
  };
}

/** A fake executor for pipeline-run API tests — matches any agent with
 *  the pipeline-handoff contract, never spawns a real `claude` process. */
function fakePipelineExecutor(run: Executor["run"]): Executor {
  return { id: "fake-pipeline", canHandle: (agent: AgentDef) => agent.outputContractFormat === "pipeline-handoff", run };
}

const pipelineGraph = {
  steps: [
    { id: "a", name: "A", agentId: "step-a", transition: "choose" as const },
    { id: "b", name: "B", agentId: "step-b", transition: "choose" as const },
  ],
  edges: [{ id: "e1", from: "a", to: "b" }],
};

test("POST /pipelines creates a definition, GET /pipelines lists it, GET /pipelines/:id fetches it, 404s on an unknown id", async () => {
  const board = new SqliteBoard();
  const registry = await Registry.load();
  const app = createApp(board, registry);

  const createRes = await app(req("/pipelines", { method: "POST", body: JSON.stringify({ name: "My pipeline", description: "d", graph: pipelineGraph }) }));
  expect(createRes.status).toBe(201);
  const created = (await createRes.json()) as { id: string; name: string; graph: unknown };
  expect(created.name).toBe("My pipeline");
  expect(created.graph).toEqual(pipelineGraph);

  const listRes = await app(req("/pipelines"));
  expect(await listRes.json()).toEqual([created]);

  const getRes = await app(req(`/pipelines/${created.id}`));
  expect(await getRes.json()).toEqual(created);

  const missing = await app(req("/pipelines/nope"));
  expect(missing.status).toBe(404);
});

test("POST /pipelines 400s when name or graph is missing", async () => {
  const app = createApp(new SqliteBoard(), await Registry.load());
  const noName = await app(req("/pipelines", { method: "POST", body: JSON.stringify({ description: "d", graph: pipelineGraph }) }));
  expect(noName.status).toBe(400);
  const noGraph = await app(req("/pipelines", { method: "POST", body: JSON.stringify({ name: "n" }) }));
  expect(noGraph.status).toBe(400);
});

test("PUT /pipelines/:id updates in place, 404s on an unknown id", async () => {
  const board = new SqliteBoard();
  const app = createApp(board, await Registry.load());
  const created = (await (
    await app(req("/pipelines", { method: "POST", body: JSON.stringify({ name: "Original", description: "", graph: pipelineGraph }) }))
  ).json()) as { id: string };

  const newGraph = { steps: [{ id: "a", name: "Only", agentId: "step-a", transition: "all" }], edges: [] };
  const updateRes = await app(
    req(`/pipelines/${created.id}`, { method: "PUT", body: JSON.stringify({ name: "Renamed", description: "new", graph: newGraph }) }),
  );
  expect(updateRes.status).toBe(200);
  const updated = (await updateRes.json()) as { name: string; graph: unknown };
  expect(updated.name).toBe("Renamed");
  expect(updated.graph).toEqual(newGraph);

  const missing = await app(req("/pipelines/nope", { method: "PUT", body: JSON.stringify({ name: "n", description: "", graph: newGraph }) }));
  expect(missing.status).toBe(404);
});

test("DELETE /pipelines/:id removes it, 404s on an unknown id, and a second delete also 404s", async () => {
  const board = new SqliteBoard();
  const app = createApp(board, await Registry.load());
  const created = (await (
    await app(req("/pipelines", { method: "POST", body: JSON.stringify({ name: "Temp", description: "", graph: pipelineGraph }) }))
  ).json()) as { id: string };

  const del = await app(req(`/pipelines/${created.id}`, { method: "DELETE" }));
  expect(del.status).toBe(204);
  expect((await app(req(`/pipelines/${created.id}`))).status).toBe(404);
  expect((await app(req(`/pipelines/${created.id}`, { method: "DELETE" }))).status).toBe(404);
});

test("POST /pipelines/:id/run drives the run end-to-end and emits real BoardEvents, GET /pipelines/:id/runs lists it most-recent-first", async () => {
  const board = new SqliteBoard();
  const registry = Registry.from([pipelineHandoffAgent("step-a"), pipelineHandoffAgent("step-b")]);
  let calls = 0;
  const app = createApp(board, registry, undefined, {
    manualExecutors: [
      fakePipelineExecutor(async (task, agent) => {
        calls++;
        const body = calls === 1 ? { next: "b", note: "handed off" } : {};
        return { taskId: task.id, agentId: agent.id, ok: true, summary: "ok", pipelineHandoff: body };
      }),
    ],
  });

  const events: unknown[] = [];
  board.events.on("event", (e) => events.push(e));

  const created = (await (
    await app(req("/pipelines", { method: "POST", body: JSON.stringify({ name: "Run me", description: "", graph: pipelineGraph }) }))
  ).json()) as { id: string };

  const runRes = await app(req(`/pipelines/${created.id}/run`, { method: "POST", body: JSON.stringify({ repo: "/tmp/repo", input: "go" }) }));
  expect(runRes.status).toBe(201);
  const root = (await runRes.json()) as TaskCard;
  expect(root.status).toBe("done");
  expect(root.pipelineId).toBe(created.id);
  expect(events.some((e) => (e as { type: string }).type === "task.created")).toBe(true);

  const missingPipeline = await app(req("/pipelines/nope/run", { method: "POST", body: JSON.stringify({ repo: "r", input: "i" }) }));
  expect(missingPipeline.status).toBe(404);

  const badBody = await app(req(`/pipelines/${created.id}/run`, { method: "POST", body: JSON.stringify({}) }));
  expect(badBody.status).toBe(400);

  const secondRoot = (await (
    await app(req(`/pipelines/${created.id}/run`, { method: "POST", body: JSON.stringify({ repo: "/tmp/repo", input: "go again" }) }))
  ).json()) as TaskCard;

  const runsRes = await app(req(`/pipelines/${created.id}/runs`));
  const runs = (await runsRes.json()) as TaskCard[];
  expect(runs.map((r) => r.id)).toEqual([secondRoot.id, root.id]); // most recent first
  expect(runs.every((r) => r.pipelineId === created.id)).toBe(true);

  // Consistent with every sibling /pipelines/:id* endpoint: an unknown
  // id 404s, it doesn't silently report "no runs" (which would be
  // indistinguishable from a real pipeline with zero runs yet).
  expect((await app(req("/pipelines/nope/runs"))).status).toBe(404);
});

test("GET /pipelines/edit serves the pipeline-editor SPA's index.html, not the /pipelines/:id 404 path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-api-pipeline-editor-test-"));
  try {
    await writeFile(join(dir, "index.html"), "<html>pipeline editor</html>");
    const app = await makeApp(new SqliteBoard(), { pipelineEditorDist: new URL(`file://${dir}/`) });

    const bare = await app(req("/pipelines/edit"));
    expect(bare.status).toBe(200);
    expect(await bare.text()).toBe("<html>pipeline editor</html>");

    // A client-side "edit an existing pipeline" route, e.g.
    // /pipelines/edit/<pipeline-id> — no matching file on disk, so it
    // falls back to the same SPA entry point rather than 404ing or
    // being swallowed by GET /pipelines/:id (which would otherwise
    // treat "edit" as a pipeline id).
    const withId = await app(req("/pipelines/edit/some-pipeline-id"));
    expect(withId.status).toBe(200);
    expect(await withId.text()).toBe("<html>pipeline editor</html>");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GET /pipelines/edit serves a real on-disk asset file as-is, by content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-api-pipeline-editor-asset-test-"));
  try {
    await writeFile(join(dir, "index.html"), "<html>entry</html>");
    await mkdir(join(dir, "assets"), { recursive: true });
    await writeFile(join(dir, "assets", "index-abc123.js"), "console.log('hi');");
    const app = await makeApp(new SqliteBoard(), { pipelineEditorDist: new URL(`file://${dir}/`) });

    const asset = await app(req("/pipelines/edit/assets/index-abc123.js"));
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe("console.log('hi');");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GET /pipelines/edit never resolves a traversal path through the real HTTP entry point (WHATWG URL normalizes it away first)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-api-pipeline-editor-traversal-test-"));
  try {
    await writeFile(join(dir, "index.html"), "<html>entry</html>");
    const app = await makeApp(new SqliteBoard(), { pipelineEditorDist: new URL(`file://${dir}/`) });

    // Neither a literal ".." nor a percent-encoded "%2e%2e" segment ever
    // reaches servePipelineEditorAsset itself: standard URL path
    // normalization (WHATWG URL — applied when `new URL(req.url)`
    // builds `url.pathname` in the fetch handler, and the spec treats
    // "..", "%2e.", ".%2e", and "%2e%2e" as equivalent "double-dot path
    // segments") already collapses both down to "/etc/passwd" before
    // any route matching happens, so both 404 as an unmatched route —
    // not via this function's own guard. See the direct unit test below
    // for what actually exercises that guard.
    expect((await app(req("/pipelines/edit/../../../../etc/passwd"))).status).toBe(404);
    expect((await app(req("/pipelines/edit/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/passwd"))).status).toBe(404);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("servePipelineEditorAsset's own distDir guard refuses a path that resolves outside distDir", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-api-pipeline-editor-guard-test-"));
  try {
    await writeFile(join(dir, "index.html"), "<html>entry</html>");
    // Bypasses the HTTP layer's own URL normalization entirely, calling
    // the function directly with a literal ".." pathname the same way a
    // caller that skipped `new URL(req.url)` normalization could —
    // proves the function's own guard is real, not just redundant with
    // the normalization every real request already gets for free.
    const res = await servePipelineEditorAsset("/pipelines/edit/../../../../../../../../../../../../etc/passwd", new URL(`file://${dir}/`));
    expect(res.status).toBe(404);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GET /pipelines/edit 503s with a helpful message when pipeline-editor hasn't been built", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-api-pipeline-editor-unbuilt-test-"));
  try {
    const app = await makeApp(new SqliteBoard(), { pipelineEditorDist: new URL(`file://${dir}/`) });
    const res = await app(req("/pipelines/edit"));
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("pipeline-editor not built");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /pipelines/edit is not found (the SPA route only serves GET)", async () => {
  const app = await makeApp();
  const res = await app(req("/pipelines/edit", { method: "POST" }));
  expect(res.status).toBe(404);
});

/** Runs real `git` synchronously for one-off test-fixture setup — same
 *  helper as test/projects.test.ts's own `git()`, kept local here since
 *  this file has no shared test-utils module to import it from. */
function gitInit(dir: string): void {
  const result = Bun.spawnSync(["git", "init", "-q"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git init failed: ${result.stderr.toString("utf8")}`);
  }
}

test("GET /projects on an empty board returns []", async () => {
  const app = await makeApp();
  const res = await app(req("/projects"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual([]);
});

test("POST /projects/local registers a real tmp git repo, and it shows up in a follow-up GET /projects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-api-projects-local-"));
  try {
    gitInit(dir);
    const app = await makeApp();

    const createRes = await app(req("/projects/local", { method: "POST", body: JSON.stringify({ path: dir }) }));
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string; name: string; path: string; source: string };
    expect(created.source).toBe("local");
    expect(created.path).toBe(dir);
    expect(typeof created.id).toBe("string");

    const listRes = await app(req("/projects"));
    expect(await listRes.json()).toEqual([created]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /projects/local with a bad path 400s, and a follow-up GET /projects still shows nothing", async () => {
  const app = await makeApp();

  const res = await app(
    req("/projects/local", { method: "POST", body: JSON.stringify({ path: join(tmpdir(), "wissel-api-projects-does-not-exist") }) }),
  );
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(typeof body.error).toBe("string");

  const listRes = await app(req("/projects"));
  expect(await listRes.json()).toEqual([]);
});

test("POST /projects/clone 400s with the store's captured git stderr on a bad URL", async () => {
  const commandRunner: CommandRunner = async () => ({ stdout: "", stderr: "fatal: repository 'nope' not found", exitCode: 128 });
  const app = await makeApp(new SqliteBoard(), { commandRunner });

  const res = await app(req("/projects/clone", { method: "POST", body: JSON.stringify({ url: "org/does-not-exist" }) }));
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(body.error).toContain("repository 'nope' not found");
});

test("POST /projects/clone called twice with the identical URL: 201 then 200 + alreadyExists", async () => {
  let cloneCalls = 0;
  const commandRunner: CommandRunner = async (cmd) => {
    if (cmd[0] === "git" && cmd[1] === "clone") cloneCalls++;
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  const app = await makeApp(new SqliteBoard(), { commandRunner });

  const first = await app(req("/projects/clone", { method: "POST", body: JSON.stringify({ url: "org/repo" }) }));
  expect(first.status).toBe(201);
  const firstBody = (await first.json()) as { id: string; sourceUrl: string };

  const second = await app(req("/projects/clone", { method: "POST", body: JSON.stringify({ url: "org/repo" }) }));
  expect(second.status).toBe(200);
  const secondBody = (await second.json()) as { project: { id: string }; alreadyExists: boolean };
  expect(secondBody.alreadyExists).toBe(true);
  expect(secondBody.project.id).toBe(firstBody.id);

  expect(cloneCalls).toBe(1);
});

test("DELETE /projects/:id removes it (404s on unknown, and it's gone from a follow-up GET /projects)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-api-projects-delete-"));
  try {
    gitInit(dir);
    const app = await makeApp();

    const created = (await (await app(req("/projects/local", { method: "POST", body: JSON.stringify({ path: dir }) }))).json()) as {
      id: string;
    };

    const missing = await app(req("/projects/does-not-exist", { method: "DELETE" }));
    expect(missing.status).toBe(404);

    const del = await app(req(`/projects/${created.id}`, { method: "DELETE" }));
    expect(del.status).toBe(204);

    expect(await (await app(req("/projects"))).json()).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** Real `git` synchronously, mirroring gitInit above — commits so
 *  `GET /projects/:id/status`'s `git log -1` has something real to
 *  report, not just an empty repo. */
function gitInitWithCommit(dir: string): void {
  gitInit(dir);
  for (const args of [["config", "user.email", "wissel-test@example.com"], ["config", "user.name", "wissel test"], ["commit", "--allow-empty", "-q", "-m", "seed"]]) {
    const result = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
  }
}

function fakeEli5Client(text: string): (apiKey?: string) => AnthropicMessagesClient {
  return () => ({
    messages: {
      create: async (params): Promise<Anthropic.Message> =>
        ({
          id: "msg_1", type: "message", role: "assistant", model: params.model,
          content: [{ type: "text", text, citations: null }],
          stop_reason: "end_turn", stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        }) as Anthropic.Message,
    },
  });
}

test("GET /projects/:id/status returns real git state for a registered project (404 on unknown id)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-api-projects-status-"));
  try {
    gitInitWithCommit(dir);
    const app = await makeApp();
    const created = (await (await app(req("/projects/local", { method: "POST", body: JSON.stringify({ path: dir }) }))).json()) as { id: string };

    const res = await app(req(`/projects/${created.id}/status`));
    expect(res.status).toBe(200);
    const status = (await res.json()) as { branch: string; dirty: boolean; latestCommit?: { message: string } };
    expect(status.dirty).toBe(false);
    expect(status.latestCommit?.message).toBe("seed");

    const missing = await app(req("/projects/does-not-exist/status"));
    expect(missing.status).toBe(404);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GET /projects/:id/eli5 generates and caches on first call, then serves the cache on a second call without invoking the model again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-api-projects-eli5-"));
  try {
    gitInit(dir);
    await writeFile(join(dir, "README.md"), "# Test project\nDoes a thing.");
    let calls = 0;
    const clientFactory = () => {
      calls++;
      return fakeEli5Client("A friendly one-paragraph explanation.")();
    };
    const app = await makeApp(new SqliteBoard(), { projectEli5ClientFactory: clientFactory });
    const created = (await (await app(req("/projects/local", { method: "POST", body: JSON.stringify({ path: dir }) }))).json()) as { id: string };

    const first = await app(req(`/projects/${created.id}/eli5`));
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { eli5: string; cached: boolean };
    expect(firstBody.eli5).toBe("A friendly one-paragraph explanation.");
    expect(firstBody.cached).toBe(false);
    expect(calls).toBe(1);

    const second = await app(req(`/projects/${created.id}/eli5`));
    const secondBody = (await second.json()) as { eli5: string; cached: boolean };
    expect(secondBody.eli5).toBe("A friendly one-paragraph explanation.");
    expect(secondBody.cached).toBe(true);
    expect(calls).toBe(1); // no second model call — served from the cached project row

    const refreshed = await app(req(`/projects/${created.id}/eli5?refresh=1`));
    expect((await refreshed.json() as { cached: boolean }).cached).toBe(false);
    expect(calls).toBe(2); // ?refresh=1 forces a real regeneration
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GET /projects/:id/eli5 surfaces a model failure as 502, and 404s on an unknown project id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-api-projects-eli5-error-"));
  try {
    gitInit(dir);
    const throwingClientFactory: (apiKey?: string) => AnthropicMessagesClient = () => ({
      messages: { create: async () => { throw new Error("network down"); } },
    });
    const app = await makeApp(new SqliteBoard(), { projectEli5ClientFactory: throwingClientFactory });
    const created = (await (await app(req("/projects/local", { method: "POST", body: JSON.stringify({ path: dir }) }))).json()) as { id: string };

    const res = await app(req(`/projects/${created.id}/eli5`));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("network down");

    const missing = await app(req("/projects/does-not-exist/eli5"));
    expect(missing.status).toBe(404);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
