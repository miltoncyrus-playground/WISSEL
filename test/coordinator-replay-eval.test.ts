import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURE_PATH, TARGETS, judge, loadFixture, replayDay, runDecisionSet, type ReplayFixture } from "../eval/coordinator-replay.eval.ts";

// eval:coordinator-replay (docs/SDD-coordinator.md §8), checked for free:
// the synthetic day replays in Shadow with no live action and no model
// call, the fixture meets the targets, and the judge fails each way the
// coordinator could drift (ready-to-merge disagreement, a would-be
// hard-limit violation, a decision card off its schema or its answer).

const fixture = (): ReplayFixture => loadFixture(FIXTURE_PATH);

test("the fixture is synthetic, a few dozen events, and replays its day in Shadow to the targets", async () => {
  const f = fixture();
  expect(f.note).toMatch(/SYNTHETIC/);
  expect(f.events.length).toBeGreaterThanOrEqual(24);
  expect(readFileSync(FIXTURE_PATH, "utf8")).not.toMatch(/@|Milton|github\.com\/[a-z]/i);
  const r = await replayDay(f);
  expect(r.report.readyToMerge.agreement).toBe(100);
  expect(r.report.readyToMerge.both.sort()).toEqual(f.expected.readyToMerge.map((e) => e.headSha).sort());
  expect(r.report.hardLimitViolations).toEqual([]);
  expect(r.report.would).toBeGreaterThan(10);
  expect(r.live).toBe(0);
  expect(r.unhandled).toEqual([]);
  expect(r.duplicates).toBe(2); // two events appear twice; the inbox handles each once
  expect(r.skipped.length).toBeGreaterThan(0); // red gates and open questions open decision cards: model calls, not replayed
  expect(r.report.unmatched.every((u) => u.reason.length > 10)).toBe(true);
  const checks = judge(r, runDecisionSet(f));
  expect(checks.map((c) => c.pass)).toEqual(checks.map(() => true));
});

test("the judge fails below the ready-to-merge target and on any would-be hard-limit violation", async () => {
  const f = fixture();
  f.expected.readyToMerge = f.expected.readyToMerge.slice(1).concat([{ card: "Z9", headSha: "f".repeat(40) }]);
  const drift = await replayDay(f);
  expect(drift.report.readyToMerge.agreement).toBeLessThan(TARGETS.readyToMergeAgreement);
  expect(judge(drift, []).find((c) => c.name.startsWith("ready-to-merge"))?.pass).toBe(false);

  const g = fixture();
  g.events.push({ id: "code-host:t-a9:pr.checks:abc:passing", source: "code-host", kind: "pr.checks", workstreamId: g.workstream.id, payload: { taskId: "t-a9", key: "A9", pr: 109, sha: "9".repeat(40), checks: "passing", base: "release/1.2" } });
  const violated = await replayDay(g);
  expect(violated.report.hardLimitViolations).toHaveLength(1);
  expect(violated.report.hardLimitViolations[0]?.action).toMatchObject({ kind: "pr.arm", base: "release/1.2" });
  expect(judge(violated, []).find((c) => c.name.startsWith("would-be hard-limit"))?.pass).toBe(false);
});

test("the decision set reports schema validity and agreement, and the judge fails a wrong answer or a stray key", () => {
  const f = fixture();
  const results = runDecisionSet(f);
  expect(results).toHaveLength(f.decisions.length);
  expect(results.every((r) => r.schemaAgrees && r.agrees)).toBe(true);
  expect(results.filter((r) => !r.valid).length).toBeGreaterThan(0); // the set holds known-bad outputs the schema must refuse
  expect(results.every((r) => r.bodyChars > 0 && r.bodyChars <= 12_000)).toBe(true);

  const wrong = structuredClone(f.decisions.find((d) => d.kind === "triage-red" && d.expected.valid)!);
  wrong.output = wrong.output.replace(wrong.expected.answer!, wrong.expected.answer === "retry" ? "fix-round" : "retry");
  const stray = structuredClone(f.decisions.find((d) => d.kind === "decide-default" && d.expected.valid)!);
  stray.output = stray.output.replace(/\{/, '{"approved": true, ');
  const bad = runDecisionSet({ ...f, decisions: [wrong, stray] });
  expect(bad.map((r) => [r.valid, r.agrees])).toEqual([[true, false], [false, false]]);
  expect(bad[1]?.error).toBe("unknown key approved");
  const empty = { report: { readyToMerge: { agreement: 100 }, hardLimitViolations: [] }, unhandled: [], live: 0 } as unknown as Awaited<ReturnType<typeof replayDay>>;
  expect(judge(empty, bad).filter((c) => !c.pass).map((c) => c.name.split(":")[0])).toEqual(["decision cards", "decision cards"]);
});

test("the script passes on the fixture, prints the report, and exits 1 on a drifted day; no model, no network", () => {
  const script = join(import.meta.dir, "..", "eval", "coordinator-replay.eval.ts");
  const env = { ...process.env, ANTHROPIC_API_KEY: "", HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9" };
  const run = (...args: string[]) => Bun.spawnSync(["bun", "run", script, ...args], { stdout: "pipe", stderr: "pipe", env });
  const ok = run();
  expect(ok.exitCode).toBe(0);
  expect(ok.stdout.toString()).toMatch(/ready-to-merge: 100% agreement[\s\S]*mismatches: \d+[\s\S]*Decision-card quality set[\s\S]*Overall: PASS/);
  const dir = mkdtempSync(join(tmpdir(), "wissel-replay-eval-"));
  try {
    const f = loadFixture(FIXTURE_PATH);
    f.expected.readyToMerge = f.expected.readyToMerge.slice(0, 3);
    writeFileSync(join(dir, "day.json"), JSON.stringify(f));
    const drift = run(join(dir, "day.json"));
    expect(drift.exitCode).toBe(1);
    expect(drift.stdout.toString()).toMatch(/FAIL  ready-to-merge agreement 50%[\s\S]*Overall: FAIL/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
