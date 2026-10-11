import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { FIXTURE_COUNT, MAX_FIXTURE_BYTES, MAX_WER, judgeStt, normalizeWords, wordErrorRate, type NoteResult } from "../eval/stt-checks.ts";
import { FIXTURE_DIR, fixtureProblems, loadNotes, report, transcribeNotes, type FixtureNote } from "../eval/stt.eval.ts";
import { startFakeSpeaches } from "./fixtures/fake-speaches.ts";

// eval:stt's judge and plumbing (docs/SDD-wissel-app.md §4.4), for free:
// WER by hand-checked cases, the pass rule, and the run through the real
// POST /voice against a fake speaches.

describe("normalizeWords", () => {
  test("case, punctuation, A.I., apostrophes, hyphens and small numbers", () => {
    expect(normalizeWords("Run the A.I. news podcast, now!")).toEqual(["run", "the", "ai", "news", "podcast", "now"]);
    expect(normalizeWords("Don't re-run it at 6.")).toEqual(["dont", "re", "run", "it", "at", "six"]);
    expect(normalizeWords("Café README 2026")).toEqual(["cafe", "readme", "2026"]);
    expect(normalizeWords("  ")).toEqual([]);
  });
});

describe("wordErrorRate", () => {
  test("identical after normalising is 0", () => {
    expect(wordErrorRate("Schedule it for six.", "schedule it for 6")).toEqual({ words: 4, substitutions: 0, deletions: 0, insertions: 0, wer: 0 });
  });

  test("counts substitutions, deletions and insertions by edit distance", () => {
    expect(wordErrorRate("the cat sat on the mat", "the cat sit on mat")).toEqual({ words: 6, substitutions: 1, deletions: 1, insertions: 0, wer: 2 / 6 });
    expect(wordErrorRate("show me the board", "show me the whole board please")).toEqual({ words: 4, substitutions: 0, deletions: 0, insertions: 2, wer: 0.5 });
    expect(wordErrorRate("a b c", "")).toMatchObject({ deletions: 3, wer: 1 });
    expect(wordErrorRate("", "")).toMatchObject({ wer: 0 });
    expect(wordErrorRate("", "noise")).toMatchObject({ wer: 1 });
  });
});

describe("judgeStt", () => {
  const ok = (id: string, reference: string, heard: string): NoteResult => ({ id, reference, heard, wer: wordErrorRate(reference, heard) });
  const five = (heard: (i: number) => string) => Array.from({ length: 5 }, (_, i) => ok(`n${i}`, "one two three four five six seven eight nine ten", heard(i)));

  test("pass at 15% or less over all notes; corpus-weighted", () => {
    // 7 errors in 50 words = 14%.
    const r = five((i) => (i < 3 ? "one two three four five six seven eight nine tin" : i === 3 ? "one two three four five six seven ate nein tin" : "one two three four five six seven eight nine ten"));
    const v = judgeStt(r);
    expect(v.corpusWer).toBeCloseTo(0.12, 5);
    expect(v.pass).toBe(true);
    expect(MAX_WER).toBe(0.15);
  });

  test("fail over 15%, naming the rate", () => {
    const v = judgeStt(five(() => "one two three four five six seven eight xx yy"));
    expect(v.corpusWer).toBeCloseTo(0.2, 5);
    expect(v.pass).toBe(false);
    expect(v.reasons).toEqual(["word error rate 20.0% is over 15%"]);
  });

  test("a failed note counts as every word missed, and too few notes fail", () => {
    const r = five(() => "one two three four five six seven eight nine ten");
    r[0] = { id: "n0", reference: r[0]!.reference, heard: null, error: "HTTP 503" };
    const v = judgeStt(r);
    expect(v.corpusWer).toBeCloseTo(0.2, 5);
    expect(v.reasons[0]).toBe("n0: HTTP 503");
    expect(judgeStt(r.slice(1)).reasons).toContain("only 4 of 5 notes were checked");
  });
});

describe("the fixture notes", () => {
  test("notes.json lists five distinct Opus notes with what each says", () => {
    const notes = loadNotes();
    expect(notes).toHaveLength(FIXTURE_COUNT);
    expect(new Set(notes.map((n) => n.id)).size).toBe(FIXTURE_COUNT);
    for (const n of notes) {
      expect(n.file).toBe(`${n.id}.opus`);
      expect(normalizeWords(n.text).length).toBeGreaterThanOrEqual(10);
    }
  });

  test("every note on disk is under the size cap", () => {
    for (const n of loadNotes()) {
      const path = join(FIXTURE_DIR, n.file);
      if (existsSync(path)) expect(statSync(path).size).toBeLessThan(MAX_FIXTURE_BYTES);
    }
  });
});

describe("the eval run, against a fake speaches", () => {
  const fake = startFakeSpeaches();
  let dir: string;
  afterAll(async () => {
    fake.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("each note goes through POST /voice; a perfect hearing passes and the report shows each note", async () => {
    dir = await mkdtemp(join(tmpdir(), "wissel-stt-eval-"));
    const notes: FixtureNote[] = loadNotes();
    for (const n of notes) await writeFile(join(dir, n.file), new Uint8Array(1000).fill(1));
    await writeFile(join(dir, "notes.json"), JSON.stringify(notes));
    expect(fixtureProblems(notes, dir)).toEqual([]);

    const said = new Map(notes.map((n) => [n.file, n.text]));
    fake.textFor = (name) => said.get(name) ?? "";
    const app = createApp(new SqliteBoard(), await Registry.load(), undefined, { stt: { url: fake.url } });
    const results = await transcribeNotes(app, notes, dir);
    expect(fake.requests.map((r) => r.filename)).toEqual(notes.map((n) => n.file));
    const v = judgeStt(results);
    expect(v).toEqual({ pass: true, corpusWer: 0, reasons: [] });
    expect(report(results, v)).toContain("heard: Run the AI news podcast now and tell me when the audio is ready.");

    // A deaf service fails every note, and the eval with it.
    fake.mode = "http500";
    const failed = judgeStt(await transcribeNotes(app, notes, dir));
    expect(failed.pass).toBe(false);
    expect(failed.corpusWer).toBe(1);
  });

  test("missing or oversized fixtures are named before anything runs", async () => {
    const notes = loadNotes();
    const d = await mkdtemp(join(tmpdir(), "wissel-stt-eval-"));
    try {
      await writeFile(join(d, notes[0]!.file), new Uint8Array(MAX_FIXTURE_BYTES));
      const problems = fixtureProblems(notes, d);
      expect(problems[0]).toBe(`${notes[0]!.file} is ${MAX_FIXTURE_BYTES} bytes, over the ${MAX_FIXTURE_BYTES} limit`);
      expect(problems.slice(1)).toEqual(notes.slice(1).map((n) => `${n.file} is missing`));
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});
