#!/usr/bin/env bun
/**
 * Live eval for the "Wissel retrospective podcast" pipeline
 * (docs/SDD-wissel-retro-podcast.md §2, §3.4). Real `claude -p` calls for
 * the analyse and script steps, real local Kokoro for audio, and a real
 * digest of this machine's wissel activity. Paid: not run by `bun test`;
 * run it with `bun run eval:wissel-retro` before ship or nightly.
 *
 * The collect step reads a COPY of the real board (`WISSEL_DB_PATH`,
 * default `~/.wissel/board.sqlite`, plus its -wal file) made in a temp
 * dir, the real telemetry (`WISSEL_TELEMETRY_PATH`, read only), the real
 * memory/lessons.md and docs/, and read-only git. The pipeline itself is
 * seeded into a throwaway in-memory board with
 * scripts/seed-ai-news-pipeline.ts and run with no repo; its own
 * telemetry goes to a temp file, so the cost check is this run's alone.
 *
 * Checks (eval/ai-news-checks.ts checkRetroRun plus run-status and
 * checkAudio): the digest has stories, every quick-read link and every
 * analysis source is a digest URL, all four groups are present, every
 * learnings and improve item cites a source, script 600 to 1000 words,
 * run cost under $1.00, a real MP3 that fits the script.
 *
 * Pass threshold: all checks on at least 2 of 3 runs, stopping early once
 * decided. Outputs per run in /tmp/wissel-eval-wissel-retro/<timestamp>/.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../src/core/registry.ts";
import { startPipelineRun, type PipelineRunnerContext } from "../src/core/pipeline-runner.ts";
import { ReadOnlyExecutor } from "../src/executors/readonly.ts";
import { runViaBun } from "../src/executors/claude-cli.ts";
import { DigestExecutor } from "../src/executors/digest.ts";
import { parsePipelineHandoff } from "../src/executors/parse-pipeline-handoff.ts";
import { TtsExecutor, audioFilePath } from "../src/executors/tts.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { SqlitePipelineStore } from "../src/services/pipelines.ts";
import { TelemetryLog } from "../src/services/telemetry.ts";
import { seedWisselRetroPipeline } from "../scripts/seed-ai-news-pipeline.ts";
import { checkAudio, checkRetroRun, countWords, type AiNewsCheck } from "./ai-news-checks.ts";
import { costFromTelemetry, snapshotBoard } from "../scripts/check-news-run.ts";

const RUNS = 3;
const NEEDED = 2;
/** The run input (the period). Long enough to have real activity;
 *  override with `bun run eval:wissel-retro -- --input "last 30 days"`. */
const inputAt = process.argv.indexOf("--input");
const INPUT = inputAt > -1 && process.argv[inputAt + 1] ? process.argv[inputAt + 1]! : "last 14 days";

/** A read-only snapshot of the real board (scripts/check-news-run.ts). */
function snapshotRealBoard(dir: string): Promise<SqliteBoard> {
  return snapshotBoard(process.env.WISSEL_DB_PATH ?? join(homedir(), ".wissel", "board.sqlite"), dir);
}

async function runOnce(n: number, outDir: string): Promise<boolean> {
  const homeDir = await mkdtemp(join(tmpdir(), "wissel-eval-retro-home-"));
  const telemetryPath = join(homeDir, "telemetry.jsonl");
  try {
    const realBoard = await snapshotRealBoard(homeDir);
    const board = new SqliteBoard();
    const pipelines = new SqlitePipelineStore(board.db);
    const registry = await Registry.load();
    const { pipeline } = await seedWisselRetroPipeline(pipelines, registry);
    const audioDir = join(homeDir, "audio");
    const ctx: PipelineRunnerContext = {
      executors: [
        new ReadOnlyExecutor({ runner: runViaBun, homeDir }),
        new TtsExecutor({ baseUrl: process.env.WISSEL_TTS_URL, voice: process.env.WISSEL_TTS_VOICE, audioDir }),
        new DigestExecutor({
          board: realBoard,
          telemetryPath: process.env.WISSEL_TELEMETRY_PATH ?? join(homedir(), ".wissel", "telemetry.jsonl"),
          lessonsPath: process.env.WISSEL_MEMORY_PATH,
          runner: runViaBun,
          agentModel: (id) => registry.get(id)?.costProfile.model,
        }),
      ],
      pipelines,
      telemetry: new TelemetryLog(telemetryPath),
    };

    console.log(`Run ${n}: "${pipeline.name}" with input "${INPUT}" (real claude, real board snapshot)...`);
    const root = await startPipelineRun(board, registry, pipeline, undefined, INPUT, ctx);

    const steps = (await board.list()).filter((t) => t.pipelineRunId === root.id);
    const resultFor = async (stepId: string) => {
      const card = steps.find((t) => t.pipelineStepId === stepId);
      return card ? await board.getResult(card.id) : undefined;
    };
    const collect = await resultFor("collect");
    const analyse = await resultFor("analyse");
    const final = await resultFor("script");
    const audio = await resultFor("audio");
    const handoff = (r: { summary: string } | undefined) => (r ? parsePipelineHandoff(r.summary) : null);
    const collectH = handoff(collect);
    const analyseH = handoff(analyse);
    const finalH = handoff(final);
    const audioH = handoff(audio);
    const costUsd = await costFromTelemetry(telemetryPath, new Set([root.id, ...steps.map((t) => t.id)]));
    const mp3 = await readFile(audioFilePath(audioDir, root.id)).catch(() => null);
    const mp3Copy = join(outDir, `run-${n}.mp3`);
    if (mp3) await writeFile(mp3Copy, mp3);
    const script = finalH?.data && typeof finalH.data.script === "string" ? finalH.data.script : "";

    const checks: AiNewsCheck[] = [
      {
        name: "run-status",
        pass: root.status === "done",
        detail: `run ${root.status}; steps: ${steps.map((t) => `${t.pipelineStepId}=${t.status}`).join(", ")}${audio && !audio.ok ? `; audio: ${audio.summary}` : ""}`,
      },
      ...checkRetroRun({ gather: collectH?.data, analysis: analyseH?.data, final: finalH?.data, costUsd }),
      checkAudio({ audio: audioH?.data, file: mp3 ? new Uint8Array(mp3) : null, words: countWords(script) }),
    ];
    const pass = checks.every((c) => c.pass);
    for (const c of checks) console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
    const file = join(outDir, `run-${n}.json`);
    await writeFile(
      file,
      JSON.stringify(
        { pass, input: INPUT, root: { id: root.id, status: root.status }, checks, costUsd, collect: collectH, analyse: analyseH, final: finalH, audio: audioH },
        null,
        2,
      ),
    );
    console.log(`  ${pass ? "PASS" : "FAIL"}  run ${n}  (outputs: ${file}${mp3 ? `, audio: ${mp3Copy}` : ""})`);
    realBoard.db.close();
    return pass;
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const outDir = join("/tmp/wissel-eval-wissel-retro", new Date().toISOString().replace(/[:.]/g, "-"));
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
