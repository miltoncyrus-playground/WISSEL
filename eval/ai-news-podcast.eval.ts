#!/usr/bin/env bun
/**
 * Live eval for the "AI news podcast" pipeline (docs/SDD-ai-news-podcast.md
 * §5). Real `claude -p` calls through ReadOnlyExecutor (the gather step
 * with WebSearch/WebFetch), no repo, nothing scripted. Paid and uses the
 * web: not run by `bun test`; run it with `bun run eval:ai-news` before
 * ship or nightly.
 *
 * Each run seeds the pipeline into a throwaway in-memory board with
 * scripts/seed-ai-news-pipeline.ts (so the seeded definition is what
 * gets tested), runs it with no repo and no input, then applies the
 * deterministic checks in eval/ai-news-checks.ts to the real outputs:
 * every final source URL is in the gather step's set, every gathered
 * story is dated within 7 days, 5 to 8 stories, script 600 to 1000
 * words, run cost under $1.50 from the telemetry `result` events of the
 * run's step tasks, (§3.9) the explain step keeps the gather step's
 * stories in order with their sources (explain-shape), keeps 90% of the
 * numbers and 80% of the names in their `facts` (facts-retained), and
 * writes a summary of at most 30 words and a detail of at least 60 (world
 * 50) per story (depth), and (§3.7) the "Make audio" step produced a real MP3
 * through the local Kokoro service (WISSEL_TTS_URL) whose length fits
 * the script at a speaking pace (checkAudio). Kokoro must be running.
 *
 * Pass threshold: all checks on at least 2 of 3 runs (web results vary).
 * Stops early once the outcome is decided (2 passes, or 2 failures), so
 * a clean result costs two runs, not three. Every run's raw outputs and
 * check results go to /tmp/wissel-eval-ai-news/<timestamp>/run-<n>.json.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../src/core/registry.ts";
import { startPipelineRun, type PipelineRunnerContext } from "../src/core/pipeline-runner.ts";
import { ReadOnlyExecutor } from "../src/executors/readonly.ts";
import { runViaBun } from "../src/executors/claude-cli.ts";
import { parsePipelineHandoff } from "../src/executors/parse-pipeline-handoff.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { SqlitePipelineStore } from "../src/services/pipelines.ts";
import { TelemetryLog } from "../src/services/telemetry.ts";
import { seedAiNewsPipeline, seedWorldNewsPipeline } from "../scripts/seed-ai-news-pipeline.ts";
import { TtsExecutor, audioFilePath } from "../src/executors/tts.ts";
import { checkAiNewsRun, checkAudio, checkWorldNewsRun, countWords, type AiNewsCheck } from "./ai-news-checks.ts";

/** `--world` runs the "World news podcast" pipeline (SDD §3.8) with its
 *  own checks (2-day window, every region covered) instead of the AI one:
 *  `bun run eval:world-news`. */
const WORLD = process.argv.includes("--world");

const RUNS = 3;
const NEEDED = 2;

/** Sums actualCost over telemetry `result` events for these task ids. */
async function costFromTelemetry(path: string, taskIds: Set<string>): Promise<number | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  let total: number | undefined;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e: { type?: string; taskId?: string; actualCost?: number };
    try {
      e = JSON.parse(line) as typeof e;
    } catch {
      continue;
    }
    if (e.type === "result" && e.taskId && taskIds.has(e.taskId) && typeof e.actualCost === "number") total = (total ?? 0) + e.actualCost;
  }
  return total;
}

async function runOnce(n: number, outDir: string): Promise<boolean> {
  const homeDir = await mkdtemp(join(tmpdir(), "wissel-eval-ai-news-home-"));
  const telemetryPath = join(homeDir, "telemetry.jsonl");
  try {
    const board = new SqliteBoard();
    const pipelines = new SqlitePipelineStore(board.db);
    const registry = await Registry.load();
    const { pipeline } = await (WORLD ? seedWorldNewsPipeline : seedAiNewsPipeline)(pipelines, registry);
    const audioDir = join(homeDir, "audio");
    const ctx: PipelineRunnerContext = {
      executors: [
        new ReadOnlyExecutor({ runner: runViaBun, homeDir }),
        // The real local Kokoro service (§3.7), same config the server reads.
        new TtsExecutor({ baseUrl: process.env.WISSEL_TTS_URL, voice: process.env.WISSEL_TTS_VOICE, audioDir }),
      ],
      pipelines,
      telemetry: new TelemetryLog(telemetryPath),
    };

    const now = new Date();
    console.log(`Run ${n}: "${pipeline.name}" with no repo (real claude, real web)...`);
    const root = await startPipelineRun(board, registry, pipeline, undefined, "", ctx);

    const steps = (await board.list()).filter((t) => t.pipelineRunId === root.id);
    const resultFor = async (stepId: string) => {
      const card = steps.find((t) => t.pipelineStepId === stepId);
      return card ? await board.getResult(card.id) : undefined;
    };
    // task_results doesn't store pipelineHandoff; a step's summary is its
    // raw final message, so the handoff is parsed back out of it.
    const gather = await resultFor("gather");
    const explain = await resultFor("explain");
    const final = await resultFor("script");
    const gatherHandoff = gather ? parsePipelineHandoff(gather.summary) : null;
    const explainHandoff = explain ? parsePipelineHandoff(explain.summary) : null;
    const finalHandoff = final ? parsePipelineHandoff(final.summary) : null;
    const audio = await resultFor("audio");
    const audioHandoff = audio ? parsePipelineHandoff(audio.summary) : null;
    const costUsd = await costFromTelemetry(telemetryPath, new Set([root.id, ...steps.map((t) => t.id)]));
    // Kept next to the run's JSON so it can be listened to; homeDir is deleted below.
    const mp3 = await readFile(audioFilePath(audioDir, root.id)).catch(() => null);
    const mp3Copy = join(outDir, `run-${n}.mp3`);
    if (mp3) await writeFile(mp3Copy, mp3);
    const script = finalHandoff?.data && typeof finalHandoff.data.script === "string" ? finalHandoff.data.script : "";

    const checks: AiNewsCheck[] = [
      {
        name: "run-status",
        pass: root.status === "done",
        detail: `run ${root.status}; steps: ${steps.map((t) => `${t.pipelineStepId}=${t.status}`).join(", ")}${audio && !audio.ok ? `; audio: ${audio.summary}` : ""}`,
      },
      ...(WORLD ? checkWorldNewsRun : checkAiNewsRun)({ gather: gatherHandoff?.data, explain: explainHandoff?.data, final: finalHandoff?.data, costUsd, now }),
      checkAudio({ audio: audioHandoff?.data, file: mp3 ? new Uint8Array(mp3) : null, words: countWords(script) }),
    ];
    const pass = checks.every((c) => c.pass);

    for (const c of checks) console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
    const file = join(outDir, `run-${n}.json`);
    await writeFile(
      file,
      JSON.stringify(
        { pass, root: { id: root.id, status: root.status }, checks, costUsd, gather: gatherHandoff, explain: explainHandoff, final: finalHandoff, audio: audioHandoff, summaries: { gather: gather?.summary, explain: explain?.summary, script: final?.summary, audio: audio?.summary } },
        null,
        2,
      ),
    );
    console.log(`  ${pass ? "PASS" : "FAIL"}  run ${n}  (outputs: ${file}${mp3 ? `, audio: ${mp3Copy}` : ""})`);
    return pass;
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const outDir = join(WORLD ? "/tmp/wissel-eval-world-news" : "/tmp/wissel-eval-ai-news", new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(outDir, { recursive: true });
  let passes = 0;
  let fails = 0;
  for (let n = 1; n <= RUNS && passes < NEEDED && fails <= RUNS - NEEDED; n++) {
    if (await runOnce(n, outDir)) passes++;
    else fails++;
  }
  const ok = passes >= NEEDED;
  console.log(`\n${ok ? "PASS" : "FAIL"}: ${passes} of ${passes + fails} runs passed every check (need ${NEEDED} of ${RUNS}). Outputs in ${outDir}`);
  if (!ok) process.exit(1);
}

await main();
