// The decision-card quality cases (docs/SDD-coordinator.md §8): a fixed
// set of open questions, red gates, conflicts, plans and owner comments,
// each with what a good answer must do. All invented; no real project.
//
// Judged in code, no LLM judge: `judgeDecision` checks the schema (the
// executor's parseDecision already refused anything off-schema, so a
// valid answer is a non-null DecisionOutput of the right kind) and
// agreement with the case's expectation. test/decision-quality-eval.test.ts
// checks every case against its right and wrong answers for free.
import type { DecisionOutput, ImplementedKind } from "../src/services/decisions.ts";

export interface DecisionExpectation {
  /** triage-red and resolve-conflict: the verdict a careful engineer gives. */
  verdict?: string;
  /** decide-default: the default's text must match. */
  text?: RegExp;
  /** plan-batch: how many cards, and a pattern some card's title or body matches. */
  cards?: { min: number; max: number; anyMatches?: RegExp };
  /** read-owner-comments: how many answers and follow-ups. */
  answers?: { min: number; max?: number };
  followUps?: { min: number; max?: number; anyMatches?: RegExp };
}

export interface DecisionCase {
  name: string;
  kind: ImplementedKind;
  context: string;
  expect: DecisionExpectation;
  /** An answer that agrees, and one that doesn't: the judge's own check. */
  right: DecisionOutput;
  wrong: DecisionOutput;
}

export interface DecisionJudgement {
  valid: boolean;
  agrees: boolean;
  why: string;
}

export function judgeDecision(c: DecisionCase, out: DecisionOutput | null | undefined): DecisionJudgement {
  if (!out) return { valid: false, agrees: false, why: "no valid decision block" };
  if (out.kind !== c.kind) return { valid: false, agrees: false, why: `kind ${out.kind}, expected ${c.kind}` };
  const e = c.expect;
  const no = (why: string): DecisionJudgement => ({ valid: true, agrees: false, why });
  if (e.verdict !== undefined && "verdict" in out && out.verdict !== e.verdict) return no(`verdict ${out.verdict}, expected ${e.verdict}`);
  if (e.text && out.kind === "decide-default" && !e.text.test(out.text)) return no(`default "${out.text.slice(0, 80)}" doesn't match ${e.text}`);
  if (e.cards && out.kind === "plan-batch") {
    const n = out.cards.length;
    if (n < e.cards.min || n > e.cards.max) return no(`${n} cards, expected ${e.cards.min} to ${e.cards.max}`);
    if (e.cards.anyMatches && !out.cards.some((x) => e.cards!.anyMatches!.test(`${x.title}\n${x.body}`))) return no(`no card matches ${e.cards.anyMatches}`);
  }
  if (out.kind === "read-owner-comments") {
    if (e.answers && (out.answers.length < e.answers.min || (e.answers.max !== undefined && out.answers.length > e.answers.max))) return no(`${out.answers.length} answers, expected ${e.answers.min} to ${e.answers.max ?? "any"}`);
    const f = e.followUps;
    if (f && (out.followUps.length < f.min || (f.max !== undefined && out.followUps.length > f.max))) return no(`${out.followUps.length} follow-ups, expected ${f.min} to ${f.max ?? "any"}`);
    if (f?.anyMatches && !out.followUps.some((x) => f.anyMatches!.test(`${x.title}\n${x.body}`))) return no(`no follow-up matches ${f.anyMatches}`);
  }
  return { valid: true, agrees: true, why: "agrees" };
}

export const DECISION_CASES: DecisionCase[] = [
  {
    name: "triage: network flake in CI",
    kind: "triage-red",
    context:
      "The checks on PR #41 failed after their one retry. The failing job: `Install browsers` exited 1 with `Error: read ECONNRESET` while downloading chromium from the CDN. No test ran. The same commit passed every check on the previous push an hour ago, and the change only touches src/report/format.ts.",
    expect: { verdict: "retry" },
    right: { kind: "triage-red", verdict: "retry", reason: "A network reset while downloading browsers; no test ran." },
    wrong: { kind: "triage-red", verdict: "fix-round", reason: "Fix the install." },
  },
  {
    name: "triage: the code contradicts the brief",
    kind: "triage-red",
    context:
      'The checks on PR #42 failed after their retry. `test/retry.test.ts > gives up after 3 attempts`: expected 3 calls, received 5. The card\'s brief: "Retry the upload at most 3 times, then fail with the last error." The diff sets MAX_ATTEMPTS = 5 in src/upload.ts.',
    expect: { verdict: "fix-round" },
    right: { kind: "triage-red", verdict: "fix-round", reason: "MAX_ATTEMPTS is 5; the brief and the test say 3." },
    wrong: { kind: "triage-red", verdict: "retry", reason: "Flaky." },
  },
  {
    name: "triage: the brief can't be met as written",
    kind: "triage-red",
    context:
      'The checks on PR #43 failed after their retry. Two tests contradict each other: `export includes deleted rows` and `export never contains deleted data`. Both come from the card\'s brief, which says: "The export must include every row, deleted ones too, for the audit" and later "Deleted customer data must never leave the system, including in exports." Each fix makes the other test fail.',
    expect: { verdict: "spec-question" },
    right: { kind: "triage-red", verdict: "spec-question", reason: "The brief asks for deleted rows in the export and forbids them." },
    wrong: { kind: "triage-red", verdict: "fix-round", reason: "Make both pass." },
  },
  {
    name: "conflict: both sides added imports",
    kind: "resolve-conflict",
    context:
      "Merging main into the PR #44 conflicts in src/app.ts only, in the import block. Main added `import { metrics } from \"./metrics\";`. The card added `import { retry } from \"./retry\";` on the same line. Nothing else conflicts; both imports are used further down in their own changes.",
    expect: { verdict: "card" },
    right: { kind: "resolve-conflict", verdict: "card", resolution: "Keep both imports, main's then the card's." },
    wrong: { kind: "resolve-conflict", verdict: "ask", question: "Which import?", reason: "Unclear." },
  },
  {
    name: "conflict: a product rule both sides changed",
    kind: "resolve-conflict",
    context:
      'Merging main into the PR #45 conflicts in src/pricing.ts. Main, from finance\'s ticket FIN-9 ("discounts apply after tax, by law in the new market"), moved the discount after tax. The card, from its brief ("apply the loyalty discount before tax, as the marketing page promises"), moved it before tax. The two change the price customers pay in opposite ways.',
    expect: { verdict: "ask" },
    right: { kind: "resolve-conflict", verdict: "ask", question: "Does the discount apply before or after tax?", reason: "Finance and marketing want opposite orders." },
    wrong: { kind: "resolve-conflict", verdict: "card", resolution: "Keep the card's order." },
  },
  {
    name: "default: timestamps across regions",
    kind: "decide-default",
    context:
      "Open question on card A7: which timezone should the new events table store timestamps in? The service runs in three regions (Frankfurt, Virginia, Singapore), and on-call compares logs and events across hosts. Nobody has answered for two days.",
    expect: { text: /\bUTC\b/i },
    right: { kind: "decide-default", text: "Store timestamps in UTC.", alternative: "Store each region's local time with its offset.", lean: "Logs compare across regions." },
    wrong: { kind: "decide-default", text: "Store Frankfurt local time.", alternative: "UTC", lean: "Most users are there." },
  },
  {
    name: "default: a page size with no requirement",
    kind: "decide-default",
    context:
      "Open question on card B2: what default page size should the internal admin list of API keys use? Teams have 5 to 200 keys. There is no requirement and no design; other admin lists in the product use 25 or 50.",
    expect: { text: /\b(25|50)\b/ },
    right: { kind: "decide-default", text: "Default to 50 per page.", alternative: "25 per page", lean: "Matches the other admin lists and fits most teams on one page." },
    wrong: { kind: "decide-default", text: "Show all keys on one page.", alternative: "50", lean: "Simplest." },
  },
  {
    name: "plan: a small feature in a few cards",
    kind: "plan-batch",
    context:
      "Free slots: 3. Ready cards: 0. The workstream's ticket SHOP-12: \"Customers can download their orders as CSV from the orders page. The file lists date, order number, items and total. Add the endpoint, the button, and a line in the help page.\" Done so far: nothing.",
    expect: { cards: { min: 2, max: 5, anyMatches: /\b(endpoint|csv)\b/i } },
    right: { kind: "plan-batch", cards: [{ key: "C1", title: "CSV export endpoint", body: "GET /orders.csv" }, { key: "C2", title: "Download button", body: "On the orders page" }, { key: "C3", title: "Help page line", body: "Document it" }] },
    wrong: { kind: "plan-batch", cards: [{ title: "Do SHOP-12", body: "All of it." }] },
  },
  {
    name: "owner comments: a question and a request",
    kind: "read-owner-comments",
    context:
      'The owner\'s comments on the workstream\'s review doc:\n1. "Why does the upload retry only 3 times?" The card\'s brief says: 3, because the storage provider rate-limits after 4 quick attempts.\n2. "Please also let customers download the receipts as PDF."',
    expect: { answers: { min: 1 }, followUps: { min: 1, max: 2, anyMatches: /\bpdf\b/i } },
    right: { kind: "read-owner-comments", answers: [{ comment: "Why 3 retries?", answer: "The provider rate-limits after 4 quick attempts." }], followUps: [{ title: "PDF receipts", body: "Let customers download receipts as PDF." }] },
    wrong: { kind: "read-owner-comments", answers: [{ comment: "Why 3 retries?", answer: "Arbitrary." }], followUps: [] },
  },
  {
    name: "owner comments: thanks only",
    kind: "read-owner-comments",
    context: 'The owner\'s comments on the workstream\'s review doc:\n1. "Looks good, thanks. Nice work on the export."',
    expect: { answers: { min: 0, max: 1 }, followUps: { min: 0, max: 0 } },
    right: { kind: "read-owner-comments", answers: [{ comment: "Looks good, thanks.", answer: "Thanks!" }], followUps: [] },
    wrong: { kind: "read-owner-comments", answers: [], followUps: [{ title: "Polish the export", body: "More work." }] },
  },
];
