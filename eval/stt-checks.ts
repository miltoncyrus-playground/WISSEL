/**
 * The deterministic half of `eval:stt` (docs/SDD-wissel-app.md §4.4):
 * word error rate between what a fixture note says and what speech to
 * text heard, and the pass rule. Pure; test/stt-eval.test.ts covers it
 * for free.
 */

/** The eval passes when the corpus WER is at most this. */
export const MAX_WER = 0.15;
/** A sanity cap per note, far under POST /voice's 10 MB. The notes are
 *  not committed (.gitignore), so this is not about repo size; Kokoro's
 *  Opus runs about 12 KB a second, so a 6 to 7 second note is 60 to 80 KB. */
export const MAX_FIXTURE_BYTES = 256 * 1024;
/** How many notes the eval needs (§2, §4.4). */
export const FIXTURE_COUNT = 5;

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

/**
 * Text as words to compare: lower case, accents and punctuation gone,
 * "A.I." as "ai", "don't" as "dont", hyphens as spaces, and the numbers
 * 0 to 12 spelled out, since Whisper writes "6" for "six" as often as
 * not. Nothing else is rewritten: a real mishearing must still count.
 */
export function normalizeWords(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b([a-z])\.(?=[a-z]\.)/g, "$1")
    .replace(/(\w)['’](\w)/g, "$1$2")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((w) => (/^\d+$/.test(w) && Number(w) <= 12 ? NUMBER_WORDS[Number(w)]! : w));
}

export interface WerResult {
  /** Words in the reference. */
  words: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  /** (S + D + I) / N; 0 for an empty reference heard as empty. */
  wer: number;
}

/** Word error rate by word-level edit distance (Levenshtein). */
export function wordErrorRate(reference: string, hypothesis: string): WerResult {
  const ref = normalizeWords(reference);
  const hyp = normalizeWords(hypothesis);
  const n = ref.length;
  const m = hyp.length;
  // cost[i][j]: edits to turn ref[0..i) into hyp[0..j), with the ops that got there.
  type Cell = { cost: number; s: number; d: number; i: number };
  let prev: Cell[] = Array.from({ length: m + 1 }, (_, j) => ({ cost: j, s: 0, d: 0, i: j }));
  for (let i = 1; i <= n; i++) {
    const row: Cell[] = [{ cost: i, s: 0, d: i, i: 0 }];
    for (let j = 1; j <= m; j++) {
      const same = ref[i - 1] === hyp[j - 1];
      const diag = prev[j - 1]!;
      const up = prev[j]!;
      const left = row[j - 1]!;
      const options: Cell[] = [
        { cost: diag.cost + (same ? 0 : 1), s: diag.s + (same ? 0 : 1), d: diag.d, i: diag.i },
        { cost: up.cost + 1, s: up.s, d: up.d + 1, i: up.i },
        { cost: left.cost + 1, s: left.s, d: left.d, i: left.i + 1 },
      ];
      row.push(options.reduce((best, c) => (c.cost < best.cost ? c : best)));
    }
    prev = row;
  }
  const end = prev[m]!;
  return { words: n, substitutions: end.s, deletions: end.d, insertions: end.i, wer: n === 0 ? (m === 0 ? 0 : 1) : end.cost / n };
}

export interface NoteResult {
  id: string;
  reference: string;
  /** What speech to text heard, or null when the note failed. */
  heard: string | null;
  error?: string;
  wer?: WerResult;
  seconds?: number;
}

export interface SttVerdict {
  pass: boolean;
  /** Total errors over total reference words, every note counted. A
   *  failed note counts as every word missed. */
  corpusWer: number;
  reasons: string[];
}

export function judgeStt(results: NoteResult[], maxWer = MAX_WER): SttVerdict {
  const reasons: string[] = [];
  if (results.length < FIXTURE_COUNT) reasons.push(`only ${results.length} of ${FIXTURE_COUNT} notes were checked`);
  let errors = 0;
  let words = 0;
  for (const r of results) {
    const n = normalizeWords(r.reference).length;
    words += n;
    if (r.heard === null || !r.wer) {
      errors += n;
      reasons.push(`${r.id}: ${r.error ?? "no transcript"}`);
    } else {
      errors += r.wer.substitutions + r.wer.deletions + r.wer.insertions;
    }
  }
  const corpusWer = words === 0 ? 1 : errors / words;
  if (corpusWer > maxWer) reasons.push(`word error rate ${(corpusWer * 100).toFixed(1)}% is over ${(maxWer * 100).toFixed(0)}%`);
  return { pass: reasons.length === 0, corpusWer, reasons };
}
