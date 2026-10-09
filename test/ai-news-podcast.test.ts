import { expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { PipelineRepoRequiredError, startPipelineRun, stepsNeedingRepo, type PipelineRunnerContext } from "../src/core/pipeline-runner.ts";
import { Registry } from "../src/core/registry.ts";
import type { AgentDef, Executor, PipelineDef, PipelineGraph, TaskCard } from "../src/core/types.ts";
import type { CommandRunner } from "../src/executors/claude-cli.ts";
import { ReadOnlyExecutor, WEB_ALLOWED_TOOLS } from "../src/executors/readonly.ts";
import { ApiExecutor } from "../src/executors/anthropic-api.ts";
import { CodexReadOnlyExecutor } from "../src/executors/codex-readonly.ts";
import { CodexWriteExecutor } from "../src/executors/codex-write.ts";
import { WriteExecutor } from "../src/executors/write.ts";
import { TtsExecutor } from "../src/executors/tts.ts";
import { SILENT_MP3_PATH } from "./fixtures/ai-news/make-silent-mp3.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { TelemetryLog } from "../src/services/telemetry.ts";
import { SqlitePipelineStore, type PipelineStore } from "../src/services/pipelines.ts";
import { pipelineNeedsRepo } from "../src/api/public/board-pipelines.js";
import { aiNewsPodcastDraft, AI_NEWS_PODCAST_NAME, worldNewsPodcastDraft, WORLD_NEWS_PODCAST_NAME } from "../pipeline-editor/src/templates.ts";
import { seedAiNewsPipeline, seedWorldNewsPipeline } from "../scripts/seed-ai-news-pipeline.ts";

// docs/SDD-ai-news-podcast.md §3.1 to §3.4, gate tests from §4.

const NEWS_AGENTS = ["ai-news-gatherer", "world-news-gatherer", "eli5-explainer", "podcast-scriptwriter"] as const;
const GATHERERS = ["ai-news-gatherer", "world-news-gatherer"];

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
      expect(GATHERERS).toContain(agent.id);
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

test("manifest: the three news agents load as readonly pipeline-handoff agents on claude-sonnet-5-5 (Milton, 2026-10-07: cheaper model where it makes sense), each with one tag nobody else uses", async () => {
  const registry = await Registry.load();
  const all = registry.all();
  for (const id of NEWS_AGENTS) {
    const a = registry.get(id);
    expect(a, id).toBeDefined();
    expect(a!.tier).toBe("readonly");
    expect(a!.executor).toBe("readonly");
    expect(a!.kind).toBe("agent");
    expect(a!.outputContractFormat).toBe("pipeline-handoff");
    expect(a!.costProfile.model).toBe("claude-sonnet-5-5");
    expect(a!.tags).toHaveLength(1);
    const others = all.filter((o) => o.id !== id);
    expect(others.some((o) => o.tags.includes(a!.tags[0]!)), `${id}'s tag ${a!.tags[0]} is shared`).toBe(false);
    expect(a!.toolAccess.includes("write") || a!.toolAccess.includes("bash"), id).toBe(false);
  }
  // The two gatherers are the only agents in the whole manifest with web.
  expect(all.filter((a) => a.toolAccess.includes("web")).map((a) => a.id)).toEqual(GATHERERS);
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

/** A fake Kokoro-FastAPI on port 0 (never the real one) that speaks
 *  anything as the silent fixture MP3, recording what it was asked to
 *  say. `failSpeech` makes the speech call a 500. */
function fakeKokoro(failSpeech = false): { url: string; inputs: string[]; stop(): void } {
  const inputs: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/health") return Response.json({ status: "healthy" });
      inputs.push(((await req.json()) as { input: string }).input);
      if (failSpeech) return new Response("model crashed", { status: 500 });
      return new Response(readFileSync(SILENT_MP3_PATH), { headers: { "content-type": "audio/mpeg" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, inputs, stop: () => server.stop(true) };
}

const GATHER_OUT = handoff({ generatedAt: "2026-10-07", stories: [{ title: "T", date: "2026-10-06", sources: ["https://example.com/a"], facts: "F." }] });
const EXPLAIN_OUT = handoff({ stories: [{ title: "T", date: "2026-10-06", sources: ["https://example.com/a"], explanation: "E", whyItMatters: "W", unknowns: "U" }] });
const SCRIPT_OUT = handoff({ quickRead: [{ headline: "H", oneLine: "O", source: "https://example.com/a" }], script: "Hello there.\n\nBye now.", wordCount: 4 });

test("repo-less run: the real AI news pipeline starts with no repo; the LLM steps run in their own scratch workspaces and Make audio speaks the script into <audioDir>/<runId>.mp3", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "wissel-ai-news-scratch-"));
  const kokoro = fakeKokoro();
  try {
    const board = new SqliteBoard();
    const registry = await Registry.load();
    const pipelines = new SqlitePipelineStore(board.db);
    const def = await pipelines.create(aiNewsPodcastDraft());
    const cwds: string[] = [];
    const stdins: string[] = [];
    const outputs = [GATHER_OUT, EXPLAIN_OUT, SCRIPT_OUT];
    const runner: CommandRunner = async (_cmd, opts) => {
      cwds.push(opts.cwd);
      stdins.push(opts.stdin ?? "");
      return { stdout: outputs[cwds.length - 1]!, stderr: "", exitCode: 0 };
    };
    const audioDir = join(homeDir, "audio");
    // The server's own pool order: ReadOnlyExecutor first, TtsExecutor
    // after it, so this also proves ReadOnlyExecutor never claims the
    // audio step.
    const telemetryPath = join(homeDir, "telemetry.jsonl");
    const ctx: PipelineRunnerContext = {
      executors: [new ReadOnlyExecutor({ runner, homeDir }), new TtsExecutor({ baseUrl: kokoro.url, audioDir })],
      pipelines,
      telemetry: new TelemetryLog(telemetryPath),
    };

    const root = await startPipelineRun(board, registry, def, undefined, "", ctx);

    expect(root.status).toBe("done");
    expect(root.repo).toBeUndefined();
    const steps = (await board.list()).filter((t) => t.pipelineRunId === root.id);
    expect(steps.map((s) => s.pipelineStepId)).toEqual(["gather", "explain", "script", "audio"]);
    expect(steps.every((s) => s.repo === undefined && s.status === "done")).toBe(true);
    // Three claude calls, one per LLM step; the audio step spawns nothing.
    expect(cwds).toEqual(steps.slice(0, 3).map((s) => join(homeDir, ".wissel", "scratch", s.id)));
    expect(cwds.every((d) => existsSync(d))).toBe(true);
    // Each step's data reaches the next one as fenced data.
    expect(stdins[1]).toContain('"facts": "F."');
    expect(stdins[2]).toContain('"whyItMatters": "W"');
    // The scriptwriter's script, exactly, is what Kokoro was asked to say.
    expect(kokoro.inputs).toEqual(["Hello there.\n\nBye now."]);
    const audioFile = join(audioDir, `${root.id}.mp3`);
    expect(new Uint8Array(readFileSync(audioFile))).toEqual(new Uint8Array(readFileSync(SILENT_MP3_PATH)));
    expect((await board.getResult(steps[3]!.id))?.summary).toContain(`"file":"${audioFile}"`);
    // §3.7 telemetry: the audio step's result event carries bytes and
    // synthesis time so Kokoro's speed can be tracked; no other step's does.
    const results = readFileSync(telemetryPath, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.type === "result");
    const audioEvents = results.filter((e) => e.audio);
    expect(audioEvents).toHaveLength(1);
    expect(audioEvents[0]).toMatchObject({ taskId: steps[3]!.id, agentId: "podcast-audio", actualCost: 0, audio: { bytes: statSync(audioFile).size, synthesisSeconds: expect.any(Number) } });
    expect(results.filter((e) => e.agentId !== "podcast-audio").length).toBeGreaterThanOrEqual(3);
  } finally {
    kokoro.stop();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("Make audio failing fails the run, but the script step stays done with its quick read and script", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "wissel-ai-news-scratch-"));
  const kokoro = fakeKokoro(true);
  try {
    const board = new SqliteBoard();
    const registry = await Registry.load();
    const pipelines = new SqlitePipelineStore(board.db);
    const def = await pipelines.create(aiNewsPodcastDraft());
    let n = 0;
    const outputs = [GATHER_OUT, EXPLAIN_OUT, SCRIPT_OUT];
    const runner: CommandRunner = async () => ({ stdout: outputs[n++]!, stderr: "", exitCode: 0 });
    const audioDir = join(homeDir, "audio");
    const ctx: PipelineRunnerContext = { executors: [new ReadOnlyExecutor({ runner, homeDir }), new TtsExecutor({ baseUrl: kokoro.url, audioDir })], pipelines };

    const root = await startPipelineRun(board, registry, def, undefined, "", ctx);

    expect(root.status).toBe("failed");
    const steps = (await board.list()).filter((t) => t.pipelineRunId === root.id);
    expect(steps.map((s) => [s.pipelineStepId, s.status])).toEqual([["gather", "done"], ["explain", "done"], ["script", "done"], ["audio", "failed"]]);
    expect((await board.getResult(steps[3]!.id))?.summary).toMatch(/^Audio not made: Kokoro TTS at .* returned HTTP 500: model crashed$/);
    expect((await board.getResult(steps[2]!.id))?.summary).toContain('"quickRead"');
    expect(existsSync(join(audioDir, `${root.id}.mp3`))).toBe(false);
  } finally {
    kokoro.stop();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("executor resolution: podcast-audio resolves to TtsExecutor alone; every other manifest agent resolves exactly as it did without TtsExecutor in the pool", async () => {
  const registry = await Registry.load();
  // The server's default manual pool (src/api/server.ts), minus and plus TtsExecutor.
  const before: Executor[] = [new ReadOnlyExecutor(), new ApiExecutor(), new CodexReadOnlyExecutor(), new WriteExecutor(), new CodexWriteExecutor()];
  const after: Executor[] = [...before, new TtsExecutor()];
  const audio = registry.get("podcast-audio")!;
  expect(after.filter((e) => e.canHandle(audio)).map((e) => e.id)).toEqual(["tts"]);
  const others = registry.all().filter((a) => a.id !== "podcast-audio");
  expect(others.length).toBeGreaterThan(10);
  for (const agent of others) {
    const handlers = (pool: Executor[]) => pool.filter((e) => e.canHandle(agent)).map((e) => e.id);
    expect(handlers(after), agent.id).toEqual(handlers(before));
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
  expect(seen.map((t) => t.pipelineStepId)).toEqual(["gather", "explain", "script", "audio"]);
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

test("seed: running twice leaves exactly one AI news podcast pipeline; the second run writes nothing and keeps an edited description", async () => {
  const board = new SqliteBoard();
  const store = new SqlitePipelineStore(board.db);
  const registry = await Registry.load();

  const first = await seedAiNewsPipeline(store, registry);
  expect(first.outcome).toBe("created");
  expect(first.pipeline.name).toBe(AI_NEWS_PODCAST_NAME);
  expect(first.pipeline.graph).toEqual(aiNewsPodcastDraft().graph);

  const edited = await store.update(first.pipeline.id, { name: AI_NEWS_PODCAST_NAME, description: "mine", graph: first.pipeline.graph });
  const second = await seedAiNewsPipeline(store, registry);
  expect(second.outcome).toBe("unchanged");
  expect(second.pipeline.id).toBe(first.pipeline.id);
  expect(second.pipeline.description).toBe("mine");
  expect((await store.get(first.pipeline.id))!.updatedAt).toBe(edited.updatedAt);
  expect((await store.list()).filter((p) => p.name === AI_NEWS_PODCAST_NAME)).toHaveLength(1);
});

// §3.7: the pipeline stored before "Make audio" existed, as card 1 seeded it.
const THREE_STEP_GRAPH: PipelineGraph = {
  steps: [
    { id: "gather", name: "Gather news", agentId: "ai-news-gatherer", transition: "all" },
    { id: "explain", name: "Explain simply", agentId: "eli5-explainer", transition: "all" },
    { id: "script", name: "Write podcast script", agentId: "podcast-scriptwriter", transition: "all" },
  ],
  edges: [
    { id: "gather-explain", from: "gather", to: "explain" },
    { id: "explain-script", from: "explain", to: "script" },
  ],
};

test("seed: the stored three-step pipeline is upgraded to four steps in place (same id, name and description kept, past runs still linked); running again changes nothing", async () => {
  const board = new SqliteBoard();
  const store = new SqlitePipelineStore(board.db);
  const registry = await Registry.load();
  const old = await store.create({ name: AI_NEWS_PODCAST_NAME, description: "the old one", graph: THREE_STEP_GRAPH });
  const pastRun = await board.create({ title: `Pipeline: ${AI_NEWS_PODCAST_NAME}`, body: "", labels: [], pipelineId: old.id });

  const upgraded = await seedAiNewsPipeline(store, registry);
  expect(upgraded.outcome).toBe("updated");
  expect(upgraded.pipeline.id).toBe(old.id);
  expect(upgraded.pipeline.description).toBe("the old one");
  expect(upgraded.pipeline.graph).toEqual(aiNewsPodcastDraft().graph);
  expect(upgraded.pipeline.graph.steps.map((s) => s.name)).toEqual(["Gather news", "Explain simply", "Write podcast script", "Make audio"]);
  expect(await store.list()).toHaveLength(1);
  expect((await store.get((await board.get(pastRun.id))!.pipelineId!))!.graph.steps).toHaveLength(4);

  const again = await seedAiNewsPipeline(store, registry);
  expect(again.outcome).toBe("unchanged");
  expect(again.pipeline).toEqual((await store.get(old.id))!);
  expect((await store.get(old.id))!.updatedAt).toBe(upgraded.pipeline.updatedAt);
  expect(await store.list()).toHaveLength(1);
});

test("seed: a manifest missing the news agents throws and writes nothing", async () => {
  const board = new SqliteBoard();
  const store = new SqlitePipelineStore(board.db);
  await expect(seedAiNewsPipeline(store, Registry.from([agentDef()]))).rejects.toThrow(
    "agents/manifest.yaml has no agent(s) ai-news-gatherer, eli5-explainer, podcast-scriptwriter, podcast-audio",
  );
  expect(await store.list()).toEqual([]);
});

test("template: gather -> explain -> script -> audio in a line, transition all, every agent real and repo-less", async () => {
  const draft = aiNewsPodcastDraft();
  const registry = await Registry.load();
  expect(draft.graph.steps.map((s) => [s.id, s.name, s.agentId, s.transition])).toEqual([
    ["gather", "Gather news", "ai-news-gatherer", "all"],
    ["explain", "Explain simply", "eli5-explainer", "all"],
    ["script", "Write podcast script", "podcast-scriptwriter", "all"],
    ["audio", "Make audio", "podcast-audio", "all"],
  ]);
  expect(draft.graph.edges.map((e) => [e.from, e.to])).toEqual([
    ["gather", "explain"],
    ["explain", "script"],
    ["script", "audio"],
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

// ---- §3.8 the World news podcast ---------------------------------------

test("world news podcast: same explain, script and audio steps as the AI one, only the gather agent differs", () => {
  const ai = aiNewsPodcastDraft().graph;
  const world = worldNewsPodcastDraft().graph;
  expect(world.edges).toEqual(ai.edges);
  expect(world.steps.map((s) => s.id)).toEqual(ai.steps.map((s) => s.id));
  expect(world.steps.map((s) => s.agentId)).toEqual(["world-news-gatherer", "eli5-explainer", "podcast-scriptwriter", "podcast-audio"]);
  expect(world.steps.slice(1)).toEqual(ai.steps.slice(1));
});

test("world-news-gatherer: contract covers world, spain and netherlands with a region field, a 48 hour window and the same source rules", async () => {
  const c = (await Registry.load()).get("world-news-gatherer")!.outputContract!;
  for (const key of ['"region"', '"world"', '"spain"', '"netherlands"', '"generatedAt"', '"stories"', '"sources"', '"facts"', "last 48 hours", "more than 2 days", "No URL may appear in more than one story", "At most 3 stories"]) {
    expect(c).toContain(key);
  }
  // The shared steps pass region through and group by it.
  const reg = await Registry.load();
  expect(reg.get("eli5-explainer")!.outputContract).toContain("`region` (when present)");
  expect(reg.get("podcast-scriptwriter")!.outputContract).toContain("grouped in input order (world, then Spain, then the");
});

test("seed: both news pipelines coexist with their own ids, and reseeding changes neither", async () => {
  const board = new SqliteBoard();
  const store = new SqlitePipelineStore(board.db);
  const registry = await Registry.load();
  const ai = await seedAiNewsPipeline(store, registry);
  const world = await seedWorldNewsPipeline(store, registry);
  expect(world.outcome).toBe("created");
  expect(world.pipeline.name).toBe(WORLD_NEWS_PODCAST_NAME);
  expect(world.pipeline.id).not.toBe(ai.pipeline.id);
  expect(world.pipeline.graph).toEqual(worldNewsPodcastDraft().graph);
  expect((await seedAiNewsPipeline(store, registry)).outcome).toBe("unchanged");
  expect((await seedWorldNewsPipeline(store, registry)).outcome).toBe("unchanged");
  expect((await store.list()).map((p) => p.name).sort()).toEqual([AI_NEWS_PODCAST_NAME, WORLD_NEWS_PODCAST_NAME].sort());
});
