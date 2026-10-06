import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { SqlitePipelineStore } from "../src/services/pipelines.ts";
import { Registry } from "../src/core/registry.ts";
import { Router } from "../src/core/router.ts";
import { Orchestrator, type OrchestratorOptions } from "../src/core/orchestrator.ts";
import { HarnessOverrideError, HarnessPool, validateAgentHarnesses } from "../src/core/harness-pool.ts";
import { startPipelineRun, type PipelineRunnerContext } from "../src/core/pipeline-runner.ts";
import { ReadOnlyExecutor } from "../src/executors/readonly.ts";
import type { CommandRunner } from "../src/executors/claude-cli.ts";
import type { AgentDef, Executor, Harness, PipelineGraph, TaskCard } from "../src/core/types.ts";

// docs/SDD-agent-harness-preference.md §4, tests 1-8. An agent's
// `harnesses` list is an ordered preference; when nothing on it is
// enabled and under maxConcurrent the task waits, and it never moves to
// a harness the agent didn't list.

function harness(overrides: Partial<Harness> & Pick<Harness, "id">): Harness {
  return { tool: "claude-cli", label: overrides.id, enabled: true, ...overrides };
}

function agent(harnesses?: string[], overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    id: "picky",
    name: "picky",
    kind: "agent",
    tier: "readonly",
    description: "test agent with a harness preference",
    whenToUse: "test only",
    tags: ["intake"],
    executor: "readonly",
    inputs: [],
    outputs: [],
    trustLevel: "low",
    toolAccess: ["read"],
    costProfile: { model: "claude-sonnet-5-5", estUsdPerTask: 0.01 },
    ...(harnesses ? { harnesses } : {}),
    ...overrides,
  };
}

function fakeExecutor(run: Executor["run"], harnessTool: Executor["harnessTool"] = "claude-cli"): Executor {
  return { id: "fake-readonly", harnessTool, canHandle: (a: AgentDef) => a.tier === "readonly", run };
}

function setup(agents: AgentDef[], executors: Executor[], opts: OrchestratorOptions) {
  const board = new SqliteBoard();
  const registry = Registry.from(agents);
  const orchestrator = new Orchestrator(board, registry, new Router(registry), executors, undefined, opts);
  return { board, registry, orchestrator };
}

/** Captures console.log for the duration of `fn`. */
async function withLogs<T>(fn: (logs: string[]) => Promise<T>): Promise<T> {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => void logs.push(args.join(" "));
  try {
    return await fn(logs);
  } finally {
    console.log = original;
  }
}

async function waitFor(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

// --- Test 1: list order -----------------------------------------------------

test("acquire(): picks the first listed harness when it's enabled, even when a later one is less loaded", () => {
  const pool = HarnessPool.from([harness({ id: "first" }), harness({ id: "second" })]);
  expect(pool.acquire("claude-cli", undefined, ["first", "second"])?.id).toBe("first");
  // "first" now has 1 in flight, "second" 0: least-loaded would flip, list order doesn't.
  expect(pool.acquire("claude-cli", undefined, ["first", "second"])?.id).toBe("first");
  expect(pool.activeCount("first")).toBe(2);
  expect(pool.activeCount("second")).toBe(0);
});

test("acquire(): skips a disabled first entry and picks the second", () => {
  const pool = HarnessPool.from([harness({ id: "first", enabled: false }), harness({ id: "second" })]);
  expect(pool.acquire("claude-cli", undefined, ["first", "second"])?.id).toBe("second");
});

test("acquire(): list order wins over manifest order", () => {
  const pool = HarnessPool.from([harness({ id: "a" }), harness({ id: "b" })]);
  expect(pool.acquire("claude-cli", undefined, ["b", "a"])?.id).toBe("b");
});

test("orchestrator: a task runs on the agent's first listed harness, and on the second when the first is disabled", async () => {
  const ran: string[] = [];
  const harnesses = HarnessPool.from([harness({ id: "unlisted" }), harness({ id: "first" }), harness({ id: "second" })]);
  const { board, orchestrator } = setup(
    [agent(["first", "second"])],
    [fakeExecutor(async (task, a, h) => (ran.push(h!.id), { taskId: task.id, agentId: a.id, ok: true, summary: "ran" }))],
    { harnesses },
  );

  const t1 = await board.create({ title: "one", body: "", labels: ["intake"], repo: "r" });
  await orchestrator.sweep();
  harnesses.setEnabled("first", false);
  const t2 = await board.create({ title: "two", body: "", labels: ["intake"], repo: "r" });
  await orchestrator.sweep();

  expect(ran).toEqual(["first", "second"]);
  expect((await board.get(t1.id))!.harness).toBe("first");
  expect((await board.get(t2.id))!.harness).toBe("second");
});

// --- Test 2: all listed disabled -> held, never an unlisted harness -------

test("acquire()/canAcquire(): all listed harnesses disabled returns undefined, never an enabled unlisted one", () => {
  const pool = HarnessPool.from([harness({ id: "listed", enabled: false }), harness({ id: "unlisted" })]);
  expect(pool.canAcquire("claude-cli", ["listed"])).toBe(false);
  expect(pool.acquire("claude-cli", undefined, ["listed"])).toBeUndefined();
  expect(pool.activeCount("unlisted")).toBe(0);
  // Without the list, the unlisted one is picked as before.
  expect(pool.canAcquire("claude-cli")).toBe(true);
});

test("acquire(): a listed id that doesn't exist or is the wrong tool is skipped, not used", () => {
  const pool = HarnessPool.from([harness({ id: "codex", tool: "codex-cli" }), harness({ id: "unlisted" })]);
  expect(pool.acquire("claude-cli", undefined, ["ghost", "codex"])).toBeUndefined();
});

test("orchestrator: all listed harnesses disabled holds the task unrouted and never runs it, even with an unlisted harness enabled", async () => {
  let runs = 0;
  const harnesses = HarnessPool.from([harness({ id: "listed-a", enabled: false }), harness({ id: "listed-b", enabled: false }), harness({ id: "unlisted" })]);
  const { board, orchestrator } = setup(
    [agent(["listed-a", "listed-b"])],
    [fakeExecutor(async (task, a) => (runs++, { taskId: task.id, agentId: a.id, ok: true, summary: "ran" }))],
    { harnesses },
  );

  await withLogs(async (logs) => {
    const task = await board.create({ title: "raw", body: "", labels: ["intake"], repo: "r" });
    await orchestrator.sweep();
    await orchestrator.sweep();

    const held = await board.get(task.id);
    expect(runs).toBe(0);
    expect(held!.status).toBe("inbox");
    expect(held!.routedTo).toBeUndefined();
    expect(held!.harness).toBeUndefined();
    expect(harnesses.activeCount("unlisted")).toBe(0);
    // Logged once, naming the list.
    expect(logs.filter((l) => l.includes(task.id) && l.includes("waiting: none of [listed-a, listed-b] enabled and under capacity"))).toHaveLength(1);

    // Enabling a listed one resumes it, on that harness.
    harnesses.setEnabled("listed-b", true);
    await orchestrator.sweep();
    expect(runs).toBe(1);
    expect((await board.get(task.id))!.harness).toBe("listed-b");
  });
});

// --- Test 3: capacity hold, and the automatic resume ------------------------

test("acquire(): a listed harness at maxConcurrent is skipped for the next one; all at capacity returns undefined", () => {
  const pool = HarnessPool.from([harness({ id: "a", maxConcurrent: 1 }), harness({ id: "b", maxConcurrent: 1 }), harness({ id: "unlisted" })]);
  expect(pool.acquire("claude-cli", undefined, ["a", "b"])?.id).toBe("a");
  expect(pool.acquire("claude-cli", undefined, ["a", "b"])?.id).toBe("b");
  expect(pool.canAcquire("claude-cli", ["a", "b"])).toBe(false);
  expect(pool.acquire("claude-cli", undefined, ["a", "b"])).toBeUndefined();
  pool.release("a");
  expect(pool.canAcquire("claude-cli", ["a", "b"])).toBe(true);
  expect(pool.acquire("claude-cli", undefined, ["a", "b"])?.id).toBe("a");
});

test("orchestrator: all listed harnesses at maxConcurrent holds the task; when the running one finishes, the held task runs with no manual sweep", async () => {
  // The real production wiring: start() subscribes sweep() to board
  // events. Nothing in this test calls sweep() itself; the held task must
  // be resumed by the event the finishing run's own finishResult emits.
  let releaseFirst!: () => void;
  const firstMayFinish = new Promise<void>((resolve) => (releaseFirst = resolve));
  const ran: { title: string; harness: string; activeAtStart: number }[] = [];
  const harnesses = HarnessPool.from([harness({ id: "solo", maxConcurrent: 1 }), harness({ id: "unlisted" })]);
  const { board, orchestrator } = setup(
    [agent(["solo"])],
    [
      fakeExecutor(async (task, a, h) => {
        ran.push({ title: task.title, harness: h!.id, activeAtStart: harnesses.activeCount("solo") });
        if (task.title === "first") await firstMayFinish;
        return { taskId: task.id, agentId: a.id, ok: true, summary: "ran" };
      }),
    ],
    { harnesses },
  );

  await withLogs(async (logs) => {
    orchestrator.start();
    const first = await board.create({ title: "first", body: "", labels: ["intake"], repo: "r" });
    await waitFor(async () => (await board.get(first.id))!.status === "running" && ran.length === 1, "first task running");

    const second = await board.create({ title: "second", body: "", labels: ["intake"], repo: "r" });
    await waitFor(() => logs.some((l) => l.includes(second.id) && l.includes("waiting: none of [solo] enabled and under capacity")), "second task held");

    // Held: unrouted, not run, and not moved onto the idle unlisted harness.
    expect(ran.map((r) => r.title)).toEqual(["first"]);
    expect((await board.get(second.id))!.routedTo).toBeUndefined();
    expect((await board.get(second.id))!.status).toBe("inbox");
    expect(harnesses.activeCount("unlisted")).toBe(0);

    releaseFirst();
    await waitFor(async () => (await board.get(second.id))!.status === "done", "second task resumed and done");
    expect((await board.get(first.id))!.status).toBe("done");
    expect((await board.get(second.id))!.harness).toBe("solo");
  });

  expect(ran).toEqual([
    { title: "first", harness: "solo", activeAtStart: 1 },
    { title: "second", harness: "solo", activeAtStart: 1 },
  ]);
  expect(harnesses.activeCount("solo")).toBe(0);
  expect(harnesses.activeCount("unlisted")).toBe(0);
});

test("orchestrator: two tasks in one sweep against a maxConcurrent: 1 list never run concurrently; the loser is reset and resumes later", async () => {
  // Both pass canAcquire() before either acquires (the race guard path);
  // the second must be reset to inbox, not run without a harness.
  let releaseFirst!: () => void;
  const firstMayFinish = new Promise<void>((resolve) => (releaseFirst = resolve));
  let maxActive = 0;
  const ran: string[] = [];
  const harnesses = HarnessPool.from([harness({ id: "solo", maxConcurrent: 1 })]);
  const { board, orchestrator } = setup(
    [agent(["solo"])],
    [
      fakeExecutor(async (task, a, h) => {
        maxActive = Math.max(maxActive, harnesses.activeCount("solo"));
        ran.push(`${task.title}@${h?.id}`);
        if (ran.length === 1) await firstMayFinish;
        return { taskId: task.id, agentId: a.id, ok: true, summary: "ran" };
      }),
    ],
    { harnesses },
  );
  const a = await board.create({ title: "a", body: "", labels: ["intake"], repo: "r" });
  const b = await board.create({ title: "b", body: "", labels: ["intake"], repo: "r" });

  await withLogs(async () => {
    orchestrator.start();
    await waitFor(() => ran.length === 1, "one task running");
    // Give the other one every chance to (wrongly) start.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ran).toHaveLength(1);
    releaseFirst();
    await waitFor(async () => (await board.get(a.id))!.status === "done" && (await board.get(b.id))!.status === "done", "both done");
  });

  expect(maxActive).toBe(1);
  expect(ran.every((r) => r.endsWith("@solo"))).toBe(true);
});

// --- Test 4: no list --------------------------------------------------------

test("acquire() with no list: unchanged least-loaded pick", () => {
  const pool = HarnessPool.from([harness({ id: "a" }), harness({ id: "b" })]);
  expect(pool.acquire("claude-cli")?.id).toBe("a");
  expect(pool.acquire("claude-cli")?.id).toBe("b");
  expect(pool.acquire("claude-cli")?.id).toBe("a");
  // An empty list means no preference, same as undefined.
  expect(pool.acquire("claude-cli", undefined, [])?.id).toBe("b");
});

test("acquire() with no list: at-capacity harnesses are skipped; all at capacity returns undefined", () => {
  const pool = HarnessPool.from([harness({ id: "a", maxConcurrent: 1 }), harness({ id: "b" })]);
  expect(pool.acquire("claude-cli")?.id).toBe("a");
  expect(pool.acquire("claude-cli")?.id).toBe("b");
  // 1 vs 1: the tie would go to a (manifest order), but a is full.
  expect(pool.acquire("claude-cli")?.id).toBe("b");
  // 1 vs 2: least-loaded alone would pick a; still full, so b.
  expect(pool.acquire("claude-cli")?.id).toBe("b");
  expect(pool.activeCount("a")).toBe(1);

  const full = HarnessPool.from([harness({ id: "only", maxConcurrent: 2 })]);
  full.acquire("claude-cli");
  full.acquire("claude-cli");
  expect(full.canAcquire("claude-cli")).toBe(false);
  expect(full.acquire("claude-cli")).toBeUndefined();
});

test("orchestrator, no list: every enabled harness at capacity holds the task with a capacity reason", async () => {
  const harnesses = HarnessPool.from([harness({ id: "only", maxConcurrent: 1 })]);
  harnesses.acquire("claude-cli"); // something else is already running on it
  let runs = 0;
  const { board, orchestrator } = setup(
    [agent()],
    [fakeExecutor(async (task, a) => (runs++, { taskId: task.id, agentId: a.id, ok: true, summary: "ran" }))],
    { harnesses },
  );
  await withLogs(async (logs) => {
    const task = await board.create({ title: "raw", body: "", labels: ["intake"], repo: "r" });
    await orchestrator.sweep();
    expect(runs).toBe(0);
    expect((await board.get(task.id))!.routedTo).toBeUndefined();
    expect(logs.some((l) => l.includes(task.id) && l.includes("waiting: every enabled claude-cli harness at capacity"))).toBe(true);

    harnesses.release("only");
    await orchestrator.sweep();
    expect(runs).toBe(1);
  });
});

test("from() rejects a maxConcurrent that isn't a positive integer", () => {
  expect(() => HarnessPool.from([harness({ id: "a", maxConcurrent: 0 })])).toThrow(/harness "a": maxConcurrent must be a positive integer/);
  expect(() => HarnessPool.from([harness({ id: "a", maxConcurrent: 1.5 })])).toThrow(/maxConcurrent must be a positive integer/);
  expect(() => HarnessPool.from([harness({ id: "a", maxConcurrent: "2" as unknown as number })])).toThrow(/maxConcurrent must be a positive integer/);
});

test("autoload() fails loud on a harnesses.yaml that exists but is invalid, instead of silently dropping it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-harness-pref-"));
  try {
    const path = join(dir, "harnesses.yaml");
    await Bun.write(path, "harnesses:\n  - id: api\n    tool: anthropic-api\n    label: API\n    enabled: true\n    maxConcurrent: -1\n");
    await expect(HarnessPool.autoload(path, { homeDir: dir, env: {}, runner: async () => ({ stdout: "", stderr: "", exitCode: 1 }) })).rejects.toThrow(
      /maxConcurrent must be a positive integer/,
    );
    // A missing file is still fine.
    const pool = await HarnessPool.autoload(join(dir, "missing.yaml"), { homeDir: dir, env: {}, runner: async () => ({ stdout: "", stderr: "", exitCode: 1 }) });
    expect(pool.get("api")).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("HarnessPool.load() parses maxConcurrent from harnesses.yaml", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-harness-pref-"));
  try {
    const path = join(dir, "harnesses.yaml");
    await Bun.write(path, "harnesses:\n  - id: a\n    tool: claude-cli\n    label: A\n    enabled: true\n    maxConcurrent: 2\n");
    expect((await HarnessPool.load(path)).get("a")?.maxConcurrent).toBe(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Test 5: harnessOverride wins; an override at capacity fails loud ----

test("acquire(): harnessOverride wins over the list; an override at capacity throws HarnessOverrideError", () => {
  const pool = HarnessPool.from([harness({ id: "listed" }), harness({ id: "forced", maxConcurrent: 1 })]);
  expect(pool.acquire("claude-cli", "forced", ["listed"])?.id).toBe("forced");
  expect(() => pool.acquire("claude-cli", "forced", ["listed"])).toThrow(HarnessOverrideError);
  expect(() => pool.acquire("claude-cli", "forced", ["listed"])).toThrow(/harness "forced" is at capacity \(1\/1 running\)/);
  expect(pool.activeCount("listed")).toBe(0);
});

test("orchestrator: harnessOverride runs on the override, not the agent's list", async () => {
  const ran: string[] = [];
  const harnesses = HarnessPool.from([harness({ id: "listed" }), harness({ id: "forced" })]);
  const { board, orchestrator } = setup(
    [agent(["listed"])],
    [fakeExecutor(async (task, a, h) => (ran.push(h!.id), { taskId: task.id, agentId: a.id, ok: true, summary: "ran" }))],
    { harnesses },
  );
  const task = await board.create({ title: "raw", body: "", labels: ["intake"], repo: "r", harnessOverride: "forced" });
  await orchestrator.sweep();
  expect(ran).toEqual(["forced"]);
  expect((await board.get(task.id))!.status).toBe("done");
});

test("orchestrator: an override onto a harness at capacity fails the task loud instead of waiting", async () => {
  const harnesses = HarnessPool.from([harness({ id: "listed" }), harness({ id: "forced", maxConcurrent: 1 })]);
  harnesses.acquire("claude-cli", "forced"); // already full
  let runs = 0;
  const { board, orchestrator } = setup(
    [agent(["listed"])],
    [fakeExecutor(async (task, a) => (runs++, { taskId: task.id, agentId: a.id, ok: true, summary: "ran" }))],
    { harnesses },
  );
  const task = await board.create({ title: "raw", body: "", labels: ["intake"], repo: "r", harnessOverride: "forced" });
  await orchestrator.sweep();
  expect(runs).toBe(0);
  expect((await board.get(task.id))!.status).toBe("failed");
  expect((await board.getResult(task.id))?.summary).toContain(`harness override 'forced' can't be honored: harness "forced" is at capacity (1/1 running)`);
  expect(harnesses.activeCount("listed")).toBe(0);
});

// --- Test 6: startup validation ---------------------------------------------

test("startup: an agent listing an unknown harness id stops createApp with a clear message", () => {
  const harnesses = HarnessPool.from([harness({ id: "claude" })]);
  expect(() => createApp(new SqliteBoard(), Registry.from([agent(["claude", "claude-typo"])]), undefined, { harnesses })).toThrow(
    `agent "picky" lists unknown harness id "claude-typo"`,
  );
});

test("startup: a claude-cli agent listing a codex harness stops createApp with a clear message", () => {
  const harnesses = HarnessPool.from([harness({ id: "claude" }), harness({ id: "codex", tool: "codex-cli" })]);
  expect(() => createApp(new SqliteBoard(), Registry.from([agent(["claude", "codex"])]), undefined, { harnesses })).toThrow(
    `agent "picky" lists harness "codex", a codex-cli harness, but its executor runs claude-cli`,
  );
});

test("startup: an api agent listing a claude-cli harness is a tool mismatch too", () => {
  const harnesses = HarnessPool.from([harness({ id: "claude" })]);
  expect(() => createApp(new SqliteBoard(), Registry.from([agent(["claude"], { executor: "api" })]), undefined, { harnesses })).toThrow(
    `agent "picky" lists harness "claude", a claude-cli harness, but its executor runs anthropic-api`,
  );
});

test("startup: a listed but disabled harness starts fine; GET /agents and GET /harnesses expose the new fields", async () => {
  const harnesses = HarnessPool.from([harness({ id: "claude", enabled: false, maxConcurrent: 3 }), harness({ id: "other" })]);
  const app = createApp(new SqliteBoard(), Registry.from([agent(["claude"])]), undefined, { harnesses });

  const agents = (await (await app(new Request("http://localhost/agents"))).json()) as AgentDef[];
  expect(agents.find((a) => a.id === "picky")?.harnesses).toEqual(["claude"]);

  const listed = (await (await app(new Request("http://localhost/harnesses"))).json()) as (Harness & { activeCount: number })[];
  expect(listed.find((h) => h.id === "claude")).toMatchObject({ maxConcurrent: 3, activeCount: 0 });
  expect(listed.find((h) => h.id === "other")?.maxConcurrent).toBeUndefined();
});

test("validateAgentHarnesses: a list on an agent whose executor has no harness tool is rejected; an agent nobody handles is skipped", () => {
  const pool = HarnessPool.from([harness({ id: "claude" })]);
  const noTool: Executor = { id: "no-tool", canHandle: () => true, run: async () => ({ taskId: "", agentId: "", ok: true, summary: "" }) };
  expect(() => validateAgentHarnesses([agent(["claude"])], pool, [[noTool]])).toThrow(/runs on an executor with no harness tool/);
  expect(() => validateAgentHarnesses([agent(["claude"], { tier: "write" })], pool, [[fakeExecutor(async () => ({ taskId: "", agentId: "", ok: true, summary: "" }))]])).not.toThrow();
});

test("Registry rejects a harnesses field that isn't a list of ids", () => {
  expect(() => Registry.from([agent("claude" as unknown as string[])])).toThrow(`agent "picky": harnesses must be a list of harness ids, got "claude"`);
  expect(() => Registry.from([agent([1] as unknown as string[])])).toThrow(/harnesses must be a list of harness ids/);
});

// --- Test 7: pipeline steps -------------------------------------------------

function pipelineAgent(id: string, harnesses?: string[]): AgentDef {
  return agent(harnesses, {
    id,
    name: id,
    outputContract: "Your final message must end with a ```pipeline-handoff``` block.",
    outputContractFormat: "pipeline-handoff",
  });
}

function countingRunner(): CommandRunner & { calls: () => number } {
  let n = 0;
  const runner: CommandRunner = async () => {
    n++;
    const result = "Did it.\n\n```pipeline-handoff\n{}\n```";
    return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result }), stderr: "", exitCode: 0 };
  };
  return Object.assign(runner, { calls: () => n });
}

const oneStep: PipelineGraph = { steps: [{ id: "a", name: "A", agentId: "step-a", transition: "choose" }], edges: [] };

test("pipeline: a step runs on the agent's first available listed harness, never the less-loaded unlisted one", async () => {
  const board = new SqliteBoard();
  const harnesses = HarnessPool.from([harness({ id: "unlisted" }), harness({ id: "first", enabled: false }), harness({ id: "second" })]);
  const runner = countingRunner();
  const ctx: PipelineRunnerContext = { executors: [new ReadOnlyExecutor({ runner })], pipelines: new SqlitePipelineStore(board.db), harnesses };
  const def = await ctx.pipelines.create({ name: "Listed", description: "", graph: oneStep });

  const root = await startPipelineRun(board, Registry.from([pipelineAgent("step-a", ["first", "second"])]), def, "/tmp/repo", "go", ctx);

  expect(root.status).toBe("done");
  expect(runner.calls()).toBe(1);
  const step = (await board.list()).find((t) => t.pipelineStepId === "a");
  expect(step?.harness).toBe("second");
  expect(harnesses.activeCount("second")).toBe(0);
});

test("pipeline: nothing on the agent's list available fails the step loud, naming the list, and never runs it", async () => {
  const board = new SqliteBoard();
  const harnesses = HarnessPool.from([harness({ id: "unlisted" }), harness({ id: "full", maxConcurrent: 1 }), harness({ id: "off", enabled: false })]);
  harnesses.acquire("claude-cli", "full");
  const runner = countingRunner();
  const ctx: PipelineRunnerContext = { executors: [new ReadOnlyExecutor({ runner })], pipelines: new SqlitePipelineStore(board.db), harnesses };
  const def = await ctx.pipelines.create({ name: "Nothing free", description: "", graph: oneStep });

  await startPipelineRun(board, Registry.from([pipelineAgent("step-a", ["full", "off"])]), def, "/tmp/repo", "go", ctx);

  expect(runner.calls()).toBe(0);
  expect(harnesses.activeCount("unlisted")).toBe(0);
  const step = (await board.list()).find((t) => t.pipelineStepId === "a");
  expect(step?.status).toBe("failed");
  expect(step?.harness).toBeUndefined();
  expect((await board.getResult(step!.id))?.summary).toBe(`none of agent "step-a"'s harnesses [full, off] enabled and under capacity, step not run`);
});

// --- Test 8: real manifest entries without a list are unchanged ----------

test("every real manifest agent without `harnesses` builds the same acquire call as before: no preference passed", async () => {
  const real = await Registry.load();
  const runnable = real.all().filter((a) => a.tier !== "service");
  expect(runnable.length).toBeGreaterThan(0);
  const memoryDir = await mkdtemp(join(tmpdir(), "wissel-harness-pref-"));
  const calls: { agentId: string; args: unknown[] }[] = [];

  try {
    for (const def of runnable) {
      // This card ships no manifest lists (SDD §6, Milton's open decision).
      expect(def.harnesses).toBeUndefined();

      const harnesses = HarnessPool.from([harness({ id: "h", tool: "claude-cli" }), harness({ id: "api", tool: "anthropic-api" }), harness({ id: "cx", tool: "codex-cli" })]);
      const original = harnesses.acquire.bind(harnesses);
      harnesses.acquire = (...args: Parameters<HarnessPool["acquire"]>) => {
        calls.push({ agentId: def.id, args });
        return original(...args);
      };
      const toolFor = def.executor === "api" ? "anthropic-api" : def.executor === "codex" ? "codex-cli" : "claude-cli";
      const executor: Executor = {
        id: "probe",
        harnessTool: toolFor,
        canHandle: () => true,
        run: async (task, a) => ({ taskId: task.id, agentId: a.id, ok: false, summary: "probe only" }),
      };
      const board = new SqliteBoard();
      const registry = Registry.from([def]);
      const orchestrator = new Orchestrator(board, registry, new Router(registry), [executor], undefined, {
        harnesses,
        executeWriteTier: true,
        memoryPath: join(memoryDir, "lessons.md"),
      });
      await board.create({ title: def.id, body: "", labels: def.tags, repo: "/tmp/repo" });
      await orchestrator.sweep();
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }

  const reached = new Set(calls.map((c) => c.agentId));
  expect([...reached].sort()).toEqual(runnable.filter((a) => a.tags.length > 0).map((a) => a.id).sort());
  for (const c of calls) {
    expect(c.args).toHaveLength(3);
    expect(c.args[1]).toBeUndefined(); // no override
    expect(c.args[2]).toBeUndefined(); // no preference
  }
});
