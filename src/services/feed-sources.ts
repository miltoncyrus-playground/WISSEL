import { stat } from "node:fs/promises";
import type { TaskCard } from "../core/types.ts";
import { audioFilePath } from "../executors/tts.ts";
import type { Board, ResultMeta } from "./board.ts";
import { buildFeed, type FeedCursor, type FeedPage, type FeedRun } from "./feed.ts";
import {
  checkStoredRun,
  firstHeadline,
  isPodcastPipeline,
  loadStoredRun,
  mp3DurationSeconds,
  newsRunKind,
  readTelemetryLines,
  type CheckDeps,
  type TelemetryLine,
} from "./news-run-checks.ts";
import { pipelineAudioBytes } from "./pipeline-audio.ts";
import type { PipelineStore } from "./pipelines.ts";
import { buildPodcasts, podcastQuickRead, type PodcastEpisode, type PodcastRun } from "./podcasts.ts";

/**
 * The read side of `GET /feed` (docs/SDD-wissel-app.md §3.2) and
 * `GET /podcasts` (§3.3): gathers what buildFeed (src/services/feed.ts)
 * and buildPodcasts (src/services/podcasts.ts), both pure, need from the
 * board, telemetry.jsonl and the audio directory. Both read podcast runs
 * through the one run cache below. Two caches keep a request cheap on a
 * long-lived board:
 *   - telemetry is re-parsed only when the file's size or mtime changes;
 *   - a podcast run's facts (headline, duration, checks) are kept once
 *     the run has settled, keyed on its status and MP3 size, so a run is
 *     checked once, not on every request.
 */

export interface FeedSourceDeps {
  board: Board;
  pipelines: PipelineStore;
  /** telemetry.jsonl; undefined means no telemetry (no spend items). */
  telemetryPath?: string;
  audioDir: string;
  /** Ids of harnesses switched off right now. */
  disabledHarnesses?: () => string[];
}

export interface FeedQuery {
  now: number;
  limit: number;
  before?: FeedCursor;
}

/** One podcast run with audio, as each endpoint needs it. */
interface RunFacts {
  feed: FeedRun;
  podcast: PodcastRun;
}

/** Enough of an MP3's head to find its first frame after an ID3 tag. */
const MP3_HEAD_BYTES = 256 * 1024;

const SETTLED = new Set<TaskCard["status"]>(["done", "failed", "escalated", "no-match"]);

export function createFeedSource(deps: FeedSourceDeps) {
  let telemetryCache: { key: string; lines: TelemetryLine[] } | null = null;
  const runCache = new Map<string, { key: string; run: RunFacts }>();

  async function telemetry(): Promise<TelemetryLine[]> {
    if (!deps.telemetryPath) return [];
    const s = await stat(deps.telemetryPath).catch(() => null);
    if (!s) return [];
    const key = `${s.size}:${s.mtimeMs}`;
    if (telemetryCache?.key !== key) telemetryCache = { key, lines: await readTelemetryLines(deps.telemetryPath) };
    return telemetryCache.lines;
  }

  async function podcastRuns(tasks: TaskCard[], results: Map<string, ResultMeta>, lines: TelemetryLine[]): Promise<RunFacts[]> {
    const podcasts = new Map((await deps.pipelines.list()).filter(isPodcastPipeline).map((p) => [p.id, p]));
    if (podcasts.size === 0) return [];
    const checkDeps: CheckDeps = {
      board: deps.board,
      pipelines: deps.pipelines,
      telemetryPath: deps.telemetryPath ?? "",
      audioDir: deps.audioDir,
      telemetry: lines,
      tasks,
    };
    const out: RunFacts[] = [];
    for (const root of tasks) {
      if (!root.pipelineId || root.pipelineRunId || !podcasts.has(root.pipelineId)) continue;
      const bytes = await pipelineAudioBytes(deps.audioDir, root.id);
      if (bytes === null) continue;
      const key = `${root.status}:${bytes}:${root.doneAt ?? ""}`;
      const cached = runCache.get(root.id);
      if (cached?.key === key) {
        out.push(cached.run);
        continue;
      }
      const stored = await loadStoredRun(checkDeps, root.id);
      if (typeof stored === "string") continue;
      const def = podcasts.get(root.pipelineId)!;
      const kind = newsRunKind(def);

      const head = new Uint8Array(await Bun.file(audioFilePath(deps.audioDir, root.id)).slice(0, MP3_HEAD_BYTES).arrayBuffer());
      const durationSeconds = mp3DurationSeconds(head, bytes);

      // When the run finished: the root's doneAt, else the audio step's
      // result, else the run's latest telemetry event.
      const runIds = new Set([root.id, ...stored.steps.map((t) => t.id)]);
      let lastAt: string | undefined;
      for (const e of lines) {
        if (e.taskId && runIds.has(e.taskId) && typeof e.at === "string" && (lastAt === undefined || e.at > lastAt)) lastAt = e.at;
      }
      const at = root.doneAt ?? (stored.audioCard ? results.get(stored.audioCard.id)?.finishedAt : undefined) ?? lastAt;

      let checks: FeedRun["checks"];
      if (kind) {
        const report = await checkStoredRun(checkDeps, root.id);
        if (typeof report !== "string") {
          checks = { pass: report.pass, total: report.checks.length, failed: report.checks.filter((c) => !c.pass).map((c) => c.name) };
        }
      }

      const feed: FeedRun = {
        runId: root.id,
        pipelineName: def.name,
        show: kind ?? "other",
        at,
        headline: firstHeadline(stored.final),
        durationSeconds,
        audioUrl: `/pipeline-runs/${encodeURIComponent(root.id)}/audio`,
        checks,
      };
      const run: RunFacts = {
        feed,
        podcast: {
          runId: feed.runId,
          pipelineId: def.id,
          pipelineName: feed.pipelineName,
          show: feed.show,
          at,
          headline: feed.headline,
          durationSeconds,
          audioUrl: feed.audioUrl,
          quickRead: podcastQuickRead(stored.final, stored.gather, stored.explain),
        },
      };
      // Only a settled run is final; a running one is read again next time.
      if (SETTLED.has(root.status)) runCache.set(root.id, { key, run });
      out.push(run);
    }
    return out;
  }

  async function readAll() {
    const [tasks, results, lines] = await Promise.all([deps.board.list(), deps.board.listResultMeta(), telemetry()]);
    return { tasks, results, lines, runs: await podcastRuns(tasks, results, lines) };
  }

  return {
    async read(q: FeedQuery): Promise<FeedPage> {
      const { tasks, results, lines, runs } = await readAll();
      return buildFeed({
        tasks,
        results,
        runs: runs.map((r) => r.feed),
        telemetry: lines,
        disabledHarnesses: deps.disabledHarnesses?.() ?? [],
        now: q.now,
        limit: q.limit,
        before: q.before,
      });
    },

    /** GET /podcasts: at most `limit` episodes per podcast pipeline. */
    async podcasts(limit: number): Promise<PodcastEpisode[]> {
      const { runs } = await readAll();
      return buildPodcasts(
        runs.map((r) => r.podcast),
        limit,
      );
    },
  };
}
