// Review policy (docs/SDD-coordinator.md §4.6): the pure verdict evaluator,
// the fix-round builder that refuses an empty review, the findings
// extension of the review-verdict contract, and reviewPolicy as a project
// setting.

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { ReviewPolicy, ReviewVerdict } from "../src/core/types.ts";
import { parseReviewVerdict } from "../src/executors/parse-review-verdict.ts";
import { buildFixRoundBody, evaluateReviewVerdict, reviewPolicyError, reviewTextOf, severityCounts } from "../src/services/review-policy.ts";
import { validateProjectSettings } from "../src/services/project-settings.ts";
import { SqliteProjectStore } from "../src/services/projects.ts";

const POLICY: ReviewPolicy = {
  tiers: [
    { id: "light", when: "docs only", reviewers: [{ model: "other-than-coder", mode: "standard" }], maxRounds: 1 },
    { id: "full", when: "code", reviewers: [{ model: "other-than-coder", mode: "adversarial" }], maxRounds: 2 },
  ],
  blocks: ["HIGH", "MED-with-scenario"],
  carryForward: "ticket",
  atCap: "ask-decider",
};
const HIGH = { severity: "HIGH" as const, title: "drops writes", scenario: true };
const MED_SCENARIO = { severity: "MED" as const, title: "race on restart", scenario: true };
const MED = { severity: "MED" as const, title: "unclear name", scenario: false };
const LOW = { severity: "LOW" as const, title: "typo", scenario: false };
const FIX_ROUND = "# Fix round {round} for {key}\n\nFiles:\n{files}\n\n## Review\n\n{review}\n";

// ---------- evaluator ----------

test("severityCounts counts each level, zero when the verdict lists no findings", () => {
  expect(severityCounts({ verdict: "approve", feedback: "ok" })).toEqual({ HIGH: 0, MED: 0, LOW: 0 });
  expect(severityCounts({ verdict: "changes_requested", feedback: "x", findings: [HIGH, MED, MED_SCENARIO, LOW] })).toEqual({ HIGH: 1, MED: 2, LOW: 1 });
});

test("evaluateReviewVerdict: nothing blocking passes; non-blocking findings carry forward per policy", () => {
  const verdict: ReviewVerdict = { verdict: "approve", feedback: "fine", findings: [MED, LOW] };
  expect(evaluateReviewVerdict(POLICY, "full", verdict, 1)).toEqual({ kind: "pass", carryForward: "ticket", carried: [MED, LOW] });
  expect(evaluateReviewVerdict({ ...POLICY, carryForward: "drop" }, "full", verdict, 1)).toEqual({ kind: "pass", carryForward: "drop", carried: [] });
  // The policy, not the verdict's word, decides: changes_requested over a LOW finding alone passes.
  const lowOnly: ReviewVerdict = { verdict: "changes_requested", feedback: "nit", findings: [LOW] };
  expect(evaluateReviewVerdict(POLICY, "full", lowOnly, 1).kind).toBe("pass");
});

test("evaluateReviewVerdict: blocks by severity, with MED only when the finding carries a scenario", () => {
  const verdict: ReviewVerdict = { verdict: "approve", feedback: "looks ok", findings: [MED_SCENARIO, MED, LOW] };
  const r = evaluateReviewVerdict(POLICY, "full", verdict, 1);
  expect(r).toEqual({ kind: "fix-round", round: 2, maxRounds: 2, blocking: [MED_SCENARIO], carryForward: "ticket", carried: [MED, LOW] });
  // `blocks: ["MED"]` blocks every MED; `["HIGH"]` leaves MED alone even with a scenario.
  expect(evaluateReviewVerdict({ ...POLICY, blocks: ["MED"] }, "full", verdict, 1)).toMatchObject({ kind: "fix-round", blocking: [MED_SCENARIO, MED] });
  expect(evaluateReviewVerdict({ ...POLICY, blocks: ["HIGH"] }, "full", verdict, 1).kind).toBe("pass");
  expect(evaluateReviewVerdict({ ...POLICY, blocks: ["HIGH"] }, "full", { ...verdict, findings: [HIGH, LOW] }, 1)).toMatchObject({ kind: "fix-round", blocking: [HIGH], carried: [LOW] });
});

test("evaluateReviewVerdict: changes_requested with no structured findings blocks (the reviewer's call stands)", () => {
  const legacy: ReviewVerdict = { verdict: "changes_requested", feedback: "Missing null check." };
  expect(evaluateReviewVerdict(POLICY, "full", legacy, 1)).toEqual({ kind: "fix-round", round: 2, maxRounds: 2, blocking: [], carryForward: "ticket", carried: [] });
  expect(evaluateReviewVerdict(POLICY, "full", { verdict: "approve", feedback: "ok" }, 1)).toEqual({ kind: "pass", carryForward: "ticket", carried: [] });
});

test("evaluateReviewVerdict: at the tier's maxRounds, atCap decides; an unknown tier uses the first tier", () => {
  const verdict: ReviewVerdict = { verdict: "changes_requested", feedback: "x", findings: [HIGH] };
  expect(evaluateReviewVerdict(POLICY, "full", verdict, 2)).toEqual({ kind: "at-cap", atCap: "ask-decider", maxRounds: 2, blocking: [HIGH] });
  expect(evaluateReviewVerdict({ ...POLICY, atCap: "accept" }, "full", verdict, 3).kind).toBe("at-cap");
  expect(evaluateReviewVerdict({ ...POLICY, atCap: "spec-question" }, "light", verdict, 1)).toMatchObject({ kind: "at-cap", atCap: "spec-question", maxRounds: 1 });
  expect(evaluateReviewVerdict(POLICY, "nope", verdict, 1)).toMatchObject({ kind: "at-cap", maxRounds: 1 });
  expect(evaluateReviewVerdict(POLICY, undefined, verdict, 0)).toMatchObject({ kind: "fix-round", round: 1 });
});

// ---------- fix-round builder ----------

test("reviewTextOf is the full feedback plus every finding, never an excerpt", () => {
  const feedback = "Line one.\n\n" + "x".repeat(600);
  const text = reviewTextOf({ verdict: "changes_requested", feedback, findings: [HIGH, MED] });
  expect(text.startsWith(feedback)).toBe(true);
  expect(text).toContain("- HIGH: drops writes (scenario given)");
  expect(text).toContain("- MED: unclear name");
  expect(reviewTextOf({ verdict: "approve", feedback: "  ok  " })).toBe("ok");
});

test("buildFixRoundBody renders the project's fix-round template with the full review and cardRules", () => {
  const project = { cardRules: "Never force-push.", cardTemplates: { "fix-round": FIX_ROUND } };
  const r = buildFixRoundBody(project, { round: 2, key: "A4", files: "- src/a.ts", review: "HIGH: off by one" });
  expect(r).toEqual({ ok: true, body: "# Fix round 2 for A4\n\nFiles:\n- src/a.ts\n\n## Review\n\nHIGH: off by one\n\nNever force-push." });
  // key, ticket and files are optional; the review and the round never are.
  expect(buildFixRoundBody(project, { round: 1, review: "r" })).toEqual({ ok: true, body: "# Fix round 1 for \n\nFiles:\n\n\n## Review\n\nr\n\nNever force-push." });
});

test("buildFixRoundBody refuses an empty review before touching the template, and a project without the template", () => {
  const project = { cardTemplates: { "fix-round": FIX_ROUND } };
  for (const review of ["", "  \n", undefined]) {
    const r = buildFixRoundBody(project, { round: 1, key: "A4", review: review as string });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("review text is empty; a fix round is never started from an empty review");
  }
  const none = buildFixRoundBody({}, { round: 1, review: "r" });
  expect(none.ok).toBe(false);
  if (!none.ok) expect(none.error).toBe('project has no "fix-round" card template');
  // The template's size limit still applies: a huge review is refused, not truncated.
  const huge = buildFixRoundBody(project, { round: 1, review: "x".repeat(3000) });
  expect(huge.ok).toBe(false);
  if (!huge.ok) expect(huge.error).toContain("at most 2500");
});

// ---------- verdict contract: findings ----------

test("parseReviewVerdict reads optional findings with severity, title and scenario; malformed entries are dropped", () => {
  const block = (findings: unknown) => `\`\`\`review-verdict\n${JSON.stringify({ verdict: "changes_requested", feedback: "f", findings })}\n\`\`\``;
  expect(parseReviewVerdict(block([{ severity: "HIGH", title: "drops writes", scenario: true }, { severity: "low", title: "typo" }]))).toEqual({
    verdict: "changes_requested",
    feedback: "f",
    findings: [HIGH, LOW],
  });
  // Unknown severity, missing title, non-object: dropped; an empty list is omitted.
  expect(parseReviewVerdict(block([{ severity: "CRITICAL", title: "x" }, { severity: "MED" }, "HIGH", null]))).toEqual({ verdict: "changes_requested", feedback: "f" });
  expect(parseReviewVerdict(block("HIGH"))).toEqual({ verdict: "changes_requested", feedback: "f" });
  // Findings are read on an approve too (a reviewer may approve with notes).
  const approve = `\`\`\`review-verdict\n${JSON.stringify({ verdict: "approve", feedback: "ok", findings: [MED] })}\n\`\`\``;
  expect(parseReviewVerdict(approve)).toEqual({ verdict: "approve", feedback: "ok", findings: [MED] });
});

// ---------- settings ----------

test("reviewPolicyError accepts the §4.6 shape and names what is wrong otherwise", () => {
  expect(reviewPolicyError(POLICY)).toBeUndefined();
  expect(reviewPolicyError(null)).toContain("reviewPolicy must be an object");
  expect(reviewPolicyError({ ...POLICY, tiers: [] })).toContain("at least one tier");
  expect(reviewPolicyError({ ...POLICY, tiers: [{ ...POLICY.tiers[0], maxRounds: 0 }] })).toContain("maxRounds");
  expect(reviewPolicyError({ ...POLICY, tiers: [{ ...POLICY.tiers[0], reviewers: [{ model: "", mode: "standard" }] }] })).toContain("model");
  expect(reviewPolicyError({ ...POLICY, tiers: [{ ...POLICY.tiers[0], reviewers: [{ model: "x", mode: "harsh" }] }] })).toContain("mode");
  expect(reviewPolicyError({ ...POLICY, tiers: [POLICY.tiers[0], POLICY.tiers[0]] })).toContain("duplicate tier");
  expect(reviewPolicyError({ ...POLICY, blocks: ["LOW"] })).toContain("blocks");
  expect(reviewPolicyError({ ...POLICY, carryForward: "email" })).toContain("carryForward");
  expect(reviewPolicyError({ ...POLICY, atCap: "merge" })).toContain("atCap");
});

test("reviewPolicy is a project setting: validated, stored, listed and cleared with null", async () => {
  expect(validateProjectSettings({ reviewPolicy: POLICY })).toEqual({ ok: true, patch: { reviewPolicy: POLICY } });
  expect(validateProjectSettings({ reviewPolicy: null })).toEqual({ ok: true, patch: { reviewPolicy: null } });
  const bad = validateProjectSettings({ reviewPolicy: { ...POLICY, atCap: "merge" } });
  expect(bad.ok).toBe(false);

  const db = new Database(":memory:");
  db.run(
    "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, source TEXT NOT NULL, sourceUrl TEXT, createdAt TEXT NOT NULL, eli5 TEXT, eli5UpdatedAt TEXT, mergeGate TEXT, mergeGateTimeoutMs INTEGER)",
  );
  db.run("INSERT INTO projects VALUES ('p', 'acme', '/r/acme', 'local', NULL, '2026-01-01', NULL, NULL, NULL, NULL)");
  const store = new SqliteProjectStore(db);
  const [before] = await store.list();
  expect("reviewPolicy" in before!).toBe(false);
  expect((await store.setSettings("p", { reviewPolicy: POLICY })).reviewPolicy).toEqual(POLICY);
  expect((await store.list())[0]!.reviewPolicy).toEqual(POLICY);
  expect(await store.settingsFor("/r/acme")).toEqual({ reviewPolicy: POLICY });
  await store.setSettings("p", { reviewPolicy: null });
  expect((await store.list())[0]).toEqual(before!);
});
