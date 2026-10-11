import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedAiNewsPipeline, seedWorldNewsPipeline } from "../scripts/seed-ai-news-pipeline.ts";
import { quickReadView } from "../src/api/public/board-news.js";
import { createApp } from "../src/api/server.ts";
import { Registry } from "../src/core/registry.ts";
import type { PipelineDef, TaskCard } from "../src/core/types.ts";
import { parsePipelineHandoff } from "../src/executors/parse-pipeline-handoff.ts";
import { audioFilePath } from "../src/executors/tts.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { buildPodcasts, podcastQuickRead, type PodcastEpisode, type PodcastRun } from "../src/services/podcasts.ts";
import { SqlitePipelineStore } from "../src/services/pipelines.ts";

// docs/SDD-wissel-app.md §3.3 (card 3): GET /podcasts, the Listen tab's
// and mini-player's list of episodes.

const FIXTURES = join(import.meta.dir, "fixtures", "ai-news");
const registry = await Registry.load();
const read = (name: string) => readFile(join(FIXTURES, name), "utf8");

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function card(over: Partial<TaskCard>): Omit<TaskCard, "id" | "status"> {
  return { title: "t", body: "b", labels: [], repo: "", dependsOn: [], ...over };
}

/** A CBR 128 kbps MP3 padded to `seconds` by size (what mp3Info reads). */
function fakeMp3(seconds: number): Uint8Array {
  const bytes = new Uint8Array((128_000 / 8) * seconds);
  bytes.set([0xff, 0xfb, 0x90, 0x00]);
  return bytes;
}

function run(over: Partial<PodcastRun> & Pick<PodcastRun, "runId">): PodcastRun {
  return {
    pipelineId: "p1",
    pipelineName: "AI news podcast",
    show: "ai",
    at: "2026-10-10T06:00:00.000Z",
    audioUrl: `/pipeline-runs/${over.runId}/audio`,
    quickRead: null,
    ...over,
  };
}

test("buildPodcasts: newest first, headline as title (else the pipeline name), undated runs left out", () => {
  const out = buildPodcasts(
    [
      run({ runId: "a", at: "2026-10-08T06:00:00.000Z", headline: "Old news" }),
      run({ runId: "b", at: "2026-10-10T06:00:00.000Z" }),
      run({ runId: "c", at: undefined, headline: "Not dated yet" }),
      run({ runId: "d", at: "not a time" }),
      run({ runId: "e", pipelineId: "p2", pipelineName: "World news", show: "world", at: "2026-10-09T06:00:00.000Z", headline: "World" }),
    ],
    10,
  );
  expect(out.map((e) => [e.runId, e.title])).toEqual([
    ["b", "AI news podcast"],
    ["e", "World"],
    ["a", "Old news"],
  ]);
  expect(out[0]).not.toHaveProperty("headline");
});

test("buildPodcasts: at most `limit` per pipeline, so a daily show can't push a weekly one out", () => {
  const daily = Array.from({ length: 6 }, (_, i) => run({ runId: `d${i}`, at: `2026-10-0${i + 1}T06:00:00.000Z` }));
  const weekly = run({ runId: "w", pipelineId: "retro", pipelineName: "Wissel retro", show: "retro", at: "2026-09-01T06:00:00.000Z" });
  const out = buildPodcasts([...daily, weekly], 2);
  expect(out.map((e) => e.runId)).toEqual(["d5", "d4", "w"]);
  // Same time: run id breaks the tie, so the order is stable.
  const tied = buildPodcasts([run({ runId: "y" }), run({ runId: "x" })], 5);
  expect(tied.map((e) => e.runId)).toEqual(["x", "y"]);
});

test("podcastQuickRead carries the parsed data, and quickReadView shapes it exactly as the board's newsView does", async () => {
  const final = parsePipelineHandoff(await read("script-summary.md"))!.data!;
  const gather = parsePipelineHandoff(await read("gather-summary.md"))!.data!;
  const explain = parsePipelineHandoff(await read("explain-summary.md"))!.data!;
  const q = podcastQuickRead(final, gather, explain)!;
  expect(q.items).toBe(final.quickRead as unknown[]);
  expect(q.gatherSources).toContain("https://lab.example.com/blog/open-coder-2");
  expect(q.explain!.stories.length).toBeGreaterThan(0);
  // Only the fields joinExplained reads travel.
  for (const s of q.explain!.stories) {
    expect(Object.keys(s).sort()).toEqual(["detail", "explanation", "sources", "unknowns", "whyItMatters"]);
  }

  const { newsView } = await import("../src/api/public/board-news.js");
  const board = newsView(await read("script-summary.md"), await read("gather-summary.md"), true, await read("explain-summary.md"));
  const app = quickReadView(q.items, q.gatherSources ? new Set(q.gatherSources) : null, q.explain);
  expect(board.kind).toBe("news");
  expect(app.kind).toBe("rows");
  if (board.kind === "news" && app.kind === "rows") {
    expect(app.rows).toEqual(board.rows);
    expect(app.flaggedCount).toBe(board.flaggedCount);
    expect(app.rows.every((r) => r.explained !== null)).toBe(true);
  }
  // Survives a JSON round trip (what the app actually gets).
  const wire = JSON.parse(JSON.stringify(q)) as typeof q;
  const viaWire = quickReadView(wire.items, wire.gatherSources ? new Set(wire.gatherSources) : null, wire.explain);
  expect(viaWire).toEqual(app);
});

test("podcastQuickRead: no quickRead list is null; no gather or explain data is null for that part", () => {
  expect(podcastQuickRead(undefined, undefined, undefined)).toBeNull();
  expect(podcastQuickRead({ script: "x" }, undefined, undefined)).toBeNull();
  const q = podcastQuickRead({ quickRead: [{ headline: "H", source: "https://x.example" }] }, { notStories: 1 }, undefined)!;
  expect(q.gatherSources).toBeNull();
  expect(q.explain).toBeNull();
  const v = quickReadView(q.items, null, q.explain);
  expect(v.kind === "rows" && v.rows[0]!.flag).toBe("source not checked: the gather step's output is unavailable");
  // Junk inside explain stories is dropped, not passed on.
  const j = podcastQuickRead({ quickRead: [] }, undefined, { stories: [null, "x", { sources: ["a", 3], detail: 7 }] })!;
  expect(j.explain).toEqual({ stories: [{ sources: ["a"], detail: undefined, explanation: undefined, whyItMatters: undefined, unknowns: undefined }] });
});

/** Two podcast pipelines on a real board: AI news with two runs (the
 *  newer one without explain data) and World news with one, plus an AI
 *  news run whose audio isn't made yet. */
async function world() {
  const dir = await mkdtemp(join(tmpdir(), "wissel-podcasts-test-"));
  dirs.push(dir);
  const audioDir = join(dir, "audio");
  await mkdir(audioDir, { recursive: true });
  const board = new SqliteBoard();
  const pipelines = new SqlitePipelineStore(board.db);
  const ai = (await seedAiNewsPipeline(pipelines, registry)).pipeline;
  const worldNews = (await seedWorldNewsPipeline(pipelines, registry)).pipeline;

  async function makeRun(def: PipelineDef, doneAt: string | null, opts: { explain?: boolean; audioSeconds?: number }) {
    const root = await board.create(card({ title: `Pipeline: ${def.name}`, pipelineId: def.id }));
    const step = async (stepId: string, agentId: string, summary: string) => {
      const t = await board.create(card({ pipelineId: def.id, pipelineRunId: root.id, pipelineStepId: stepId, parentTaskId: root.id }));
      await board.move(t.id, "done");
      await board.recordResult({ taskId: t.id, agentId, ok: true, summary });
    };
    const gatherAgent = def.graph.steps[0]!.agentId;
    const explainAgent = def.graph.steps[1]!.agentId;
    await step(def.graph.steps[0]!.id, gatherAgent, await read("gather-summary.md"));
    if (opts.explain !== false) await step(def.graph.steps[1]!.id, explainAgent, await read("explain-summary.md"));
    await step(def.graph.steps.find((s) => s.agentId === "podcast-scriptwriter")!.id, "podcast-scriptwriter", await read("script-summary.md"));
    if (opts.audioSeconds !== undefined) {
      await writeFile(audioFilePath(audioDir, root.id), fakeMp3(opts.audioSeconds));
      await step(def.graph.steps.find((s) => s.agentId === "podcast-audio")!.id, "podcast-audio", "Audio made.");
    }
    if (doneAt) {
      await board.move(root.id, "done");
      board.db.run("UPDATE tasks SET doneAt = ? WHERE id = ?", [doneAt, root.id]);
    }
    return root;
  }

  const aiOld = await makeRun(ai, "2026-10-08T06:00:00.000Z", { audioSeconds: 300 });
  const aiNew = await makeRun(ai, "2026-10-10T06:00:00.000Z", { audioSeconds: 240, explain: false });
  const aiNoAudio = await makeRun(ai, "2026-10-11T06:00:00.000Z", {});
  const wn = await makeRun(worldNews, "2026-10-09T06:00:00.000Z", { audioSeconds: 360 });
  const app = createApp(board, registry, undefined, { audioDir, pipelines });
  return { app, ai, worldNews, aiOld, aiNew, aiNoAudio, wn };
}

test("GET /podcasts: every podcast pipeline's runs with audio, newest first, with title, duration and Quick read data", async () => {
  const w = await world();
  const res = await w.app(new Request("http://localhost/podcasts"));
  expect(res.status).toBe(200);
  const list = (await res.json()) as PodcastEpisode[];
  expect(list.map((e) => e.runId)).toEqual([w.aiNew.id, w.wn.id, w.aiOld.id]);
  expect(list.some((e) => e.runId === w.aiNoAudio.id)).toBe(false);

  const newest = list[0]!;
  expect(newest).toMatchObject({
    pipelineId: w.ai.id,
    pipelineName: w.ai.name,
    show: "ai",
    at: "2026-10-10T06:00:00.000Z",
    title: "Open coding model catches up",
    durationSeconds: 240,
    audioUrl: `/pipeline-runs/${w.aiNew.id}/audio`,
  });
  expect(newest.quickRead!.items).toHaveLength(3);
  expect(newest.quickRead!.explain).toBeNull();
  expect(list[1]).toMatchObject({ show: "world", pipelineName: w.worldNews.name, durationSeconds: 360 });
  expect(list[2]!.quickRead!.explain!.stories.length).toBeGreaterThan(0);

  // The audio URL is the real, playable route.
  const audio = await w.app(new Request(`http://localhost${newest.audioUrl}`, { method: "HEAD" }));
  expect(audio.status).toBe(200);
});

test("GET /podcasts?limit= is per pipeline, 1 to 50", async () => {
  const w = await world();
  const one = (await (await w.app(new Request("http://localhost/podcasts?limit=1"))).json()) as PodcastEpisode[];
  expect(one.map((e) => e.runId)).toEqual([w.aiNew.id, w.wn.id]);
  for (const bad of ["0", "51", "abc", "1.5"]) {
    const res = await w.app(new Request(`http://localhost/podcasts?limit=${bad}`));
    expect(res.status).toBe(400);
  }
});

test("GET /podcasts on a board with no podcast pipelines is an empty list", async () => {
  const app = createApp(new SqliteBoard(), registry);
  const res = await app(new Request("http://localhost/podcasts"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual([]);
});
