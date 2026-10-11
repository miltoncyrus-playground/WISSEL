import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedAiNewsPipeline } from "../scripts/seed-ai-news-pipeline.ts";
import * as script from "../scripts/check-news-run.ts";
import { createApp } from "../src/api/server.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { Registry } from "../src/core/registry.ts";
import type { Harness, TaskCard } from "../src/core/types.ts";
import { audioFilePath } from "../src/executors/tts.ts";
import { SqliteBoard } from "../src/services/board.ts";
import type { FeedItem, FeedPage } from "../src/services/feed.ts";
import { createFeedSource } from "../src/services/feed-sources.ts";
import * as checks from "../src/services/news-run-checks.ts";
import { SqlitePipelineStore } from "../src/services/pipelines.ts";
import { TelemetryLog } from "../src/services/telemetry.ts";

// docs/SDD-wissel-app.md §3.2: finishedAt on task_results, the moved
// checkStoredRun, and GET /feed end to end over a real board.

const FIXTURES = join(import.meta.dir, "fixtures", "ai-news");
const registry = await Registry.load();

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "wissel-feed-test-"));
  dirs.push(d);
  return d;
}

function card(over: Partial<TaskCard>): Omit<TaskCard, "id" | "status"> {
  return { title: "t", body: "b", labels: [], repo: "", dependsOn: [], ...over };
}

/** A CBR MP3: one MPEG-1 Layer III 128 kbps frame header, padded to
 *  `seconds` of audio by size (what mp3Info and checkAudio read). */
function fakeMp3(seconds: number): Uint8Array {
  const bytes = new Uint8Array((128_000 / 8) * seconds);
  bytes.set([0xff, 0xfb, 0x90, 0x00]);
  return bytes;
}

test("recordResult stamps finishedAt; getResult and listResultMeta return it, latest result per task", async () => {
  const board = new SqliteBoard();
  const t = await board.create(card({ title: "x" }));
  await board.recordResult({ taskId: t.id, agentId: "a", ok: false, summary: "first", finishedAt: "2026-10-01T00:00:00.000Z" });
  const before = Date.now();
  await board.recordResult({ taskId: t.id, agentId: "b", ok: true, summary: "second", worktree: { path: "/w", branch: "wissel/x" }, actualCost: 0.5, harnessId: "claude" });
  const got = await board.getResult(t.id);
  expect(Date.parse(got!.finishedAt!)).toBeGreaterThanOrEqual(before);
  const meta = (await board.listResultMeta()).get(t.id)!;
  expect(meta).toEqual({ agentId: "b", ok: true, worktreeBranch: "wissel/x", actualCost: 0.5, harnessId: "claude", finishedAt: got!.finishedAt });
});

test("an old board without task_results.finishedAt heals on open; old rows read as undated", async () => {
  const dir = await tempDir();
  const path = join(dir, "board.sqlite");
  const old = new Database(path, { create: true });
  old.run("CREATE TABLE task_results (taskId TEXT NOT NULL, agentId TEXT NOT NULL, ok INTEGER NOT NULL, summary TEXT NOT NULL, artifacts TEXT)");
  old.run("INSERT INTO task_results (taskId, agentId, ok, summary) VALUES ('old', 'a', 1, 'done')");
  old.close();

  const board = new SqliteBoard(path);
  const cols = (board.db.query("PRAGMA table_info(task_results)").all() as { name: string }[]).map((c) => c.name);
  expect(cols).toContain("finishedAt");
  expect((await board.getResult("old"))!.finishedAt).toBeUndefined();
  expect((await board.listResultMeta()).get("old")!.finishedAt).toBeUndefined();
  board.db.close();
});

test("checkStoredRun lives in src/services/news-run-checks.ts; the script re-exports the same functions", async () => {
  expect(script.checkStoredRun).toBe(checks.checkStoredRun);
  expect(script.runTelemetry).toBe(checks.runTelemetry);
  expect(script.costFromTelemetry).toBe(checks.costFromTelemetry);
  const source = await readFile(join(import.meta.dir, "..", "scripts", "check-news-run.ts"), "utf8");
  // One implementation: the script holds no copy of the checks.
  expect(source).not.toContain("checkAiNewsRun");
  expect(source).not.toContain("parsePipelineHandoff");
});

test("firstHeadline, mp3DurationSeconds and the podcast pipeline tests", async () => {
  expect(checks.firstHeadline({ quickRead: [{ headline: "  " }, { headline: " Big news " }] })).toBe("Big news");
  expect(checks.firstHeadline({ quickRead: "nope" })).toBeUndefined();
  expect(checks.firstHeadline(undefined)).toBeUndefined();
  expect(checks.mp3DurationSeconds(fakeMp3(10))).toBe(10);
  expect(checks.mp3DurationSeconds(new TextEncoder().encode("<html>error</html>"))).toBeUndefined();
  // Head of a big file, total size given separately.
  expect(checks.mp3DurationSeconds(fakeMp3(1), 16_000 * 300)).toBe(300);

  const pipelines = new SqlitePipelineStore(new SqliteBoard().db);
  const { pipeline } = await seedAiNewsPipeline(pipelines, registry);
  expect(checks.isPodcastPipeline(pipeline)).toBe(true);
  expect(checks.newsRunKind(pipeline)).toBe("ai");
  expect(checks.isPodcastPipeline({ graph: { steps: [{ id: "s", name: "S", agentId: "triager" }], edges: [] } } as never)).toBe(false);
});

/** A board with a finished AI news run (with audio and telemetry), one
 *  landed card, one failed card and yesterday's spend. */
async function world() {
  const dir = await tempDir();
  const audioDir = join(dir, "audio");
  const telemetryPath = join(dir, "telemetry.jsonl");
  const board = new SqliteBoard();
  const pipelines = new SqlitePipelineStore(board.db);
  const { pipeline } = await seedAiNewsPipeline(pipelines, registry);

  const root = await board.create(card({ title: "Pipeline: AI news podcast", pipelineId: pipeline.id }));
  const step = async (stepId: string, agentId: string, summary: string) => {
    const t = await board.create(card({ pipelineId: pipeline.id, pipelineRunId: root.id, pipelineStepId: stepId, parentTaskId: root.id }));
    await board.move(t.id, "done");
    await board.recordResult({ taskId: t.id, agentId, ok: true, summary });
    return t;
  };
  await step("gather", "ai-news-gatherer", await readFile(join(FIXTURES, "gather-summary.md"), "utf8"));
  await step("explain", "ai-news-explainer", await readFile(join(FIXTURES, "explain-summary.md"), "utf8"));
  await step("script", "podcast-scriptwriter", await readFile(join(FIXTURES, "script-summary.md"), "utf8"));
  const mp3 = fakeMp3(40);
  await mkdir(audioDir, { recursive: true });
  await writeFile(audioFilePath(audioDir, root.id), mp3);
  const audioData = { audio: { file: audioFilePath(audioDir, root.id), voice: "af_heart", bytes: mp3.byteLength, synthesisSeconds: 3 } };
  await step("audio", "podcast-audio", "Audio made.\n\n```pipeline-handoff\n" + JSON.stringify({ data: audioData }) + "\n```");
  await board.move(root.id, "done");

  const landed = await board.create(card({ title: "Check the README", repo: "/tmp/repo" }));
  await board.move(landed.id, "done");
  const failed = await board.create(card({ title: "Broken thing", repo: "/tmp/repo" }));
  await board.move(failed.id, "failed");

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  await writeFile(
    telemetryPath,
    [
      { type: "result", taskId: "elsewhere", actualCost: 1.5, harnessId: "claude", at: yesterday.toISOString() },
      { type: "result", taskId: "elsewhere2", actualCost: 0.5, harnessId: "codex", at: yesterday.toISOString() },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n",
  );
  return { dir, board, pipelines, root, landed, failed, audioDir, telemetryPath };
}

test("GET /feed: landed, needs you, podcast with headline and duration, its checks, and spend", async () => {
  const w = await world();
  const app = createApp(w.board, registry, new TelemetryLog(w.telemetryPath), { audioDir: w.audioDir, pipelines: w.pipelines });
  const res = await app(new Request("http://localhost/feed"));
  expect(res.status).toBe(200);
  const page = (await res.json()) as FeedPage;
  const byId = Object.fromEntries(page.items.map((i) => [i.id, i])) as Record<string, FeedItem>;

  expect(byId[`landed:${w.landed.id}`]).toMatchObject({ kind: "landed", title: "Check the README" });
  expect(byId[`needs-you:${w.failed.id}`]).toMatchObject({
    kind: "needs-you",
    title: "Broken thing",
    links: [{ label: "Retry", href: `/tasks/${w.failed.id}/run`, method: "POST" }],
  });
  expect(byId[`podcast:${w.root.id}`]).toMatchObject({
    kind: "podcast",
    title: "Open coding model catches up",
    show: "ai",
    durationSeconds: 40,
    audioUrl: `/pipeline-runs/${w.root.id}/audio`,
  });
  const c = byId[`podcast:${w.root.id}:checks`]!;
  expect(c.kind).toBe("checks");
  expect(typeof c.pass).toBe("boolean");
  expect(c.title).toMatch(/checks (passed|failed)$/);
  // The podcast's root and its step cards are not landings of their own.
  expect(page.items.filter((i) => i.kind === "landed")).toHaveLength(1);
  const spend = page.items.find((i) => i.kind === "spend")!;
  expect(spend.title).toMatch(/^\$2\.00 spent on /);
  expect(spend.detail).toBe("claude $1.50 · codex $0.50");

  // Newest first.
  const times = page.items.map((i) => Date.parse(i.at));
  expect([...times].sort((a, b) => b - a)).toEqual(times);
});

test("GET /feed pages with limit and next, and refuses a bad limit or before", async () => {
  const w = await world();
  const app = createApp(w.board, registry, new TelemetryLog(w.telemetryPath), { audioDir: w.audioDir, pipelines: w.pipelines });
  const all = (await (await app(new Request("http://localhost/feed?limit=200"))).json()) as FeedPage;
  const seen: string[] = [];
  let url = "/feed?limit=2";
  for (let i = 0; i < 20; i++) {
    const page = (await (await app(new Request(`http://localhost${url}`))).json()) as FeedPage;
    seen.push(...page.items.map((x) => x.id));
    if (!page.next) break;
    url = `/feed?limit=2&before=${encodeURIComponent(page.next)}`;
  }
  // The failed card is undated (at = now), so compare ids, not times.
  expect(seen).toEqual(all.items.map((x) => x.id));

  for (const bad of ["/feed?limit=0", "/feed?limit=201", "/feed?limit=abc", "/feed?before=yesterday"]) {
    expect((await app(new Request(`http://localhost${bad}`))).status).toBe(400);
  }
});

test("a card pinned to a disabled harness shows as held", async () => {
  const board = new SqliteBoard();
  const harness: Harness = { id: "claude-adevinta", tool: "claude-cli", label: "Corporate", enabled: false };
  const t = await board.create(card({ title: "Pinned", harnessOverride: "claude-adevinta" }));
  const app = createApp(board, registry, undefined, { harnesses: HarnessPool.from([harness]) });
  const page = (await (await app(new Request("http://localhost/feed"))).json()) as FeedPage;
  expect(page.items.find((i) => i.taskId === t.id)?.detail).toBe("Held: claude-adevinta is switched off");
});

test("the feed source checks a settled podcast run once, then serves it from cache", async () => {
  const w = await world();
  let getResults = 0;
  const counting = new Proxy(w.board, {
    get(target, prop, receiver) {
      if (prop === "getResult") return (id: string) => (getResults++, target.getResult(id));
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const source = createFeedSource({ board: counting, pipelines: w.pipelines, telemetryPath: w.telemetryPath, audioDir: w.audioDir });
  // One `now` for both reads: the failed card is undated (at = now), and
  // a fresh Date.now() can tie it with the landed card's doneAt.
  const now = Date.now() + 1000;
  const first = await source.read({ now, limit: 50 });
  const afterFirst = getResults;
  expect(afterFirst).toBeGreaterThan(0);
  const second = await source.read({ now, limit: 50 });
  expect(getResults).toBe(afterFirst);
  expect(second.items.map((i) => i.id)).toEqual(first.items.map((i) => i.id));
});
