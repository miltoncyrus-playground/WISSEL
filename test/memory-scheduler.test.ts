import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { Router } from "../src/core/router.ts";
import { Orchestrator } from "../src/core/orchestrator.ts";
import { TelemetryLog } from "../src/services/telemetry.ts";
import { runClaude } from "../src/executors/claude-cli.ts";
import {
  gatherSessionLessons,
  getLastMemoryCurationAt,
  isMemoryCurationDue,
  runMemoryCurationIfDue,
} from "../src/core/memory-scheduler.ts";
import type { AgentDef, Executor, TaskCard } from "../src/core/types.ts";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "wissel-memory-scheduler-test-"));
}

// --- isMemoryCurationDue: pure due-ness check ---

test("isMemoryCurationDue: never ran (lastRanAt undefined) reads as due now", () => {
  expect(isMemoryCurationDue(undefined, 24)).toBe(true);
});

test("isMemoryCurationDue: a recent run delays the next one until the interval has passed", () => {
  const now = new Date("2026-09-22T12:00:00.000Z");
  const ranOneHourAgo = new Date("2026-09-22T11:00:00.000Z");
  expect(isMemoryCurationDue(ranOneHourAgo, 24, now)).toBe(false);

  const ranTwentyFiveHoursAgo = new Date("2026-09-21T11:00:00.000Z");
  expect(isMemoryCurationDue(ranTwentyFiveHoursAgo, 24, now)).toBe(true);

  // Exactly at the boundary counts as due.
  const ranExactlyTwentyFourHoursAgo = new Date("2026-09-21T12:00:00.000Z");
  expect(isMemoryCurationDue(ranExactlyTwentyFourHoursAgo, 24, now)).toBe(true);
});

// --- getLastMemoryCurationAt: reads telemetry fresh, no separate persistence ---

test("getLastMemoryCurationAt: no telemetry file at all reads as never run", async () => {
  const dir = await tmp();
  try {
    const at = await getLastMemoryCurationAt(join(dir, "no-such-file.jsonl"));
    expect(at).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("getLastMemoryCurationAt: ignores every other agent's result events, and picks the most recent memory-curator one", async () => {
  const dir = await tmp();
  try {
    const telemetryPath = join(dir, "telemetry.jsonl");
    const telemetry = new TelemetryLog(telemetryPath);
    await telemetry.record({ type: "result", taskId: "t-implementer", agentId: "implementer", actualCost: 0.5 });
    await telemetry.record({ type: "result", taskId: "t-curator-1", agentId: "memory-curator", actualCost: 0.05 });
    await new Promise((r) => setTimeout(r, 5));
    await telemetry.record({ type: "result", taskId: "t-curator-2", agentId: "memory-curator", actualCost: 0.05 });

    const at = await getLastMemoryCurationAt(telemetryPath);
    expect(at).toBeDefined();

    // The second memory-curator record must win — strictly later than the first.
    const events = (await Bun.file(telemetryPath).text()).trim().split("\n").map((l) => JSON.parse(l));
    const curatorTimes = events.filter((e) => e.agentId === "memory-curator").map((e) => new Date(e.at).getTime());
    expect(at!.getTime()).toBe(Math.max(...curatorTimes));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- gatherSessionLessons: deterministic gather step, no LLM call ---

test("gatherSessionLessons: never run before (since undefined) gathers every recorded session", async () => {
  const dir = await tmp();
  try {
    const telemetryPath = join(dir, "telemetry.jsonl");
    const telemetry = new TelemetryLog(telemetryPath);
    const board = new SqliteBoard();

    const task = await board.create({ title: "Build the widget", body: "", labels: ["code"], repo: "r" });
    await board.recordDecision({
      taskId: task.id, matchedTags: ["code"], candidates: [], selected: "implementer", confident: true,
      reason: "tag overlap on code", strategy: "rule", decidedAt: new Date().toISOString(),
    });
    await board.recordResult({ taskId: task.id, agentId: "implementer", ok: true, summary: "shipped the widget", actualCost: 0.42, harnessId: "claude-personal" });
    await telemetry.record({ type: "result", taskId: task.id, agentId: "implementer", actualCost: 0.42, harnessId: "claude-personal" });

    const text = await gatherSessionLessons(telemetryPath, board, undefined, join(dir, "memory", "lessons.md"));

    expect(text).toContain("never run before");
    expect(text).toContain("Build the widget");
    expect(text).toContain("shipped the widget");
    expect(text).toContain("tag overlap on code");
    expect(text).toContain("0.4200");
    expect(text).toContain("claude-personal");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("gatherSessionLessons: with a since timestamp, only events strictly newer than it are included", async () => {
  const dir = await tmp();
  try {
    const telemetryPath = join(dir, "telemetry.jsonl");
    const telemetry = new TelemetryLog(telemetryPath);
    const board = new SqliteBoard();

    const oldTask = await board.create({ title: "Old task, already curated", body: "", labels: [], repo: "r" });
    await board.recordResult({ taskId: oldTask.id, agentId: "implementer", ok: true, summary: "old work" });
    await telemetry.record({ type: "result", taskId: oldTask.id, agentId: "implementer" });

    const since = new Date(Date.now() + 10);
    await new Promise((r) => setTimeout(r, 20));

    const newTask = await board.create({ title: "New task, not yet curated", body: "", labels: [], repo: "r" });
    await board.recordResult({ taskId: newTask.id, agentId: "implementer", ok: true, summary: "new work" });
    await telemetry.record({ type: "result", taskId: newTask.id, agentId: "implementer" });

    const text = await gatherSessionLessons(telemetryPath, board, since, join(dir, "memory", "lessons.md"));

    expect(text).toContain(since.toISOString());
    expect(text).toContain("New task, not yet curated");
    expect(text).toContain("new work");
    expect(text).not.toContain("Old task, already curated");
    expect(text).not.toContain("old work");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("gatherSessionLessons: includes the current memory/lessons.md verbatim when one already exists", async () => {
  const dir = await tmp();
  try {
    const telemetryPath = join(dir, "telemetry.jsonl");
    const memoryPath = join(dir, "memory", "lessons.md");
    await mkdir(join(dir, "memory"), { recursive: true });
    await writeFile(memoryPath, "- Existing lesson: always check node_modules before assuming a clean install.");

    const board = new SqliteBoard();
    const text = await gatherSessionLessons(telemetryPath, board, undefined, memoryPath);

    expect(text).toContain("Current memory/lessons.md:");
    expect(text).toContain("Existing lesson: always check node_modules before assuming a clean install.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("gatherSessionLessons: omits the current-memory section entirely when no memory file exists yet", async () => {
  const dir = await tmp();
  try {
    const telemetryPath = join(dir, "telemetry.jsonl");
    const board = new SqliteBoard();

    const text = await gatherSessionLessons(telemetryPath, board, undefined, join(dir, "memory", "lessons.md"));

    expect(text).not.toContain("Current memory/lessons.md:");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("gatherSessionLessons: dedupes a taskId that appears in more than one telemetry line", async () => {
  const dir = await tmp();
  try {
    const telemetryPath = join(dir, "telemetry.jsonl");
    const telemetry = new TelemetryLog(telemetryPath);
    const board = new SqliteBoard();

    const task = await board.create({ title: "Retried task", body: "", labels: [], repo: "r" });
    await board.recordResult({ taskId: task.id, agentId: "implementer", ok: true, summary: "final result" });
    await telemetry.record({ type: "result", taskId: task.id, agentId: "implementer" });
    await telemetry.record({ type: "result", taskId: task.id, agentId: "implementer" });

    const text = await gatherSessionLessons(telemetryPath, board, undefined, join(dir, "memory", "lessons.md"));

    expect(text.split("Retried task").length - 1).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("gatherSessionLessons: no telemetry file at all still returns a well-formed 'nothing new' body", async () => {
  const dir = await tmp();
  try {
    const board = new SqliteBoard();
    const text = await gatherSessionLessons(join(dir, "no-such-file.jsonl"), board, undefined, join(dir, "memory", "lessons.md"));
    expect(text).toContain("No new sessions since the last curation run.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- runMemoryCurationIfDue: the full due-check -> gather -> dispatch cycle ---

function fakeExecutor(run: Executor["run"]): Executor {
  return { id: "fake-readonly", harnessTool: "claude-cli", canHandle: (agent: AgentDef) => agent.tier === "readonly", run };
}

test("runMemoryCurationIfDue: never run before creates a [memory, housekeeping] task and runs it via orchestrator.runNow", async () => {
  const dir = await tmp();
  try {
    const telemetryPath = join(dir, "telemetry.jsonl");
    const memoryPath = join(dir, "memory", "lessons.md");
    const board = new SqliteBoard();
    const registry = await Registry.load();
    // memoryPath threaded through Orchestrator's own options too — its
    // finishResult call is what actually persists memory-curator's
    // summary (see orchestrator.ts), and must never fall back to this
    // repo's real memory/lessons.md default during a test.
    const orchestrator = new Orchestrator(board, registry, new Router(registry), [], undefined, { memoryPath });

    const seen: TaskCard[] = [];
    const ran = await runMemoryCurationIfDue({
      board,
      orchestrator,
      executors: [fakeExecutor(async (task, agent) => {
        seen.push(task);
        return { taskId: task.id, agentId: agent.id, ok: true, summary: "curated lessons" };
      })],
      telemetryPath,
      memoryPath,
      repo: dir,
    });

    expect(ran).toBe(true);
    // runNow returns once in-flight, not once finished — wait for it.
    const deadline = Date.now() + 1000;
    while (seen.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(seen.length).toBe(1);
    expect(seen[0]!.labels).toEqual(["memory", "housekeeping"]);

    // The full loop closes: finishResult's memory-persistence hook
    // actually wrote memory-curator's summary to the injected path, not
    // this repo's real one.
    const deadline2 = Date.now() + 1000;
    let content: string | undefined;
    while (Date.now() < deadline2) {
      content = await readFile(memoryPath, "utf8").catch(() => undefined);
      if (content) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(content).toBe("curated lessons");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runMemoryCurationIfDue: not due yet does nothing at all — no task created", async () => {
  const dir = await tmp();
  try {
    const telemetryPath = join(dir, "telemetry.jsonl");
    const telemetry = new TelemetryLog(telemetryPath);
    await telemetry.record({ type: "result", taskId: "prior-curation", agentId: "memory-curator" });

    const board = new SqliteBoard();
    const registry = await Registry.load();
    const orchestrator = new Orchestrator(board, registry, new Router(registry), []);

    const ran = await runMemoryCurationIfDue({
      board,
      orchestrator,
      executors: [],
      telemetryPath,
      intervalHours: 24,
      repo: dir,
    });

    expect(ran).toBe(false);
    expect(await board.list()).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- manifest contract guard (docs/SDD-memory-curator.md §6) ---
// finishResult writes memory-curator's raw final message to
// memory/lessons.md, byte for byte (see orchestrator.ts's
// `outputs.includes("memory-entries")` hook). That makes the manifest's
// own `outputContract` load-bearing in a way no other readonly agent's
// is: without it, a conversational "Here's the curated memory:" preamble
// would get written straight into the one file injected into every
// future agent's prompt. These tests guard against that contract
// silently regressing — either by being deleted from the manifest, or
// by someone flipping on outputContractFormat: "review-verdict" (which
// would make runClaude reject every prose-only memory-curator run
// outright, since it never produces a ```review-verdict``` block).

test("manifest: memory-curator declares an outputContract instructing no preamble/wholesale replacement", async () => {
  const registry = await Registry.load();
  const agent = registry.get("memory-curator");
  expect(agent).toBeDefined();
  expect(agent!.outputs).toContain("memory-entries");
  expect(agent!.outputContract).toBeDefined();
  expect(agent!.outputContract).toContain("wholesale replacement");
  expect(agent!.outputContract!.toLowerCase()).toContain("no preamble");
});

test("manifest: memory-curator is NOT routed through review-verdict parsing — its outputContractFormat must stay unset", async () => {
  const registry = await Registry.load();
  const agent = registry.get("memory-curator");
  expect(agent!.outputContractFormat).toBeUndefined();
});

test("runClaude trusts memory-curator's real manifest entry: a prose-only final message is never contract-rejected", async () => {
  const registry = await Registry.load();
  const agent = registry.get("memory-curator")!;
  const task: TaskCard = { id: "t1", title: "Curate session memory", body: "raw lessons", labels: ["memory", "housekeeping"], repo: "/tmp", status: "ready" };

  const curated = "- Always run `bun test` before reporting done.\n- Reviewer rejects missing test coverage — write tests up front.";
  const result = await runClaude({
    runner: async () => ({
      stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: curated }),
      stderr: "",
      exitCode: 0,
    }),
    task,
    agent,
    permissionMode: "plan",
  });

  expect(result.ok).toBe(true);
  expect(result.summary).toBe(curated);
});
