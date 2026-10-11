#!/usr/bin/env bun
/**
 * Periodic eval for Ask's voice notes (docs/SDD-wissel-app.md §3.5,
 * §4.4): the five committed fixture notes (eval/fixtures/stt/, each an
 * Opus file under 256 KB) go through the real `POST /voice` (createApp,
 * src/services/stt.ts) to the real local speaches, and what it hears is
 * compared with what each note says. Judged in code (eval/stt-checks.ts):
 * pass when the word error rate over all five is at most 15%.
 *
 * Not run by `bun test`: it needs speaches running (WISSEL_STT_URL,
 * default http://127.0.0.1:8000) and takes CPU time. No model spend.
 * Invoke with `bun run eval:stt`, or `bun run eval:stt -- --stt-url URL`.
 * Exits 2 without judging when speaches isn't reachable or a fixture is
 * missing; results in /tmp/wissel-eval-stt/results.json.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { DEFAULT_STT_URL, SttClient } from "../src/services/stt.ts";
import { FIXTURE_COUNT, MAX_FIXTURE_BYTES, judgeStt, wordErrorRate, type NoteResult, type SttVerdict } from "./stt-checks.ts";

export const FIXTURE_DIR = join(import.meta.dir, "fixtures", "stt");
const OUT_DIR = "/tmp/wissel-eval-stt";

export interface FixtureNote {
  id: string;
  file: string;
  text: string;
}

export function loadNotes(dir = FIXTURE_DIR): FixtureNote[] {
  return JSON.parse(readFileSync(join(dir, "notes.json"), "utf8")) as FixtureNote[];
}

/** Why the fixtures can't be used, or [] when all are there and small. */
export function fixtureProblems(notes: FixtureNote[], dir = FIXTURE_DIR): string[] {
  const problems: string[] = [];
  if (notes.length !== FIXTURE_COUNT) problems.push(`notes.json lists ${notes.length} notes, not ${FIXTURE_COUNT}`);
  for (const n of notes) {
    const path = join(dir, n.file);
    if (!existsSync(path)) problems.push(`${n.file} is missing`);
    else if (statSync(path).size >= MAX_FIXTURE_BYTES) problems.push(`${n.file} is ${statSync(path).size} bytes, over the ${MAX_FIXTURE_BYTES} limit`);
  }
  return problems;
}

/** Each note through `POST /voice` on `app`, in order. */
export async function transcribeNotes(app: (req: Request) => Promise<Response>, notes: FixtureNote[], dir = FIXTURE_DIR): Promise<NoteResult[]> {
  const results: NoteResult[] = [];
  for (const n of notes) {
    const form = new FormData();
    form.append("file", new File([readFileSync(join(dir, n.file))], n.file, { type: "audio/ogg" }));
    const started = performance.now();
    const res = await app(new Request("http://localhost/voice", { method: "POST", body: form }));
    const seconds = Math.round((performance.now() - started) / 100) / 10;
    const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
    if (!res.ok || typeof body.text !== "string") {
      results.push({ id: n.id, reference: n.text, heard: null, error: body.error ?? `HTTP ${res.status}`, seconds });
    } else {
      results.push({ id: n.id, reference: n.text, heard: body.text, wer: wordErrorRate(n.text, body.text), seconds });
    }
  }
  return results;
}

export function report(results: NoteResult[], verdict: SttVerdict): string {
  const lines = results.map((r) => {
    const wer = r.wer ? `${(r.wer.wer * 100).toFixed(1).padStart(5)}%` : "  fail";
    return `${wer}  ${String(r.seconds ?? "-").padStart(5)} s  ${r.id}\n          said:  ${r.reference}\n          heard: ${r.heard ?? r.error}`;
  });
  lines.push("", `Word error rate: ${(verdict.corpusWer * 100).toFixed(1)}% (pass at 15% or less)`, verdict.pass ? "PASS" : `FAIL: ${verdict.reasons.join("; ")}`);
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const urlArg = args.indexOf("--stt-url");
  const url = (urlArg >= 0 ? args[urlArg + 1] : undefined) || process.env.WISSEL_STT_URL || DEFAULT_STT_URL;
  const model = process.env.WISSEL_STT_MODEL || undefined;
  const language = process.env.WISSEL_STT_LANGUAGE || undefined;

  const notes = loadNotes();
  let problems = fixtureProblems(notes);
  // The Opus notes are not committed (no binaries in the repo, and
  // .gitignore keeps them out): make whichever are missing from the
  // local Kokoro first. A recorded note already there is kept.
  if (problems.length && problems.every((p) => p.endsWith(" is missing"))) {
    console.log("eval:stt: making the missing notes with Kokoro (scripts/make-stt-fixtures.ts)");
    Bun.spawnSync(["bun", join(import.meta.dir, "..", "scripts", "make-stt-fixtures.ts")], { stdout: "inherit", stderr: "inherit" });
    problems = fixtureProblems(notes);
  }
  if (problems.length) {
    console.error(`eval:stt can't run: ${problems.join("; ")}.`);
    console.error("Make the notes with `bun run scripts/make-stt-fixtures.ts` (needs Kokoro), or record your own: see eval/fixtures/stt/README.md.");
    process.exit(2);
  }
  const health = await new SttClient({ baseUrl: url }).checkHealth();
  if (health) {
    console.error(`eval:stt can't run: ${health}`);
    process.exit(2);
  }

  const app = createApp(new SqliteBoard(), await Registry.load(), undefined, { stt: { url, model, language } });
  console.log(`eval:stt: ${notes.length} notes through POST /voice to ${url}${model ? ` (${model})` : ""}\n`);
  const results = await transcribeNotes(app, notes);
  const verdict = judgeStt(results);
  console.log(report(results, verdict));

  await mkdir(OUT_DIR, { recursive: true });
  const out = join(OUT_DIR, "results.json");
  await writeFile(out, JSON.stringify({ at: new Date().toISOString(), url, model: model ?? "default", verdict, results }, null, 2));
  console.log(`\nResults: ${out}`);
  process.exit(verdict.pass ? 0 : 1);
}

if (import.meta.main) await main();
