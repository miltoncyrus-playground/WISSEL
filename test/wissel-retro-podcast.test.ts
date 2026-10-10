import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPipelineRun, stepsNeedingRepo, type PipelineRunnerContext } from "../src/core/pipeline-runner.ts";
import { Registry } from "../src/core/registry.ts";
import type { AgentDef, Executor, PipelineDef, TaskCard } from "../src/core/types.ts";
import type { CommandRunner } from "../src/executors/claude-cli.ts";
import { ApiExecutor } from "../src/executors/anthropic-api.ts";
import { CodexReadOnlyExecutor } from "../src/executors/codex-readonly.ts";
import { CodexWriteExecutor } from "../src/executors/codex-write.ts";
import { DEFAULT_DOCS_DIR, DigestExecutor } from "../src/executors/digest.ts";
import { parsePipelineHandoff } from "../src/executors/parse-pipeline-handoff.ts";
import { ReadOnlyExecutor } from "../src/executors/readonly.ts";
import { TtsExecutor } from "../src/executors/tts.ts";
import { WriteExecutor } from "../src/executors/write.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { SqlitePipelineStore } from "../src/services/pipelines.ts";
import { buildWisselDigest } from "../src/services/wissel-digest.ts";
import { newsStepCards, newsView } from "../src/api/public/board-news.js";
import { pipelineNeedsRepo } from "../src/api/public/board-pipelines.js";
import {
  AI_NEWS_PODCAST_NAME,
  aiNewsPodcastDraft,
  WISSEL_RETRO_PODCAST_NAME,
  wisselRetroPodcastDraft,
  WORLD_NEWS_PODCAST_NAME,
  worldNewsPodcastDraft,
} from "../pipeline-editor/src/templates.ts";
import { seedAiNewsPipeline, seedWisselRetroPipeline, seedWorldNewsPipeline } from "../scripts/seed-ai-news-pipeline.ts";
import { checkRetroRun, RETRO_GROUPS, type RetroRunOutputs } from "../eval/ai-news-checks.ts";
import { SILENT_MP3_PATH } from "./fixtures/ai-news/make-silent-mp3.ts";

// docs/SDD-wissel-retro-podcast.md §3.1 to §3.4, gate tests from §4.

/** Fails the test if anything but read-only git reaches it. */
const noGit: CommandRunner = async (cmd) => {
  throw new Error(`unexpected command: ${cmd.join(" ")}`);
};

async function emptyDocs(): Promise<string> {
  return mkdtemp(join(tmpdir(), "wissel-retro-docs-"));
}

// ---- §3.1 DigestExecutor ------------------------------------------------

test("DigestExecutor: handoff data is the digest, the summary carries the same block, no harness, $0", async () => {
  const board = new SqliteBoard();
  const done = await board.create({ title: "Shipped it", body: "", labels: [] });
  await board.move(done.id, "done");
  const agent = (await Registry.load()).get("wissel-digest")!;
  const now = new Date(Date.now() + 60_000);
  const docsDir = await emptyDocs();
  try {
    const exec: Executor = new DigestExecutor({ board, runner: noGit, docsDir, now: () => now });
    expect(exec.harnessTool).toBeUndefined();
    const task: TaskCard = { id: "step-1", title: "collect", body: "last 3 days", labels: [], status: "running", pipelineRunId: "run-1" };
    const result = await exec.run(task, agent);

    expect(result).toMatchObject({ taskId: "step-1", agentId: "wissel-digest", ok: true, actualCost: 0 });
    const expected = await buildWisselDigest({ board, runner: noGit, docsDir, now, input: "last 3 days", lessonsPath: "memory/lessons.md", excludeRunId: "run-1" });
    expect(result.pipelineHandoff?.data).toEqual(expected as unknown as Record<string, unknown>);
    expect(parsePipelineHandoff(result.summary)?.data).toEqual(expected as unknown as Record<string, unknown>);
    expect(expected.period.days).toBe(3);
    expect(expected.stories.map((s) => s.title)).toEqual(["Shipped it"]);
    expect(result.summary.split("\n")[0]).toMatch(/^Wissel activity \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2} \(3 days\): 1 cards, 1 stories \(0 linked to a commit\), \$0\.00 spent, 0 SDDs changed\.$/);
  } finally {
    await rm(docsDir, { recursive: true, force: true });
  }
});

test("DigestExecutor: a failure inside the digest fails the step with the reason", async () => {
  const agent = (await Registry.load()).get("wissel-digest")!;
  const board = { list: async () => Promise.reject(new Error("db locked")), getResult: async () => undefined };
  const result = await new DigestExecutor({ board, runner: noGit }).run({ id: "s", title: "t", body: "", labels: [], status: "running" }, agent);
  expect(result).toEqual({ taskId: "s", agentId: "wissel-digest", ok: false, summary: "Digest not built: db locked" });
});

test("DigestExecutor defaults to wissel's own docs/ directory", () => {
  expect(readFileSync(join(DEFAULT_DOCS_DIR, "SDD-wissel-retro-podcast.md"), "utf8")).toContain("# SDD: Wissel retrospective podcast");
});

// ---- manifest -------------------------------------------------------------

test("manifest: wissel-digest is a no-LLM readonly skill on executor digest; the analyst a readonly no-tools sonnet pipeline-handoff agent; each tag unique", async () => {
  const registry = await Registry.load();
  const digest = registry.get("wissel-digest")!;
  expect(digest).toMatchObject({ kind: "skill", tier: "readonly", executor: "digest", toolAccess: [], costProfile: { model: "none", estUsdPerTask: 0 } });
  expect(digest.outputContract).toBeUndefined();
  const analyst = registry.get("wissel-retro-analyst")!;
  expect(analyst).toMatchObject({ kind: "agent", tier: "readonly", executor: "readonly", toolAccess: [], outputContractFormat: "pipeline-handoff", costProfile: { model: "claude-sonnet-5-5" } });
  for (const a of [digest, analyst]) {
    expect(a.tags).toHaveLength(1);
    expect(registry.all().filter((o) => o.id !== a.id && o.tags.includes(a.tags[0]!)), a.id).toEqual([]);
  }
});

test("manifest: the analyst's contract names the four groups, the item shape and the hard rules", async () => {
  const c = (await Registry.load()).get("wissel-retro-analyst")!.outputContract!.replace(/\s+/g, " ");
  for (const key of ['"group"', '"title"', '"date"', '"sources"', '"explanation"', '"whyItMatters"', '"unknowns"', "```pipeline-handoff"]) expect(c).toContain(key);
  for (const g of RETRO_GROUPS) expect(c).toContain(`\`${g}\``);
  expect(c).toContain("No number, card, date or URL that is not in the digest");
  expect(c).toContain("Every `learnings` and `improve` item MUST have at least one");
  expect(c).toContain("no flattery");
  expect(c).toContain('("you")');
});

test("manifest: the scriptwriter groups by `region` or `group` with the spoken lead-ins, and allows an empty source", async () => {
  const c = (await Registry.load()).get("podcast-scriptwriter")!.outputContract!.replace(/\s+/g, " ");
  // The region rule, word for word as before (the AI and world pipelines).
  expect(c).toContain("When stories carry a `region`, keep them grouped in input order (world, then Spain, then the Netherlands) with a short spoken lead-in to each group.");
  expect(c).toContain("When stories carry a `group` instead");
  for (const leadIn of ['`done` is "what you built"', '`learnings` is "what you learned"', '`improve` is "what to improve"', '`ideas` is "ideas to think about"']) expect(c).toContain(leadIn);
  expect(c).toContain('When a story\'s `sources` is empty, `source` is "".');
});

test("executor resolution: wissel-digest resolves to DigestExecutor alone; every other agent resolves exactly as without it", async () => {
  const registry = await Registry.load();
  const board = new SqliteBoard();
  // The server's default manual pool (src/api/server.ts), minus and plus DigestExecutor.
  const before: Executor[] = [new ReadOnlyExecutor(), new ApiExecutor(), new CodexReadOnlyExecutor(), new WriteExecutor(), new CodexWriteExecutor(), new TtsExecutor()];
  const after: Executor[] = [...before, new DigestExecutor({ board })];
  const handlers = (pool: Executor[], agent: AgentDef) => pool.filter((e) => e.canHandle(agent)).map((e) => e.id);
  expect(handlers(after, registry.get("wissel-digest")!)).toEqual(["digest"]);
  expect(registry.all().filter((a) => new DigestExecutor({ board }).canHandle(a)).map((a) => a.id)).toEqual(["wissel-digest"]);
  const others = registry.all().filter((a) => a.id !== "wissel-digest");
  expect(others.length).toBeGreaterThan(10);
  for (const agent of others) expect(handlers(after, agent), agent.id).toEqual(handlers(before, agent));
  expect(handlers(after, registry.get("wissel-retro-analyst")!)).toEqual(["readonly"]);
});

// ---- §3.4 template and seed ------------------------------------------------

test("template: collect -> analyse -> the AI pipeline's own script and audio steps, transition all, repo-less", async () => {
  const draft = wisselRetroPodcastDraft();
  expect(draft.name).toBe(WISSEL_RETRO_PODCAST_NAME);
  expect(draft.graph.steps.map((s) => [s.id, s.name, s.agentId, s.transition])).toEqual([
    ["collect", "Collect activity", "wissel-digest", "all"],
    ["analyse", "Analyse", "wissel-retro-analyst", "all"],
    ["script", "Write podcast script", "podcast-scriptwriter", "all"],
    ["audio", "Make audio", "podcast-audio", "all"],
  ]);
  expect(draft.graph.edges.map((e) => [e.id, e.from, e.to])).toEqual([
    ["collect-analyse", "collect", "analyse"],
    ["analyse-script", "analyse", "script"],
    ["script-audio", "script", "audio"],
  ]);
  expect(draft.graph.steps.slice(2)).toEqual(aiNewsPodcastDraft().graph.steps.slice(2));
  const registry = await Registry.load();
  const def: PipelineDef = { ...draft, id: "x", createdAt: "", updatedAt: "" };
  expect(stepsNeedingRepo(def, registry)).toEqual([]);
  expect(pipelineNeedsRepo(def, registry.all())).toBe(false);
});

test("template: the AI and world templates keep their own steps (their explainers are per pipeline since SDD-ai-news-podcast §3.9)", () => {
  expect(aiNewsPodcastDraft().graph.steps.map((s) => s.agentId)).toEqual(["ai-news-gatherer", "ai-news-explainer", "podcast-scriptwriter", "podcast-audio"]);
  expect(worldNewsPodcastDraft().graph.steps.map((s) => s.agentId)).toEqual(["world-news-gatherer", "world-news-explainer", "podcast-scriptwriter", "podcast-audio"]);
});

test("seed: all three podcast pipelines coexist with their own ids; reseeding is a no-op", async () => {
  const board = new SqliteBoard();
  const store = new SqlitePipelineStore(board.db);
  const registry = await Registry.load();
  const ai = await seedAiNewsPipeline(store, registry);
  const world = await seedWorldNewsPipeline(store, registry);
  const retro = await seedWisselRetroPipeline(store, registry);
  expect(retro.outcome).toBe("created");
  expect(retro.pipeline.graph).toEqual(wisselRetroPodcastDraft().graph);
  expect(new Set([ai.pipeline.id, world.pipeline.id, retro.pipeline.id]).size).toBe(3);
  for (const seed of [seedAiNewsPipeline, seedWorldNewsPipeline, seedWisselRetroPipeline]) expect((await seed(store, registry)).outcome).toBe("unchanged");
  expect((await store.get(retro.pipeline.id))!.updatedAt).toBe(retro.pipeline.updatedAt);
  expect((await store.list()).map((p) => p.name).sort()).toEqual([AI_NEWS_PODCAST_NAME, WISSEL_RETRO_PODCAST_NAME, WORLD_NEWS_PODCAST_NAME].sort());
});

test("seed script: running it seeds all three (the import.meta.main loop names each seeder)", () => {
  const src = readFileSync(join(import.meta.dir, "..", "scripts", "seed-ai-news-pipeline.ts"), "utf8");
  const main = src.slice(src.indexOf("if (import.meta.main)"));
  for (const fn of ["seedAiNewsPipeline", "seedWorldNewsPipeline", "seedWisselRetroPipeline"]) expect(main).toContain(`await ${fn}(store, registry)`);
});

// ---- a whole run: real digest, scripted LLM steps, fake Kokoro --------------

function handoff(data: Record<string, unknown>): string {
  return JSON.stringify({ type: "result", subtype: "success", is_error: false, result: `done\n\n\`\`\`pipeline-handoff\n${JSON.stringify({ data })}\n\`\`\`` });
}

test("run: the retro pipeline runs with no repo; the analyst gets the digest fenced; the drawer shows its quick read checked against the digest", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "wissel-retro-run-"));
  const kokoro = Bun.serve({
    port: 0,
    fetch: (req) => (new URL(req.url).pathname === "/health" ? Response.json({ status: "healthy" }) : new Response(readFileSync(SILENT_MP3_PATH), { headers: { "content-type": "audio/mpeg" } })),
  });
  try {
    const board = new SqliteBoard();
    const shipped = await board.create({ title: "Shipped the retro", body: "", labels: [] });
    await board.move(shipped.id, "done");
    const registry = await Registry.load();
    const pipelines = new SqlitePipelineStore(board.db);
    const def = await pipelines.create(wisselRetroPodcastDraft());
    const stdins: string[] = [];
    const outputs = [
      handoff({ stories: [{ group: "done", title: "Shipped the retro", date: "2026-10-10", sources: [], explanation: "E", whyItMatters: "W", unknowns: "U" }] }),
      handoff({ quickRead: [{ headline: "Shipped", oneLine: "You shipped it.", source: "" }], script: "Your week in wissel.\n\nBye.", wordCount: 6 }),
    ];
    const runner: CommandRunner = async (_cmd, opts) => {
      stdins.push(opts.stdin ?? "");
      return { stdout: outputs[stdins.length - 1]!, stderr: "", exitCode: 0 };
    };
    const docsDir = await emptyDocs();
    const ctx: PipelineRunnerContext = {
      executors: [
        new ReadOnlyExecutor({ runner, homeDir }),
        new TtsExecutor({ baseUrl: `http://127.0.0.1:${kokoro.port}`, audioDir: join(homeDir, "audio") }),
        new DigestExecutor({ board, runner: noGit, docsDir, lessonsPath: join(homeDir, "none.md") }),
      ],
      pipelines,
    };

    const root = await startPipelineRun(board, registry, def, undefined, "last 2 days", ctx);

    expect(root.status).toBe("done");
    const steps = (await board.list()).filter((t) => t.pipelineRunId === root.id);
    expect(steps.map((s) => [s.pipelineStepId, s.status, s.repo])).toEqual([
      ["collect", "done", undefined],
      ["analyse", "done", undefined],
      ["script", "done", undefined],
      ["audio", "done", undefined],
    ]);
    // Two claude calls (analyse, script); collect and audio spawn none.
    expect(stdins).toHaveLength(2);
    expect(stdins[0]).toContain("last 2 days");
    expect(stdins[0]).toContain(`\`\`\`untrusted-${root.id.slice(0, 8)}`);
    expect(stdins[0]).toContain('"title": "Shipped the retro"');
    expect(stdins[0]).toContain('"days": 2');
    // The digest left its own run out.
    expect(stdins[0]).not.toContain("Collect activity");
    expect(stdins[1]).toContain('"group": "done"');

    // The drawer: scriptwriter found by agent, the collect step is the gather step.
    const cards = newsStepCards(steps, def.graph.steps);
    expect(cards!.news.pipelineStepId).toBe("script");
    expect(cards!.gather!.pipelineStepId).toBe("collect");
    const view = newsView((await board.getResult(cards!.news.id))!.summary, (await board.getResult(cards!.gather!.id))!.summary, true);
    expect(view.kind).toBe("news");
    if (view.kind === "news") expect(view.gatherChecked).toBe(true);
    await rm(docsDir, { recursive: true, force: true });
  } finally {
    kokoro.stop(true);
    await rm(homeDir, { recursive: true, force: true });
  }
});

// ---- §3.4 checkRetroRun ------------------------------------------------------

const C1 = "https://github.com/milton/wissel/commit/aaa";
const C2 = "https://github.com/milton/wissel/commit/bbb";

function goodRun(): RetroRunOutputs {
  const item = (group: string, title: string, sources: string[]) => ({ group, title, date: "2026-10-10", sources, explanation: "e", whyItMatters: "w", unknowns: "u" });
  return {
    gather: { period: { from: "2026-10-03", to: "2026-10-10", days: 7 }, stories: [{ title: "A", date: "2026-10-09", sources: [C1], facts: "f" }, { title: "B", date: "2026-10-08", sources: [C2], facts: "f" }, { title: "C", date: "2026-10-08", sources: [], facts: "f" }] },
    analysis: {
      stories: [item("done", "A", [C1]), item("done", "C", []), item("learnings", "L", [C2]), item("improve", "I", [C1, C2]), item("ideas", "Idea", [C1]), item("ideas", "Idea 2", [])],
    },
    final: {
      quickRead: [
        { headline: "A", oneLine: "o", source: C1 },
        { headline: "C", oneLine: "o", source: "" },
        { headline: "L", oneLine: "o", source: C2 },
        { headline: "I", oneLine: "o", source: C1 },
        { headline: "Idea", oneLine: "o", source: C1 },
        { headline: "Idea 2", oneLine: "o", source: "" },
      ],
      script: Array(700).fill("word").join(" "),
      wordCount: 700,
    },
    costUsd: 0.42,
  };
}

const failing = (run: RetroRunOutputs) => checkRetroRun(run).filter((c) => !c.pass).map((c) => c.name);

test("checkRetroRun: a good run passes every check, and only the SDD's checks run", () => {
  const checks = checkRetroRun(goodRun());
  expect(checks.map((c) => c.name)).toEqual(["gather-shape", "final-shape", "sources-from-gather", "groups", "evidence", "word-count", "cost"]);
  expect(failing(goodRun())).toEqual([]);
  expect(checks.find((c) => c.name === "groups")!.detail).toBe("done 2, learnings 1, improve 1, ideas 2");
});

test("checkRetroRun: a missing group fails `groups`; an unknown group too", () => {
  const run = goodRun();
  (run.analysis as { stories: { group: string }[] }).stories = (run.analysis as { stories: { group: string }[] }).stories.filter((s) => s.group !== "ideas");
  expect(failing(run)).toEqual(["groups"]);
  expect(checkRetroRun(run).find((c) => c.name === "groups")!.detail).toBe("no item for: ideas");
  const odd = goodRun();
  (odd.analysis as { stories: { group: string }[] }).stories[0]!.group = "wins";
  expect(failing(odd)).toContain("groups");
});

test("checkRetroRun: an improve or learnings item with no source fails `evidence`", () => {
  for (const group of ["improve", "learnings"]) {
    const run = goodRun();
    (run.analysis as { stories: { group: string; sources: string[] }[] }).stories.find((s) => s.group === group)!.sources = [];
    expect(failing(run), group).toEqual(["evidence"]);
  }
});

test("checkRetroRun: a link not in the digest fails, in the quick read or in the analysis", () => {
  const quick = goodRun();
  (quick.final as { quickRead: { source: string }[] }).quickRead[0]!.source = "https://github.com/milton/wissel/commit/zzz";
  expect(failing(quick)).toEqual(["sources-from-gather"]);
  const analysed = goodRun();
  (analysed.analysis as { stories: { sources: string[] }[] }).stories[0]!.sources = ["https://example.com/made-up"];
  expect(failing(analysed)).toEqual(["evidence"]);
});

test("checkRetroRun: empty digest, missing final data, a short script and cost at the limit fail", () => {
  const run = goodRun();
  run.gather = { stories: [] };
  expect(failing(run)).toContain("gather-shape");
  expect(failing({ ...goodRun(), final: undefined })).toEqual(expect.arrayContaining(["final-shape", "sources-from-gather", "word-count"]));
  const short = goodRun();
  (short.final as { script: string }).script = "too short";
  expect(failing(short)).toEqual(["word-count"]);
  expect(failing({ ...goodRun(), costUsd: 1.0 })).toEqual(["cost"]);
  expect(failing({ ...goodRun(), costUsd: undefined })).toEqual(["cost"]);
});
