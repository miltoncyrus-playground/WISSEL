import { expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { Router } from "../src/core/router.ts";
import { Orchestrator, finishResult, resolveHandoffAllowlist, resolveLiveTip, type OrchestratorOptions } from "../src/core/orchestrator.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { TelemetryLog } from "../src/services/telemetry.ts";
import type { AgentDef, Executor, Harness, TaskCard } from "../src/core/types.ts";

// agents/manifest.yaml's real tags: "intake" -> triager (readonly),
// "code" -> implementer (write). Using the real registry/router (not
// mocks) means these tests exercise real tag-overlap routing, not a
// fabricated decision.
async function setup(executors: Executor[], opts?: OrchestratorOptions) {
  const board = new SqliteBoard();
  const registry = await Registry.load();
  const orchestrator = new Orchestrator(board, registry, new Router(registry), executors, undefined, opts);
  return { board, registry, orchestrator };
}

function fakeExecutor(tier: "readonly" | "write", run: Executor["run"], harnessTool: Executor["harnessTool"] = "claude-cli"): Executor {
  return { id: `fake-${tier}`, harnessTool, canHandle: (agent: AgentDef) => agent.tier === tier, run };
}

test("sweep routes an unblocked task and runs it on the matching executor", async () => {
  const seen: TaskCard[] = [];
  const { board, orchestrator } = await setup([
    fakeExecutor("readonly", async (task, agent) => {
      seen.push(task);
      return { taskId: task.id, agentId: agent.id, ok: true, summary: "triaged" };
    }),
  ]);

  const task = await board.create({ title: "raw input", body: "", labels: ["intake"], repo: "r" });
  await orchestrator.sweep();

  const updated = await board.get(task.id);
  expect(updated!.status).toBe("done");
  expect(updated!.routedTo).toBe("triager");
  expect(seen.map((t) => t.id)).toEqual([task.id]);
});

test("with a HarnessPool configured, a locally-run task is stamped with the picked harness before it finishes, and released after", async () => {
  const seenHarness: (Harness | undefined)[] = [];
  const harnesses = HarnessPool.from([{ id: "claude-personal", tool: "claude-cli", label: "Claude — personal", enabled: true }]);
  const { board, orchestrator } = await setup(
    [
      fakeExecutor("readonly", async (task, agent, harness) => {
        seenHarness.push(harness);
        // The task must already show the harness live, mid-run — not
        // only after the result comes back.
        expect((await board.get(task.id))!.harness).toBe("claude-personal");
        expect(harnesses.activeCount("claude-personal")).toBe(1);
        return { taskId: task.id, agentId: agent.id, ok: true, summary: "triaged" };
      }),
    ],
    { harnesses },
  );

  const task = await board.create({ title: "raw input", body: "", labels: ["intake"], repo: "r" });
  await orchestrator.sweep();

  expect(seenHarness.map((h) => h?.id)).toEqual(["claude-personal"]);
  expect(harnesses.activeCount("claude-personal")).toBe(0);
  expect((await board.get(task.id))!.harness).toBe("claude-personal");
});

test("acquires from the executor's own harnessTool, not a fixed claude-cli — the actual bug behind adding this field", async () => {
  const seenHarness: (Harness | undefined)[] = [];
  const harnesses = HarnessPool.from([
    { id: "claude-personal", tool: "claude-cli", label: "Claude — personal", enabled: true },
    { id: "my-api-key", tool: "anthropic-api", label: "Anthropic API", enabled: true, apiKeyEnv: "ANTHROPIC_API_KEY" },
  ]);
  const { board, orchestrator } = await setup(
    [
      fakeExecutor(
        "readonly",
        async (task, agent, harness) => {
          seenHarness.push(harness);
          return { taskId: task.id, agentId: agent.id, ok: true, summary: "answered" };
        },
        "anthropic-api",
      ),
    ],
    { harnesses },
  );

  const task = await board.create({ title: "raw input", body: "", labels: ["intake"], repo: "r" });
  await orchestrator.sweep();

  expect(seenHarness.map((h) => h?.id)).toEqual(["my-api-key"]);
});

test("with no HarnessPool configured, a locally-run task gets no harness — identical to wissel's behavior before harnesses existed", async () => {
  const seenHarness: (Harness | undefined)[] = [];
  const { board, orchestrator } = await setup([
    fakeExecutor("readonly", async (task, agent, harness) => {
      seenHarness.push(harness);
      return { taskId: task.id, agentId: agent.id, ok: true, summary: "triaged" };
    }),
  ]);

  const task = await board.create({ title: "raw input", body: "", labels: ["intake"], repo: "r" });
  await orchestrator.sweep();

  expect(seenHarness).toEqual([undefined]);
  expect((await board.get(task.id))!.harness).toBeUndefined();
});

test("a write-tier task is handed off, not run — wissel never spawns execution itself", async () => {
  const { board, orchestrator } = await setup([
    // A write-tier executor here would prove the bug: the orchestrator
    // must never reach for it.
    fakeExecutor("write", async () => {
      throw new Error("orchestrator must not execute write-tier work itself");
    }),
  ]);

  const task = await board.create({ title: "build the thing", body: "", labels: ["code"], repo: "r" });
  await orchestrator.sweep();

  const updated = await board.get(task.id);
  expect(updated!.status).toBe("dispatched");
  expect(updated!.routedTo).toBe("implementer");
});

test("with executeWriteTier on, a write-tier task runs on a registered write executor instead of being handed off", async () => {
  const seen: TaskCard[] = [];
  const { board, orchestrator } = await setup(
    [
      fakeExecutor("write", async (task, agent) => {
        seen.push(task);
        return { taskId: task.id, agentId: agent.id, ok: true, summary: "opened a PR" };
      }),
    ],
    { executeWriteTier: true },
  );

  const task = await board.create({ title: "build the thing", body: "", labels: ["code"], repo: "r" });
  await orchestrator.sweep();

  const updated = await board.get(task.id);
  // Success still gates on review — now via an automatic reviewer pass
  // first (pending-review), since the real "implementer" agent declares
  // handoffs: [reviewer] (see orchestrator-review-lifecycle.test.ts for
  // the full auto-handoff flow). Running it locally doesn't relax that
  // gate.
  expect(updated!.status).toBe("pending-review");
  expect(updated!.routedTo).toBe("implementer");
  expect(seen.map((t) => t.id)).toEqual([task.id]);
});

test("executeWriteTier on with no write executor registered errors out instead of silently handing off", async () => {
  const { board, orchestrator } = await setup([], { executeWriteTier: true });

  const task = await board.create({ title: "build the thing", body: "", labels: ["code"], repo: "r" });
  await orchestrator.sweep();

  const updated = await board.get(task.id);
  expect(updated!.status).toBe("inbox");
  expect(updated!.routedTo).toBeUndefined();
});

// Regression: a write-tier agent that does NOT declare handoffs: [reviewer]
// (unlike the real "implementer" agent, which now does — see
// orchestrator-review-lifecycle.test.ts) must keep wissel's original
// review gate exactly as it always was, with no auto-handoff detour.
const plainWriteAgent: AgentDef = {
  id: "plain-write",
  name: "Plain write",
  kind: "agent",
  tier: "write",
  description: "d",
  whenToUse: "w",
  tags: [],
  executor: "handoff",
  inputs: [],
  outputs: [],
  trustLevel: "medium",
  toolAccess: [],
  costProfile: { model: "claude-sonnet-5", estUsdPerTask: 0.1 },
};

test("finishResult moves a successful write-tier report to review, not done, when the agent declares no reviewer handoff", async () => {
  const board = new SqliteBoard();
  const registry = Registry.from([plainWriteAgent]);
  const task = await board.create({ title: "build the thing", body: "", labels: [], repo: "r" });

  await finishResult(board, registry, { taskId: task.id, agentId: "plain-write", ok: true, summary: "opened a PR" });

  expect((await board.get(task.id))!.status).toBe("review");
});

test("finishResult moves a successful readonly report straight to done", async () => {
  const { board, registry } = await setup([]);
  const task = await board.create({ title: "triage", body: "", labels: ["intake"], repo: "r" });

  await finishResult(board, registry, { taskId: task.id, agentId: "triager", ok: true, summary: "triaged" });

  expect((await board.get(task.id))!.status).toBe("done");
});

test("finishResult moves any failed report to failed", async () => {
  const { board, registry } = await setup([]);
  const task = await board.create({ title: "build the thing", body: "", labels: ["code"], repo: "r" });

  await finishResult(board, registry, { taskId: task.id, agentId: "implementer", ok: false, summary: "broke" });

  expect((await board.get(task.id))!.status).toBe("failed");
});

// autoMerge is the one deliberate, narrow exception to the write-tier
// review gate (AgentDef.autoMerge) — these exercise it directly against
// a synthetic agent rather than the real manifest, so they don't depend
// on any agent in agents/manifest.yaml ever opting in.
const autoMergeAgent: AgentDef = {
  id: "trusted-auto",
  name: "Trusted auto",
  kind: "agent",
  tier: "write",
  description: "d",
  whenToUse: "w",
  tags: [],
  executor: "handoff",
  inputs: [],
  outputs: [],
  trustLevel: "high",
  toolAccess: [],
  costProfile: { model: "claude-sonnet-5", estUsdPerTask: 0.1 },
  autoMerge: true,
};

test("autoMerge + trustLevel high, no worktree on the result — lands straight on done, no git touched", async () => {
  const board = new SqliteBoard();
  const registry = Registry.from([autoMergeAgent]);
  const task = await board.create({ title: "t", body: "", labels: [], repo: "/repo" });
  let gitCalled = false;
  const runner = async (cmd: string[]) => {
    gitCalled = true;
    return { stdout: "", stderr: "", exitCode: 0 };
  };

  await finishResult(board, registry, { taskId: task.id, agentId: "trusted-auto", ok: true, summary: "done" }, undefined, runner);

  expect((await board.get(task.id))!.status).toBe("done");
  expect(gitCalled).toBe(false);
});

test("autoMerge + trustLevel high, a worktree result — actually merges (real git commands), then lands on done", async () => {
  const board = new SqliteBoard();
  const registry = Registry.from([autoMergeAgent]);
  const task = await board.create({ title: "t", body: "", labels: [], repo: "/repo" });
  const seenCmds: string[][] = [];
  const runner = async (cmd: string[]) => {
    seenCmds.push(cmd);
    return { stdout: "", stderr: "", exitCode: 0 };
  };

  await finishResult(
    board,
    registry,
    { taskId: task.id, agentId: "trusted-auto", ok: true, summary: "done", worktree: { path: "/wt/t", branch: "wissel/t" } },
    undefined,
    runner,
  );

  expect((await board.get(task.id))!.status).toBe("done");
  expect(seenCmds.some((c) => c[0] === "git" && c[1] === "merge")).toBe(true);
  expect(seenCmds.some((c) => c[0] === "git" && c[1] === "worktree" && c[2] === "remove")).toBe(true);
});

test("autoMerge + trustLevel high, but the merge actually conflicts — falls back to review, not a silent done", async () => {
  const board = new SqliteBoard();
  const registry = Registry.from([autoMergeAgent]);
  const task = await board.create({ title: "t", body: "", labels: [], repo: "/repo" });
  const runner = async (cmd: string[]) => {
    if (cmd[1] === "merge") return { stdout: "", stderr: "CONFLICT", exitCode: 1 };
    return { stdout: "", stderr: "", exitCode: 0 };
  };

  await finishResult(
    board,
    registry,
    { taskId: task.id, agentId: "trusted-auto", ok: true, summary: "done", worktree: { path: "/wt/t", branch: "wissel/t" } },
    undefined,
    runner,
  );

  expect((await board.get(task.id))!.status).toBe("review");
});

test("autoMerge alone, without trustLevel: high, does NOT skip review — both conditions required together", async () => {
  const board = new SqliteBoard();
  const registry = Registry.from([{ ...autoMergeAgent, trustLevel: "medium" }]);
  const task = await board.create({ title: "t", body: "", labels: [], repo: "/repo" });

  await finishResult(board, registry, { taskId: task.id, agentId: "trusted-auto", ok: true, summary: "done" });

  expect((await board.get(task.id))!.status).toBe("review");
});

test("trustLevel: high alone, without autoMerge, does NOT skip review either", async () => {
  const board = new SqliteBoard();
  const registry = Registry.from([{ ...autoMergeAgent, autoMerge: undefined }]);
  const task = await board.create({ title: "t", body: "", labels: [], repo: "/repo" });

  await finishResult(board, registry, { taskId: task.id, agentId: "trusted-auto", ok: true, summary: "done" });

  expect((await board.get(task.id))!.status).toBe("review");
});

// --- planner subtask-plan -> real cards (structured-output contract) ---
// The planner stays readonly/plan-mode with zero write access; a result
// carrying `subtaskPlan` (see TaskResult.subtaskPlan) is turned into real
// child cards by finishResult's own deterministic code
// (spawnSubtasksFromPlan), never by the LLM acting on its own plan.

const plannerAgent: AgentDef = {
  id: "planner",
  name: "Planner",
  kind: "agent",
  tier: "readonly",
  description: "Decomposes a vague card into subtasks with acceptance criteria.",
  whenToUse: "Card describes an outcome but not the steps to get there.",
  tags: ["planning", "decomposition"],
  executor: "readonly",
  inputs: ["task-card"],
  outputs: ["subtask-cards", "acceptance-criteria"],
  trustLevel: "low",
  toolAccess: ["read"],
  costProfile: { model: "claude-sonnet-5", estUsdPerTask: 0.08 },
  outputContractFormat: "subtask-plan",
  outputContract: "Your final message must end with a ```subtask-plan``` block.",
};

test("the real manifest's planner entry declares the subtask-plan output contract (agents/manifest.yaml)", async () => {
  const realPlanner = (await Registry.load()).get("planner")!;
  expect(realPlanner.outputContractFormat).toBe("subtask-plan");
  expect(realPlanner.outputContract).toBeDefined();
  expect(realPlanner.outputContract).toContain("```subtask-plan");
  expect(realPlanner.tier).toBe("readonly"); // must stay plan-mode/zero-write — the whole point of this contract
});

test("a planner's subtaskPlan spawns real child cards with correct parentTaskId/dependsOn/labels/body, and the planner lands on done", async () => {
  const board = new SqliteBoard();
  const registry = Registry.from([plannerAgent]);
  const plannerTask = await board.create({ title: "Add feature X", body: "Vague outcome.", labels: ["planning"], repo: "r" });

  await finishResult(board, registry, {
    taskId: plannerTask.id,
    agentId: "planner",
    ok: true,
    summary: "decomposed",
    subtaskPlan: [
      { title: "Add types", body: "Add the interface to types.ts.", labels: ["code"] },
      { title: "Add parser", body: "Add the parser module.", labels: ["code"], dependsOnIndex: 0 },
      { title: "Write docs", body: "Update the changelog.", labels: ["docs", "changelog", "release"] },
    ],
  });

  expect((await board.get(plannerTask.id))!.status).toBe("done");

  const children = (await board.list()).filter((t) => t.parentTaskId === plannerTask.id);
  expect(children).toHaveLength(3);

  const byTitle = new Map(children.map((c) => [c.title, c]));
  const addTypes = byTitle.get("Add types")!;
  const addParser = byTitle.get("Add parser")!;
  const writeDocs = byTitle.get("Write docs")!;

  expect(addTypes.body).toBe("Add the interface to types.ts.");
  expect(addTypes.labels).toEqual(["code"]);
  expect(addTypes.repo).toBe("r");
  expect(addTypes.dependsOn).toEqual([]);

  expect(addParser.dependsOn).toEqual([addTypes.id]);
  expect(writeDocs.labels).toEqual(["docs", "changelog", "release"]);
  expect(writeDocs.dependsOn).toEqual([]);
});

test("a planner-spawned child with dependsOnIndex on an undone predecessor is not eligible for sweep dispatch", async () => {
  const { board, registry, orchestrator } = await setup([
    fakeExecutor("readonly", async () => {
      throw new Error("should never run — the blocked child depends on an undone sibling");
    }),
  ]);
  const plannerTask = await board.create({ title: "Add feature X", body: "Vague outcome.", labels: ["planning"], repo: "r" });

  await finishResult(board, registry, {
    taskId: plannerTask.id,
    agentId: "planner",
    ok: true,
    summary: "decomposed",
    subtaskPlan: [
      { title: "First step", body: "Do this first.", labels: ["ci", "tests", "bugfix"] },
      { title: "Second step", body: "Then this.", labels: ["ci", "tests", "bugfix"], dependsOnIndex: 0 },
    ],
  });

  const children = (await board.list()).filter((t) => t.parentTaskId === plannerTask.id);
  const first = children.find((t) => t.title === "First step")!;
  const second = children.find((t) => t.title === "Second step")!;
  expect(second.dependsOn).toEqual([first.id]);

  await orchestrator.sweep();

  // "First step"'s tags route it (write-tier) to "fixer" in the real
  // manifest, which sweep() hands off rather than runs — it never
  // reaches "done" in this fixture regardless, which is exactly what
  // keeps "Second step" blocked: the assertion that matters is that the
  // blocked child was never dispatched.
  expect((await board.get(first.id))!.status).not.toBe("done");
  expect((await board.get(second.id))!.status).toBe("inbox");
  expect((await board.get(second.id))!.routedTo).toBeUndefined();
});

test("a planner routed through a real sweep() spawns subtasks that route to fixer and pr-description-writer, not no-match — resolveHandoffAllowlist must not restrict a subtask-plan agent's children to its own declared handoffs", async () => {
  const { board, orchestrator } = await setup([
    fakeExecutor("readonly", async (task, agent) => {
      if (agent.id !== "planner") return { taskId: task.id, agentId: agent.id, ok: true, summary: "ran" };
      return {
        taskId: task.id,
        agentId: agent.id,
        ok: true,
        summary: "decomposed",
        subtaskPlan: [
          { title: "Fix the failing test", body: "Make CI green again.", labels: ["ci", "tests", "bugfix"] },
          { title: "Write the PR description", body: "Draft the PR body.", labels: ["docs", "pr"] },
        ],
      };
    }),
  ]);

  const plannerTask = await board.create({ title: "Add feature X", body: "Vague outcome.", labels: ["planning", "decomposition"], repo: "r" });

  // Routes AND runs the planner for real — unlike calling finishResult
  // directly, this is what actually stamps `routedTo: "planner"` on the
  // parent, the precondition resolveHandoffAllowlist's restriction needs
  // to even engage (see its `!parent?.routedTo` early return).
  await orchestrator.sweep();
  expect((await board.get(plannerTask.id))!.routedTo).toBe("planner");
  expect((await board.get(plannerTask.id))!.status).toBe("done");

  // A second sweep() is required — the subtasks spawned by the first
  // sweep's finishResult call didn't exist when that sweep's task list
  // was snapshotted, so they're only eligible starting next round.
  await orchestrator.sweep();

  const children = (await board.list()).filter((t) => t.parentTaskId === plannerTask.id);
  expect(children).toHaveLength(2);

  const fixerChild = children.find((t) => t.title === "Fix the failing test")!;
  const prChild = children.find((t) => t.title === "Write the PR description")!;

  // Before the fix, resolveHandoffAllowlist restricted both of these to
  // planner's own declared `handoffs` (which never listed fixer or
  // pr-description-writer), so registry.candidatesFor filtered them out
  // entirely and both landed on "no-match" regardless of tag overlap.
  expect(fixerChild.routedTo).toBe("fixer");
  expect(fixerChild.status).toBe("dispatched"); // write-tier, handed off rather than run in this fixture
  expect(prChild.routedTo).toBe("pr-description-writer");
  expect(prChild.status).not.toBe("no-match");
});

test("finishResult never falls through to the plain readonly done-move for a planner result — spawnSubtasksFromPlan owns it", async () => {
  const board = new SqliteBoard();
  const registry = Registry.from([plannerAgent]);
  const plannerTask = await board.create({ title: "Add feature X", body: "Vague outcome.", labels: ["planning"], repo: "r" });

  await finishResult(board, registry, {
    taskId: plannerTask.id,
    agentId: "planner",
    ok: true,
    summary: "decomposed",
    subtaskPlan: [],
  });

  expect((await board.get(plannerTask.id))!.status).toBe("done");
  expect((await board.list()).filter((t) => t.parentTaskId === plannerTask.id)).toHaveLength(0);
});

// --- memory persistence hook (docs/SDD-memory-curator.md §9) ---
// finishResult writes result.summary to memory/lessons.md wholesale,
// but only for an agent whose declared `outputs` includes
// "memory-entries" (read from the manifest contract, never a hardcoded
// agent id) — mirrors the autoMerge tests' shape above.

const memoryCuratorAgent: AgentDef = {
  id: "memory-curator",
  name: "Memory curator",
  kind: "agent",
  tier: "readonly",
  description: "Dedups and promotes session lessons into durable memory.",
  whenToUse: "Scheduled housekeeping, not task-triggered.",
  tags: ["memory", "housekeeping"],
  executor: "readonly",
  inputs: ["session-lessons"],
  outputs: ["memory-entries"],
  trustLevel: "low",
  toolAccess: ["read"],
  costProfile: { model: "claude-sonnet-5", estUsdPerTask: 0.05 },
};

test("finishResult persists result.summary to memory/lessons.md when the routed agent declares outputs: [memory-entries]", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-memory-test-"));
  try {
    const memoryPath = join(dir, "memory", "lessons.md");
    const board = new SqliteBoard();
    const registry = Registry.from([memoryCuratorAgent]);
    const task = await board.create({ title: "Curate session memory", body: "raw lessons", labels: ["memory"], repo: "r" });

    await finishResult(
      board,
      registry,
      { taskId: task.id, agentId: "memory-curator", ok: true, summary: "- Always run bun test before reporting done." },
      undefined,
      undefined,
      memoryPath,
    );

    expect((await board.get(task.id))!.status).toBe("done");
    expect(await readFile(memoryPath, "utf8")).toBe("- Always run bun test before reporting done.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("finishResult replaces memory/lessons.md wholesale, not appends, on a second curation run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-memory-test-"));
  try {
    const memoryPath = join(dir, "memory", "lessons.md");
    const board = new SqliteBoard();
    const registry = Registry.from([memoryCuratorAgent]);
    const first = await board.create({ title: "Curate session memory", body: "raw lessons", labels: ["memory"], repo: "r" });
    await finishResult(board, registry, { taskId: first.id, agentId: "memory-curator", ok: true, summary: "old lesson" }, undefined, undefined, memoryPath);

    const second = await board.create({ title: "Curate session memory", body: "raw lessons", labels: ["memory"], repo: "r" });
    await finishResult(
      board,
      registry,
      { taskId: second.id, agentId: "memory-curator", ok: true, summary: "consolidated lesson, old one dropped" },
      undefined,
      undefined,
      memoryPath,
    );

    const content = await readFile(memoryPath, "utf8");
    expect(content).toBe("consolidated lesson, old one dropped");
    expect(content).not.toContain("old lesson");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("finishResult does nothing to memory/lessons.md for every other agent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-memory-test-"));
  try {
    const memoryPath = join(dir, "memory", "lessons.md");
    const { board, registry } = await setup([]);
    const task = await board.create({ title: "triage", body: "", labels: ["intake"], repo: "r" });

    await finishResult(board, registry, { taskId: task.id, agentId: "triager", ok: true, summary: "triaged" }, undefined, undefined, memoryPath);

    expect((await board.get(task.id))!.status).toBe("done");
    await expect(readFile(memoryPath, "utf8")).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed run ends in failed", async () => {
  const { board, orchestrator } = await setup([
    fakeExecutor("readonly", async (task, agent) => ({ taskId: task.id, agentId: agent.id, ok: false, summary: "broke" })),
  ]);

  const task = await board.create({ title: "raw input", body: "", labels: ["intake"], repo: "r" });
  await orchestrator.sweep();

  expect((await board.get(task.id))!.status).toBe("failed");
});

test("an executor throwing becomes a failed result, not a crash", async () => {
  const { board, orchestrator } = await setup([
    fakeExecutor("readonly", async () => {
      throw new Error("boom");
    }),
  ]);

  const task = await board.create({ title: "raw input", body: "", labels: ["intake"], repo: "r" });
  await orchestrator.sweep();

  expect((await board.get(task.id))!.status).toBe("failed");
});

test("zero tag overlap stops the task before dispatch — never a silent guess", async () => {
  const { board, orchestrator } = await setup([
    fakeExecutor("readonly", async () => {
      throw new Error("should never run — nothing matched confidently");
    }),
  ]);

  const task = await board.create({ title: "??", body: "", labels: ["no-such-label"], repo: "r" });
  await orchestrator.sweep();

  const after = await board.get(task.id);
  expect(after!.status).toBe("no-match");
  expect(after!.routedTo).toBeUndefined();
});

test("a task blocked on an unfinished dependency is left alone until it's done", async () => {
  const { board, orchestrator } = await setup([
    fakeExecutor("readonly", async (task, agent) => ({ taskId: task.id, agentId: agent.id, ok: true, summary: "ok" })),
  ]);

  const dep = await board.create({ title: "design", body: "", labels: ["intake"], repo: "r" });
  const blocked = await board.create({ title: "build", body: "", labels: ["code"], repo: "r", dependsOn: [dep.id] });

  await orchestrator.sweep();
  expect((await board.get(dep.id))!.status).toBe("done"); // unblocked, processed
  const stillBlocked = await board.get(blocked.id);
  expect(stillBlocked!.status).toBe("inbox"); // dependency wasn't done yet at sweep time
  expect(stillBlocked!.routedTo).toBeUndefined();

  await orchestrator.sweep();
  expect((await board.get(blocked.id))!.status).toBe("dispatched"); // now unblocked, write-tier handed off
});

test("a dangling dependsOn id blocks forever rather than being treated as satisfied", async () => {
  const { board, orchestrator } = await setup([fakeExecutor("readonly", async () => {
    throw new Error("should never run");
  })]);

  const task = await board.create({ title: "x", body: "", labels: ["intake"], repo: "r", dependsOn: ["no-such-task"] });
  await orchestrator.sweep();

  expect((await board.get(task.id))!.status).toBe("inbox");
});

test("resolveLiveTip returns the id itself when it was never superseded", () => {
  const a: TaskCard = { id: "a", title: "a", body: "", labels: [], repo: "r", status: "done" };
  expect(resolveLiveTip(a, new Map([["a", a]]))).toBe(a);
});

test("resolveLiveTip follows a supersededBy chain to its live tip", () => {
  const a: TaskCard = { id: "a", title: "a", body: "", labels: [], repo: "r", status: "pending-review", supersededBy: "b" };
  const b: TaskCard = { id: "b", title: "b", body: "", labels: [], repo: "r", status: "pending-review", supersededBy: "c" };
  const c: TaskCard = { id: "c", title: "c", body: "", labels: [], repo: "r", status: "done" };
  const byId = new Map([
    ["a", a],
    ["b", b],
    ["c", c],
  ]);
  expect(resolveLiveTip(a, byId)).toBe(c);
});

test("resolveLiveTip treats a dangling supersededBy pointer as unresolvable, same as a dangling dependsOn id", () => {
  const a: TaskCard = { id: "a", title: "a", body: "", labels: [], repo: "r", status: "pending-review", supersededBy: "no-such-task" };
  expect(resolveLiveTip(a, new Map([["a", a]]))).toBeUndefined();
});

test("resolveLiveTip terminates on a supersededBy cycle instead of hanging, and fails closed (undefined, not a guess)", () => {
  // Shouldn't occur by construction — spawnPushbackImplementer only ever
  // points a superseded card forward to a brand-new id — but the cycle
  // guard must never trust a corrupt chain silently.
  const a: TaskCard = { id: "a", title: "a", body: "", labels: [], repo: "r", status: "pending-review", supersededBy: "b" };
  const b: TaskCard = { id: "b", title: "b", body: "", labels: [], repo: "r", status: "pending-review", supersededBy: "a" };
  const byId = new Map([
    ["a", a],
    ["b", b],
  ]);
  expect(resolveLiveTip(a, byId)).toBeUndefined();
});

test("no matching executor leaves the task unrouted instead of stranding it", async () => {
  const { board, orchestrator } = await setup([]); // no executors at all
  const task = await board.create({ title: "raw input", body: "", labels: ["intake"], repo: "r" });

  await orchestrator.sweep();

  const after = await board.get(task.id);
  expect(after!.status).toBe("inbox");
  expect(after!.routedTo).toBeUndefined();
});

test("concurrent sweeps don't double-run the same task", async () => {
  let runs = 0;
  const { board, orchestrator } = await setup([
    fakeExecutor("readonly", async (task, agent) => {
      runs++;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { taskId: task.id, agentId: agent.id, ok: true, summary: "ok" };
    }),
  ]);

  await board.create({ title: "raw input", body: "", labels: ["intake"], repo: "r" });
  await Promise.all([orchestrator.sweep(), orchestrator.sweep(), orchestrator.sweep()]);

  expect(runs).toBe(1);
});

test("a follow-up task is restricted to its parent agent's declared handoffs, excluding a would-otherwise-win candidate", async () => {
  const { board, orchestrator } = await setup([
    fakeExecutor("readonly", async (task, agent) => ({ taskId: task.id, agentId: agent.id, ok: true, summary: "ok" })),
  ]);

  // Parent routes to triager (handoffs: [planner] in the real manifest).
  const parent = await board.create({ title: "raw input", body: "", labels: ["intake"], repo: "r" });
  await orchestrator.sweep();
  expect((await board.get(parent.id))!.routedTo).toBe("triager");

  // "ci" is a perfect tag match for fixer, which would win unrestricted —
  // but fixer isn't in triager's handoffs, only planner is.
  const child = await board.create({
    title: "follow-up", body: "", labels: ["ci"], repo: "r", parentTaskId: parent.id,
  });
  await orchestrator.sweep();

  const after = await board.get(child.id);
  expect(after!.status).toBe("no-match");
  expect(after!.routedTo).toBeUndefined();
  const decision = await board.getDecision(child.id);
  expect(decision!.reason).toContain("restricted to declared handoffs: planner");
  expect(decision!.candidates.map((c) => c.agentId)).toEqual(["planner"]);
});

test("a follow-up under a parent whose agent never declared handoffs routes unrestricted", async () => {
  const { board, orchestrator } = await setup([
    fakeExecutor("readonly", async (task, agent) => ({ taskId: task.id, agentId: agent.id, ok: true, summary: "ok" })),
  ]);

  // reviewer never declares `handoffs` in the real manifest.
  const parent = await board.create({ title: "review this", body: "", labels: ["review"], repo: "r" });
  await orchestrator.sweep();
  expect((await board.get(parent.id))!.routedTo).toBe("reviewer");

  const child = await board.create({
    title: "follow-up", body: "", labels: ["ci"], repo: "r", parentTaskId: parent.id,
  });
  await orchestrator.sweep();

  expect((await board.get(child.id))!.routedTo).toBe("fixer");
});

test("resolveHandoffAllowlist", async () => {
  const board = new SqliteBoard();
  const registry = Registry.from([
    { id: "a", name: "A", kind: "agent", tier: "readonly", description: "", whenToUse: "", tags: [], executor: "readonly", handoffs: ["b"], inputs: [], outputs: [], trustLevel: "low", toolAccess: [], costProfile: { model: "m", estUsdPerTask: 0.01 } },
    { id: "no-graph", name: "No graph", kind: "agent", tier: "readonly", description: "", whenToUse: "", tags: [], executor: "readonly", inputs: [], outputs: [], trustLevel: "low", toolAccess: [], costProfile: { model: "m", estUsdPerTask: 0.01 } },
    { id: "dead-end", name: "Dead end", kind: "agent", tier: "readonly", description: "", whenToUse: "", tags: [], executor: "readonly", handoffs: [], inputs: [], outputs: [], trustLevel: "low", toolAccess: [], costProfile: { model: "m", estUsdPerTask: 0.01 } },
  ]);

  expect(await resolveHandoffAllowlist(board, registry, undefined)).toBeUndefined();

  const unrouted = await board.create({ title: "t", body: "", labels: [], repo: "r" });
  expect(await resolveHandoffAllowlist(board, registry, unrouted.id)).toBeUndefined();
  expect(await resolveHandoffAllowlist(board, registry, "no-such-task")).toBeUndefined();

  const routedToA = await board.create({ title: "t", body: "", labels: [], repo: "r" });
  await board.recordDecision({
    taskId: routedToA.id, matchedTags: [], candidates: [], selected: "a", confident: true,
    reason: "r", strategy: "manual", decidedAt: new Date().toISOString(),
  });
  expect(await resolveHandoffAllowlist(board, registry, routedToA.id)).toEqual(["b"]);

  const routedToNoGraph = await board.create({ title: "t", body: "", labels: [], repo: "r" });
  await board.recordDecision({
    taskId: routedToNoGraph.id, matchedTags: [], candidates: [], selected: "no-graph", confident: true,
    reason: "r", strategy: "manual", decidedAt: new Date().toISOString(),
  });
  expect(await resolveHandoffAllowlist(board, registry, routedToNoGraph.id)).toBeUndefined();

  const routedToDeadEnd = await board.create({ title: "t", body: "", labels: [], repo: "r" });
  await board.recordDecision({
    taskId: routedToDeadEnd.id, matchedTags: [], candidates: [], selected: "dead-end", confident: true,
    reason: "r", strategy: "manual", decidedAt: new Date().toISOString(),
  });
  // [] is a real, deliberate restriction — must come back as [], not undefined.
  expect(await resolveHandoffAllowlist(board, registry, routedToDeadEnd.id)).toEqual([]);
});

test("start() reacts to a task created after it begins watching", async () => {
  const { board, orchestrator } = await setup([
    fakeExecutor("readonly", async (task, agent) => ({ taskId: task.id, agentId: agent.id, ok: true, summary: "ok" })),
  ]);
  orchestrator.start();

  const task = await board.create({ title: "raw input", body: "", labels: ["intake"], repo: "r" });

  const deadline = Date.now() + 1000;
  let status: TaskCard["status"] = "inbox";
  while (Date.now() < deadline) {
    status = (await board.get(task.id))!.status;
    if (status !== "inbox") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  expect(status).toBe("done");
});

test("runNow executes a write-tier task immediately even without executeWriteTier on — a human's per-task decision overrides the blanket gate", async () => {
  const { board, orchestrator } = await setup([]); // no auto executors, no executeWriteTier
  const task = await board.create({ title: "build the thing", body: "", labels: ["code"], repo: "r" });

  await orchestrator.runNow(task.id, [
    fakeExecutor("write", async (t, agent) => ({ taskId: t.id, agentId: agent.id, ok: true, summary: "opened a PR" })),
  ]);
  // runNow returns once the run is in flight, not once it's done —
  // wait for the background process() to land. "implementer" declares
  // handoffs: [reviewer], so a successful run lands on pending-review
  // (with an auto-created reviewer task), not a bare review.
  await waitForStatus(board, task.id, "pending-review");

  const updated = await board.get(task.id);
  expect(updated!.routedTo).toBe("implementer");
  expect(updated!.status).toBe("pending-review");
});

test("runNow throws synchronously for an unknown task, before touching anything", async () => {
  const { orchestrator } = await setup([]);
  await expect(orchestrator.runNow("no-such-task", [])).rejects.toThrow("task not found");
});

test("runNow throws if a run for that task is already in flight", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const { board, orchestrator } = await setup([]);
  const task = await board.create({ title: "build the thing", body: "", labels: ["code"], repo: "r" });

  await orchestrator.runNow(task.id, [
    fakeExecutor("write", async (t, agent) => {
      await blocked;
      return { taskId: t.id, agentId: agent.id, ok: true, summary: "ok" };
    }),
  ]);

  await expect(orchestrator.runNow(task.id, [])).rejects.toThrow("already running");
  release();
  await waitForStatus(board, task.id, "pending-review");
});

test("runNow rejects a click on a superseded task instead of resurrecting its abandoned worktree", async () => {
  const { board, orchestrator } = await setup([]);
  const original = await board.create({ title: "build the thing", body: "", labels: ["code"], repo: "r" });
  const reattempt = await board.create({
    title: "build the thing", body: "", labels: ["code"], repo: "r", reviewLineageId: original.id, pushbackCount: 1,
  });
  await board.setSupersededBy(original.id, reattempt.id);

  await expect(orchestrator.runNow(original.id, [])).rejects.toThrow(
    `task ${original.id} was superseded by ${reattempt.id} — run that task instead`,
  );
});

async function waitForStatus(board: SqliteBoard, taskId: string, status: TaskCard["status"]): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if ((await board.get(taskId))!.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`task ${taskId} never reached status ${status}`);
}

// Real bug, found live: registered in server.ts's exact order
// [ReadOnlyExecutor, ApiExecutor, ...], a "question"-tagged task routed
// correctly to quick-answer (executor: api) but ReadOnlyExecutor —
// also tier: readonly — won the pool's find() and tried to spawn a
// real `claude` process instead of ApiExecutor ever running. Uses the
// real executor classes together, in the real order, to catch exactly
// this class of bug at the level it actually showed up.
test("a question-tagged task routes to quick-answer and actually runs on ApiExecutor, not ReadOnlyExecutor, despite ReadOnlyExecutor being registered first", async () => {
  const { ReadOnlyExecutor } = await import("../src/executors/readonly.ts");
  const { ApiExecutor } = await import("../src/executors/anthropic-api.ts");

  let apiExecutorRan = false;
  const executors: Executor[] = [
    new ReadOnlyExecutor({ runner: async () => { throw new Error("ReadOnlyExecutor should never run for an executor: api agent"); } }),
    new ApiExecutor({
      clientFactory: () => ({
        messages: {
          create: async () => {
            apiExecutorRan = true;
            return {
              id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5",
              content: [{ type: "text", text: "pong", citations: null }],
              stop_reason: "end_turn", stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 2 },
            } as never;
          },
        },
      }),
    }),
  ];

  const board = new SqliteBoard();
  const registry = await Registry.load();
  const orchestrator = new Orchestrator(board, registry, new Router(registry), executors);

  const task = await board.create({ title: "What is the capital of France?", body: "", labels: ["question"], repo: "/tmp" });
  await orchestrator.sweep();

  expect(apiExecutorRan).toBe(true);
  const updated = await board.get(task.id);
  expect(updated!.routedTo).toBe("quick-answer");
  expect(updated!.status).toBe("done");
});

// --- retryAfter gating (docs/SDD-pipeline-automation.md §3.2) ---

test("a task with a future retryAfter is skipped by sweep(), same as a blocked dependency", async () => {
  const { board, orchestrator } = await setup([
    fakeExecutor("readonly", async (task, agent) => ({ taskId: task.id, agentId: agent.id, ok: true, summary: "ok" })),
  ]);
  const task = await board.create({ title: "raw input", body: "", labels: ["intake"], repo: "r" });
  await board.scheduleRetry(task.id, new Date(Date.now() + 60_000).toISOString());

  await orchestrator.sweep();

  const after = await board.get(task.id);
  expect(after!.status).toBe("inbox");
  expect(after!.routedTo).toBeUndefined();
});

test("a task whose retryAfter has already passed is eligible again", async () => {
  const { board, orchestrator } = await setup([
    fakeExecutor("readonly", async (task, agent) => ({ taskId: task.id, agentId: agent.id, ok: true, summary: "ok" })),
  ]);
  const task = await board.create({ title: "raw input", body: "", labels: ["intake"], repo: "r" });
  await board.scheduleRetry(task.id, new Date(Date.now() - 60_000).toISOString());

  await orchestrator.sweep();

  expect((await board.get(task.id))!.status).toBe("done");
});

test("finishResult reschedules a retryAfter result instead of failing the task — a 429 isn't a real failure", async () => {
  const { board, registry } = await setup([]);
  const task = await board.create({ title: "build the thing", body: "", labels: ["code"], repo: "r" });
  await board.recordDecision({
    taskId: task.id, matchedTags: [], candidates: [], selected: "implementer", confident: true,
    reason: "r", strategy: "manual", decidedAt: new Date().toISOString(),
  });

  const retryAfter = new Date(Date.now() + 60_000).toISOString();
  await finishResult(board, registry, { taskId: task.id, agentId: "implementer", ok: false, summary: "session limit hit", retryAfter });

  const after = await board.get(task.id);
  expect(after!.status).toBe("inbox");
  expect(after!.routedTo).toBeUndefined();
  expect(after!.retryAfter).toBe(retryAfter);
});

test("a real 429-then-retry round trip through sweep()/WriteExecutor reuses the exact same worktree, no fresh one created", async () => {
  const { WriteExecutor } = await import("../src/executors/write.ts");
  const home = await mkdtemp(join(tmpdir(), "wissel-429-retry-test-"));
  try {
    const seenCwds: string[] = [];
    let call = 0;
    const runner = async (cmd: string[], opts: { cwd: string }) => {
      if (cmd[0] === "git") return { stdout: "", stderr: "", exitCode: 0 };
      seenCwds.push(opts.cwd);
      call++;
      if (call === 1) {
        // A real 429 shape, captured live.
        return {
          stdout: JSON.stringify({
            type: "result", subtype: "success", is_error: true,
            result: "You've hit your session limit · resets 11:59pm (UTC)",
            total_cost_usd: 1.5, api_error_status: 429,
          }),
          stderr: "",
          exitCode: 1,
        };
      }
      return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "shipped" }), stderr: "", exitCode: 0 };
    };

    const board = new SqliteBoard();
    const registry = await Registry.load();
    const orchestrator = new Orchestrator(board, registry, new Router(registry), [new WriteExecutor({ runner, homeDir: home })], undefined, {
      executeWriteTier: true,
    });

    const task = await board.create({ title: "build the thing", body: "", labels: ["code"], repo: "r" });
    await orchestrator.sweep();

    const afterFirstAttempt = await board.get(task.id);
    expect(afterFirstAttempt!.status).toBe("inbox"); // rescheduled, not failed
    expect(afterFirstAttempt!.retryAfter).toBeDefined();

    // Force the retry eligible immediately instead of waiting out a real
    // 24h window — same task row, so this is purely "is the clock past,"
    // nothing about worktree/lineage identity changes.
    await board.scheduleRetry(task.id, new Date(Date.now() - 1000).toISOString());
    await orchestrator.sweep();

    const afterRetry = await board.get(task.id);
    expect(afterRetry!.status).toBe("pending-review"); // real implementer declares handoffs: [reviewer]
    expect(seenCwds.length).toBe(2);
    expect(seenCwds[0]).toBe(seenCwds[1]); // exact same worktree path both times
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// --- maxConcurrentTasks (docs/SDD-pipeline-automation.md §3.6) ---

test("maxConcurrentTasks caps how many tasks are in flight at once, one dispatch per sweep round until it's freed", async () => {
  let running = 0;
  let maxRunning = 0;
  const releases: (() => void)[] = [];
  const { board, orchestrator } = await setup(
    [
      fakeExecutor("readonly", async (task, agent) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise<void>((resolve) => releases.push(resolve));
        running--;
        return { taskId: task.id, agentId: agent.id, ok: true, summary: "ok" };
      }),
    ],
    { maxConcurrentTasks: 1 },
  );

  const t1 = await board.create({ title: "a", body: "", labels: ["intake"], repo: "r" });
  const t2 = await board.create({ title: "b", body: "", labels: ["intake"], repo: "r" });
  const t3 = await board.create({ title: "c", body: "", labels: ["intake"], repo: "r" });

  const sweep1 = orchestrator.sweep();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(maxRunning).toBe(1); // t2/t3 never even started this round
  expect((await board.get(t2.id))!.routedTo).toBeUndefined();
  expect((await board.get(t3.id))!.routedTo).toBeUndefined();
  releases.shift()!();
  await sweep1;
  expect((await board.get(t1.id))!.status).toBe("done");

  const sweep2 = orchestrator.sweep();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(maxRunning).toBe(1);
  releases.shift()!();
  await sweep2;

  const sweep3 = orchestrator.sweep();
  await new Promise((resolve) => setTimeout(resolve, 10));
  releases.shift()!();
  await sweep3;

  expect((await board.get(t2.id))!.status).toBe("done");
  expect((await board.get(t3.id))!.status).toBe("done");
});

test("maxConcurrentTasks unset (the default) behaves identically to no cap at all", async () => {
  const { board, orchestrator } = await setup([
    fakeExecutor("readonly", async (task, agent) => ({ taskId: task.id, agentId: agent.id, ok: true, summary: "ok" })),
  ]);
  const t1 = await board.create({ title: "a", body: "", labels: ["intake"], repo: "r" });
  const t2 = await board.create({ title: "b", body: "", labels: ["intake"], repo: "r" });

  await orchestrator.sweep();

  expect((await board.get(t1.id))!.status).toBe("done");
  expect((await board.get(t2.id))!.status).toBe("done");
});

// --- spendCeilingUsd (docs/SDD-pipeline-automation.md §3.6) ---

test("spendCeilingUsd stops sweep() from dispatching once today's real recorded spend is at or over it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-telemetry-test-"));
  try {
    const telemetry = new TelemetryLog(join(dir, "telemetry.jsonl"));
    await telemetry.record({ type: "result", taskId: "prior-task", agentId: "implementer", actualCost: 5 });

    const board = new SqliteBoard();
    const registry = await Registry.load();
    const orchestrator = new Orchestrator(
      board,
      registry,
      new Router(registry),
      [fakeExecutor("readonly", async (task, agent) => ({ taskId: task.id, agentId: agent.id, ok: true, summary: "ok" }))],
      telemetry,
      { spendCeilingUsd: 5 },
    );

    const task = await board.create({ title: "raw input", body: "", labels: ["intake"], repo: "r" });
    await orchestrator.sweep();

    const after = await board.get(task.id);
    expect(after!.status).toBe("inbox");
    expect(after!.routedTo).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("spendCeilingUsd set above today's recorded spend lets sweep() dispatch normally", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-telemetry-test-"));
  try {
    const telemetry = new TelemetryLog(join(dir, "telemetry.jsonl"));
    await telemetry.record({ type: "result", taskId: "prior-task", agentId: "implementer", actualCost: 1 });

    const board = new SqliteBoard();
    const registry = await Registry.load();
    const orchestrator = new Orchestrator(
      board,
      registry,
      new Router(registry),
      [fakeExecutor("readonly", async (task, agent) => ({ taskId: task.id, agentId: agent.id, ok: true, summary: "ok" }))],
      telemetry,
      { spendCeilingUsd: 5 },
    );

    const task = await board.create({ title: "raw input", body: "", labels: ["intake"], repo: "r" });
    await orchestrator.sweep();

    expect((await board.get(task.id))!.status).toBe("done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("spendCeilingUsd unset (the default) behaves identically to no cap at all, even with telemetry configured", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-telemetry-test-"));
  try {
    const telemetry = new TelemetryLog(join(dir, "telemetry.jsonl"));
    await telemetry.record({ type: "result", taskId: "prior-task", agentId: "implementer", actualCost: 1000 });

    const board = new SqliteBoard();
    const registry = await Registry.load();
    const orchestrator = new Orchestrator(
      board,
      registry,
      new Router(registry),
      [fakeExecutor("readonly", async (task, agent) => ({ taskId: task.id, agentId: agent.id, ok: true, summary: "ok" }))],
      telemetry,
    );

    const task = await board.create({ title: "raw input", body: "", labels: ["intake"], repo: "r" });
    await orchestrator.sweep();

    expect((await board.get(task.id))!.status).toBe("done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
