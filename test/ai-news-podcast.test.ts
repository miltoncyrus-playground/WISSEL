import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { PipelineRepoRequiredError, startPipelineRun, stepsNeedingRepo, type PipelineRunnerContext } from "../src/core/pipeline-runner.ts";
import { Registry } from "../src/core/registry.ts";
import type { AgentDef, Executor, PipelineDef, PipelineGraph, TaskCard } from "../src/core/types.ts";
import type { CommandRunner } from "../src/executors/claude-cli.ts";
import { ReadOnlyExecutor, WEB_ALLOWED_TOOLS } from "../src/executors/readonly.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { SqlitePipelineStore, type PipelineStore } from "../src/services/pipelines.ts";
import { pipelineNeedsRepo } from "../src/api/public/board-pipelines.js";
import { aiNewsPodcastDraft, AI_NEWS_PODCAST_NAME } from "../pipeline-editor/src/templates.ts";
import { seedAiNewsPipeline } from "../scripts/seed-ai-news-pipeline.ts";

// docs/SDD-ai-news-podcast.md §3.1 to §3.4, gate tests from §4.

const NEWS_AGENTS = ["ai-news-gatherer", "eli5-explainer", "podcast-scriptwriter"] as const;

function agentDef(overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    id: "web-reader",
    name: "Web reader",
    kind: "agent",
    tier: "readonly",
    description: "reads the web",
    whenToUse: "test only",
    tags: ["test-web"],
    executor: "readonly",
    inputs: [],
    outputs: [],
    trustLevel: "low",
    toolAccess: ["web"],
    costProfile: { model: "claude-opus-5-5", estUsdPerTask: 0.01 },
    ...overrides,
  };
}

function task(overrides: Partial<TaskCard> = {}): TaskCard {
  return { id: "t1", title: "t", body: "b", labels: [], repo: "/tmp", status: "ready", ...overrides };
}

const OK = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" });

/** Records every command line ReadOnlyExecutor builds; never spawns. */
function capture(): { runner: CommandRunner; cmds: string[][]; cwds: string[] } {
  const cmds: string[][] = [];
  const cwds: string[] = [];
  const runner: CommandRunner = async (cmd, opts) => {
    cmds.push(cmd);
    cwds.push(opts.cwd);
    return { stdout: OK, stderr: "", exitCode: 0 };
  };
  return { runner, cmds, cwds };
}

// ---- §3.1 web grant -------------------------------------------------

test("web grant: a readonly agent with toolAccess [web] gets --allowedTools WebSearch WebFetch, still in plan mode", async () => {
  const { runner, cmds } = capture();
  await new ReadOnlyExecutor({ runner }).run(task(), agentDef());
  const cmd = cmds[0]!;
  expect(cmd[cmd.indexOf("--permission-mode") + 1]).toBe("plan");
  const at = cmd.indexOf("--allowedTools");
  expect(at).toBeGreaterThan(-1);
  expect(cmd.slice(at + 1)).toEqual(["WebSearch", "WebFetch"]);
  expect([...WEB_ALLOWED_TOOLS]).toEqual(["WebSearch", "WebFetch"]);
});

// The real dispatch path over the real manifest (memory/lessons.md "Tests:
// use the real dispatch path"): every agent ReadOnlyExecutor runs gets
// exactly the command line it had before `web` existed, except the one
// agent that declares `web`.
test("web grant: every real manifest agent ReadOnlyExecutor runs gets an unchanged command line; only the gatherer gains the web tools", async () => {
  const registry = await Registry.load();
  const executor = new ReadOnlyExecutor();
  const handled = registry.all().filter((a) => executor.canHandle(a));
  expect(handled.length).toBeGreaterThan(5);
  expect(handled.map((a) => a.id)).toContain("ai-news-gatherer");
  for (const agent of handled) {
    const { runner, cmds } = capture();
    await new ReadOnlyExecutor({ runner }).run(task(), agent);
    const baseline = ["claude", "-p", "--output-format", "json", "--permission-mode", "plan", "--model", agent.costProfile.model];
    if (agent.toolAccess.includes("web")) {
      expect(agent.id).toBe("ai-news-gatherer");
      expect(cmds[0], agent.id).toEqual([...baseline, "--allowedTools", "WebSearch", "WebFetch"]);
    } else {
      expect(cmds[0], agent.id).toEqual(baseline);
    }
  }
});

test("web grant: the registry rejects web on a write-tier agent, or on a readonly agent another executor runs", () => {
  expect(() => Registry.from([agentDef({ id: "w", tier: "write", executor: "handoff", toolAccess: ["read", "write", "web"] })])).toThrow(
    /agent "w": toolAccess "web" is only for tier: readonly/,
  );
  expect(() => Registry.from([agentDef({ id: "api", executor: "api" })])).toThrow(/agent "api": toolAccess "web"/);
  expect(() => Registry.from([agentDef({ id: "cx", executor: "codex" })])).toThrow(/agent "cx": toolAccess "web"/);
  expect(Registry.from([agentDef()]).get("web-reader")?.toolAccess).toEqual(["web"]);
});

// ---- §3.2 the three agents ------------------------------------------

test("manifest: the three news agents load as readonly pipeline-handoff agents on claude-opus-5-5, each with one tag nobody else uses", async () => {
  const registry = await Registry.load();
  const all = registry.all();
  for (const id of NEWS_AGENTS) {
    const a = registry.get(id);
    expect(a, id).toBeDefined();
    expect(a!.tier).toBe("readonly");
    expect(a!.executor).toBe("readonly");
    expect(a!.kind).toBe("agent");
    expect(a!.outputContractFormat).toBe("pipeline-handoff");
    expect(a!.costProfile.model).toBe("claude-opus-5-5");
    expect(a!.tags).toHaveLength(1);
    const others = all.filter((o) => o.id !== id);
    expect(others.some((o) => o.tags.includes(a!.tags[0]!)), `${id}'s tag ${a!.tags[0]} is shared`).toBe(false);
    expect(a!.toolAccess.includes("write") || a!.toolAccess.includes("bash"), id).toBe(false);
  }
  // The gatherer is the only agent in the whole manifest with web.
  expect(all.filter((a) => a.toolAccess.includes("web")).map((a) => a.id)).toEqual(["ai-news-gatherer"]);
});

test("manifest: each output contract names the exact handoff data shape from the SDD", async () => {
  const registry = await Registry.load();
  const contract = (id: string) => registry.get(id)!.outputContract ?? "";
  for (const key of ['"generatedAt"', '"stories"', '"title"', '"date"', '"sources"', '"facts"']) expect(contract("ai-news-gatherer")).toContain(key);
  for (const key of ['"stories"', '"sources"', '"explanation"', '"whyItMatters"', '"unknowns"']) expect(contract("eli5-explainer")).toContain(key);
  for (const key of ['"quickRead"', '"headline"', '"oneLine"', '"source"', '"script"', '"wordCount"']) expect(contract("podcast-scriptwriter")).toContain(key);
  for (const id of NEWS_AGENTS) expect(contract(id)).toContain("```pipeline-handoff");
});

test("manifest: the gatherer's prompt forbids invented stories, dates and URLs and drops undated or unsourced items", async () => {
  const c = (await Registry.load()).get("ai-news-gatherer")!.outputContract!;
  expect(c).toContain("Never invent a story, a date, a quote, a number or a URL");
  expect(c).toMatch(/no publication date[\s\S]*or with\s+no source URL, is DROPPED/);
  expect(c).toContain("Do not guess a date");
  expect(c).toContain("last 7 days");
});

// ---- §3.4 repo-less runs --------------------------------------------

function handoff(data: Record<string, unknown>): string {
  return JSON.stringify({ type: "result", subtype: "success", is_error: false, result: `done\n\n\`\`\`pipeline-handoff\n${JSON.stringify({ data })}\n\`\`\`` });
}

test("repo-less run: the real AI news pipeline starts with no repo; every step task has no repo and runs in its own scratch workspace", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "wissel-ai-news-scratch-"));
  try {
    const board = new SqliteBoard();
    const registry = await Registry.load();
    const pipelines = new SqlitePipelineStore(board.db);
    const def = await pipelines.create(aiNewsPodcastDraft());
    const cwds: string[] = [];
    const stdins: string[] = [];
    const outputs = [
      handoff({ generatedAt: "2026-10-07", stories: [{ title: "T", date: "2026-10-06", sources: ["https://example.com/a"], facts: "F." }] }),
      handoff({ stories: [{ title: "T", date: "2026-10-06", sources: ["https://example.com/a"], explanation: "E", whyItMatters: "W", unknowns: "U" }] }),
      handoff({ quickRead: [{ headline: "H", oneLine: "O", source: "https://example.com/a" }], script: "S", wordCount: 1 }),
    ];
    const runner: CommandRunner = async (_cmd, opts) => {
      cwds.push(opts.cwd);
      stdins.push(opts.stdin ?? "");
      return { stdout: outputs[cwds.length - 1]!, stderr: "", exitCode: 0 };
    };
    const ctx: PipelineRunnerContext = { executors: [new ReadOnlyExecutor({ runner, homeDir })], pipelines };

    const root = await startPipelineRun(board, registry, def, undefined, "", ctx);

    expect(root.status).toBe("done");
    expect(root.repo).toBeUndefined();
    const steps = (await board.list()).filter((t) => t.pipelineRunId === root.id);
    expect(steps.map((s) => s.pipelineStepId)).toEqual(["gather", "explain", "script"]);
    expect(steps.every((s) => s.repo === undefined && s.status === "done")).toBe(true);
    expect(cwds).toEqual(steps.map((s) => join(homeDir, ".wissel", "scratch", s.id)));
    expect(cwds.every((d) => existsSync(d))).toBe(true);
    // Each step's data reaches the next one as fenced data.
    expect(stdins[1]).toContain('"facts": "F."');
    expect(stdins[2]).toContain('"whyItMatters": "W"');
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

function writeAgent(): AgentDef {
  return agentDef({ id: "writer", tier: "write", executor: "handoff", toolAccess: ["read", "write", "bash"] });
}

const mixedGraph: PipelineGraph = {
  steps: [
    { id: "a", name: "Read", agentId: "reader", transition: "all" },
    { id: "b", name: "Write code", agentId: "writer", transition: "all" },
  ],
  edges: [{ id: "e", from: "a", to: "b" }],
};

test("repo-less run: a pipeline with a write/bash step and no repo throws before anything lands on the board", async () => {
  const board = new SqliteBoard();
  const registry = Registry.from([agentDef({ id: "reader", toolAccess: ["read"] }), writeAgent()]);
  const pipelines = new SqlitePipelineStore(board.db);
  const def = await pipelines.create({ name: "Mixed", description: "", graph: mixedGraph });
  const { runner, cmds } = capture();
  const ctx: PipelineRunnerContext = { executors: [new ReadOnlyExecutor({ runner })], pipelines };

  for (const repo of [undefined, ""]) {
    const err = await startPipelineRun(board, registry, def, repo, "go", ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PipelineRepoRequiredError);
    expect((err as Error).message).toBe('repo is required: pipeline "Mixed" has steps with file/bash access: "Write code" (writer)');
  }
  expect(await board.list()).toEqual([]);
  expect(cmds).toEqual([]);
});

test("stepsNeedingRepo: non-readonly tier or write/bash access needs a repo; read, web, none and unknown agents don't", () => {
  const registry = Registry.from([
    agentDef({ id: "reader", toolAccess: ["read"] }),
    agentDef({ id: "web" }),
    agentDef({ id: "none", toolAccess: [] }),
    agentDef({ id: "ro-bash", toolAccess: ["read", "bash"] }),
    writeAgent(),
  ]);
  const def = (ids: string[]): PipelineDef => ({
    id: "p",
    name: "p",
    description: "",
    graph: { steps: ids.map((id) => ({ id, name: id, agentId: id, transition: "all" as const })), edges: [] },
    createdAt: "",
    updatedAt: "",
  });
  expect(stepsNeedingRepo(def(["reader", "web", "none", "ghost"]), registry)).toEqual([]);
  expect(stepsNeedingRepo(def(["reader", "ro-bash", "writer"]), registry).map((s) => s.id)).toEqual(["ro-bash", "writer"]);
});

test("repo-less run: a write step edited into the definition mid-run fails that step instead of running with no repo", async () => {
  const board = new SqliteBoard();
  const registry = Registry.from([agentDef({ id: "reader", toolAccess: ["read"] }), writeAgent()]);
  const store = new SqlitePipelineStore(board.db);
  const readOnly: PipelineGraph = { steps: [{ id: "a", name: "Read", agentId: "reader", transition: "all" }], edges: [] };
  const def = await store.create({ name: "Edited", description: "", graph: readOnly });
  // The runner re-reads the definition after step "a"; by then it has a write step.
  const pipelines: PipelineStore = { ...store, get: async () => ({ ...def, graph: mixedGraph }), list: () => store.list(), create: (d) => store.create(d), update: (i, d) => store.update(i, d), delete: (i) => store.delete(i) };
  let writeRan = false;
  const fakeWrite: Executor = { id: "fake-write", canHandle: (a) => a.tier === "write", run: async (t, a) => ((writeRan = true), { taskId: t.id, agentId: a.id, ok: true, summary: "wrote" }) };
  const { runner } = capture();
  const ctx: PipelineRunnerContext = { executors: [new ReadOnlyExecutor({ runner }), fakeWrite], pipelines };

  const root = await startPipelineRun(board, registry, def, undefined, "go", ctx);

  expect(root.status).toBe("failed");
  expect(writeRan).toBe(false);
  const b = (await board.list()).find((t) => t.pipelineStepId === "b")!;
  expect(b.status).toBe("failed");
  expect((await board.getResult(b.id))?.summary).toBe('pipeline step "Write code" runs "writer", which has file/bash access, but this run has no repo');
});

// ---- §3.4 API --------------------------------------------------------

function recordingExecutor(seen: TaskCard[]): Executor {
  return { id: "rec", canHandle: () => true, run: async (t, a) => (seen.push(t), { taskId: t.id, agentId: a.id, ok: true, summary: "ok", pipelineHandoff: { data: {} } }) };
}

async function postJson(app: (r: Request) => Promise<Response>, path: string, body: unknown): Promise<Response> {
  return app(new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body) }));
}

test("POST /pipelines/:id/run: an all-readonly pipeline runs with no repo and no input; its tasks carry no repo", async () => {
  const board = new SqliteBoard();
  const seen: TaskCard[] = [];
  const app = createApp(board, await Registry.load(), undefined, { manualExecutors: [recordingExecutor(seen)] });
  const created = (await (await postJson(app, "/pipelines", aiNewsPodcastDraft())).json()) as { id: string };

  const res = await postJson(app, `/pipelines/${created.id}/run`, {});
  expect(res.status).toBe(201);
  const root = (await res.json()) as TaskCard;
  expect(root.status).toBe("done");
  expect(root.repo).toBeUndefined();
  expect(root.body).toBe("");
  expect(seen.map((t) => t.pipelineStepId)).toEqual(["gather", "explain", "script"]);
  expect(seen.every((t) => t.repo === undefined)).toBe(true);

  // Optional input reaches the gather step.
  seen.length = 0;
  await postJson(app, `/pipelines/${created.id}/run`, { input: "focus on open models" });
  expect(seen[0]!.body).toBe("focus on open models");
});

test("POST /pipelines/:id/run: a pipeline with a write step and no repo is a 400 that names the step, and starts nothing", async () => {
  const board = new SqliteBoard();
  const registry = Registry.from([agentDef({ id: "reader", toolAccess: ["read"] }), writeAgent()]);
  const seen: TaskCard[] = [];
  const app = createApp(board, registry, undefined, { manualExecutors: [recordingExecutor(seen)] });
  const created = (await (await postJson(app, "/pipelines", { name: "Mixed", graph: mixedGraph })).json()) as { id: string };

  for (const body of [{ input: "go" }, { repo: "", input: "go" }, { repo: "/tmp/r" }]) {
    const res = await postJson(app, `/pipelines/${created.id}/run`, body);
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      'repo and input are required: this pipeline has steps with file/bash access: "Write code" (writer)',
    );
  }
  expect((await postJson(app, `/pipelines/${created.id}/run`, { repo: 7, input: "go" })).status).toBe(400);
  expect(seen).toEqual([]);
  expect((await board.list()).filter((t) => t.pipelineId === created.id)).toEqual([]);
});

// ---- §3.3 seed script and template ------------------------------------

test("seed: running twice leaves exactly one AI news podcast pipeline, and never overwrites an edited one", async () => {
  const board = new SqliteBoard();
  const store = new SqlitePipelineStore(board.db);
  const registry = await Registry.load();

  const first = await seedAiNewsPipeline(store, registry);
  expect(first.created).toBe(true);
  expect(first.pipeline.name).toBe(AI_NEWS_PODCAST_NAME);
  expect(first.pipeline.graph).toEqual(aiNewsPodcastDraft().graph);

  await store.update(first.pipeline.id, { name: AI_NEWS_PODCAST_NAME, description: "mine", graph: first.pipeline.graph });
  const second = await seedAiNewsPipeline(store, registry);
  expect(second.created).toBe(false);
  expect(second.pipeline.id).toBe(first.pipeline.id);
  expect(second.pipeline.description).toBe("mine");
  expect((await store.list()).filter((p) => p.name === AI_NEWS_PODCAST_NAME)).toHaveLength(1);
});

test("seed: a manifest missing the news agents throws and writes nothing", async () => {
  const board = new SqliteBoard();
  const store = new SqlitePipelineStore(board.db);
  await expect(seedAiNewsPipeline(store, Registry.from([agentDef()]))).rejects.toThrow(
    "agents/manifest.yaml has no agent(s) ai-news-gatherer, eli5-explainer, podcast-scriptwriter",
  );
  expect(await store.list()).toEqual([]);
});

test("template: gather -> explain -> script in a line, transition all, every agent real and repo-less", async () => {
  const draft = aiNewsPodcastDraft();
  const registry = await Registry.load();
  expect(draft.graph.steps.map((s) => [s.id, s.agentId, s.transition])).toEqual([
    ["gather", "ai-news-gatherer", "all"],
    ["explain", "eli5-explainer", "all"],
    ["script", "podcast-scriptwriter", "all"],
  ]);
  expect(draft.graph.edges.map((e) => [e.from, e.to])).toEqual([
    ["gather", "explain"],
    ["explain", "script"],
  ]);
  const def: PipelineDef = { ...draft, id: "x", createdAt: "", updatedAt: "" };
  expect(stepsNeedingRepo(def, registry)).toEqual([]);
  expect(pipelineNeedsRepo(def, registry.all())).toBe(false);
});

// ---- Run dialog rule: board-pipelines.js agrees with the server --------

test("pipelineNeedsRepo agrees with stepsNeedingRepo for a one-step pipeline on every real manifest agent", async () => {
  const registry = await Registry.load();
  for (const agent of registry.all()) {
    const def: PipelineDef = {
      id: "p",
      name: "p",
      description: "",
      graph: { steps: [{ id: "s", name: "s", agentId: agent.id, transition: "all" }], edges: [] },
      createdAt: "",
      updatedAt: "",
    };
    expect(pipelineNeedsRepo(def, registry.all()), agent.id).toBe(stepsNeedingRepo(def, registry).length > 0);
  }
});

test("pipelineNeedsRepo: true until agents are loaded, false for an unknown agent, true for any write step", () => {
  const agents = [agentDef({ id: "reader", toolAccess: ["read"] }), writeAgent()];
  const p = (ids: string[]) => ({ id: "p", name: "p", graph: { steps: ids.map((id) => ({ id, name: id, agentId: id, transition: "all" as const })), edges: [] } });
  expect(pipelineNeedsRepo(p(["reader"]), [])).toBe(true);
  expect(pipelineNeedsRepo(p(["reader"]), null)).toBe(true);
  expect(pipelineNeedsRepo(p(["reader"]), agents)).toBe(false);
  expect(pipelineNeedsRepo(p(["ghost"]), agents)).toBe(false);
  expect(pipelineNeedsRepo(p(["reader", "writer"]), agents)).toBe(true);
  expect(pipelineNeedsRepo(null, agents)).toBe(false);
});
