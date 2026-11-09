#!/usr/bin/env bun
/**
 * Replay eval for the coordinator (docs/SDD-coordinator.md §8, eval lane):
 * one recorded day of card events, PR events and channel entries runs
 * through the inbox, the policy gate and the executor in Shadow, then
 * through shadowReport against what the pilot's coordinator did. Prints
 * the ready-to-merge agreement (target at least 95%), the would-be
 * hard-limit violations (target 0) and every mismatch with its reason;
 * then the decision-card quality set: a fixed list of open questions and
 * red gates with known good answers, reporting schema validity and
 * agreement. Exits 1 below either target.
 *
 * THE FIXTURE IS SYNTHETIC. The recorded pilot day is not in the repo;
 * eval/fixtures/replay-day.json is made up in its shape, names removed,
 * so this measures the plumbing (idempotent inbox, every rule of the
 * gate running in Shadow, the report's matching) and pins the targets
 * until a real day is recorded and dropped in its place. The decision
 * set's outputs are scripted stand-ins for model output: offline, no
 * model call, zero spend. Red gates and open questions that would open a
 * decision card in live are listed as skipped, not simulated.
 *
 * The event-to-action table below is this eval's own (the server wires
 * no deterministic inbox handlers yet); it follows §4.1 and §4.3.
 */
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChannelEntry } from "../src/services/channel.ts";
import { CoordinatorExecutor, SqliteOutboundQueue, gateContextFor, type ExecutableAction } from "../src/services/coordinator-executor.ts";
import { parseDecisionOutput, renderDecisionCard, validateDecisionOutput, type DecisionCardKind, type DecisionOutput } from "../src/services/decision-cards.ts";
import type { PullRequest } from "../src/services/github-status.ts";
import { InboxDispatcher, SqliteInbox, type InboxEvent, type InboxHandler, type NewInboxEvent } from "../src/services/inbox.ts";
import { DEFAULT_HARD_LIMITS, PolicyGate, SqliteGateLog, type HardLimits } from "../src/services/policy-gate.ts";
import { shadowReport, type ShadowReport } from "../src/services/shadow-report.ts";
import type { Workstream } from "../src/services/workstreams.ts";

export const FIXTURE_PATH = join(import.meta.dir, "fixtures", "replay-day.json");
export const TARGETS = { readyToMergeAgreement: 95, hardLimitViolations: 0, decisionAgreement: 95 };

export interface DecisionCase {
  name: string;
  kind: DecisionCardKind;
  event: NewInboxEvent;
  /** The card's output as recorded (here: scripted). */
  output: string;
  /** The known good answer: whether the schema must accept it and, if so, the verdict (triage-red), the lean (decide-default) or the card keys (plan-batch). */
  expected: { valid: boolean; answer?: string };
}
export interface ReplayFixture {
  note: string;
  workstream: { id: string; projectId: string; mainBranch: string; channel: string };
  limits?: Partial<HardLimits>;
  events: NewInboxEvent[];
  external: { channel: Pick<ChannelEntry, "ref" | "at" | "message">[]; prs: PullRequest[] };
  /** What the pilot's coordinator posted ready-to-merge. */
  expected: { readyToMerge: { card: string; headSha: string }[] };
  decisions: DecisionCase[];
}
export interface ReplayResult {
  report: ShadowReport;
  /** Events the inbox saw a second time and handled once. */
  duplicates: number;
  /** Actions that would need a decision card (a model call), with the event. */
  skipped: string[];
  /** Dispatcher warnings: events with no handler, or a handler that threw. */
  unhandled: string[];
  /** Outcomes other than "would": always 0 in Shadow. */
  live: number;
}
export interface DecisionResult { name: string; kind: DecisionCardKind; valid: boolean; error?: string; schemaAgrees: boolean; answer?: string; agrees: boolean; bodyChars: number }
export interface Check { name: string; pass: boolean }

export const loadFixture = (path: string): ReplayFixture => JSON.parse(readFileSync(path, "utf8")) as ReplayFixture;
const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const workstreamOf = (f: ReplayFixture): Workstream => ({
  id: f.workstream.id, name: "replay", createdAt: "2026-11-02T00:00:00Z", channel: { adapter: "log", target: f.workstream.channel },
  projects: [{ projectId: f.workstream.projectId, role: "shadow", decideAlone: [], mustAsk: [], never: [] }],
});

/** §4.1's dispatcher table for the replay: the deterministic kinds act; channel entries are inputs; red gates and questions open decision cards (skipped). */
function handlerTable(f: ReplayFixture, run: (a: Partial<ExecutableAction> & { kind: string }) => Promise<void>, skipped: string[]): Record<string, InboxHandler> {
  const noop: InboxHandler = () => {};
  const skip = (e: InboxEvent, why: string): void => void skipped.push(`${e.id}: ${why}`);
  return {
    "card.review": (e) => { const p = rec(e.payload); return run({ kind: "channel.post", post: "ready-to-merge", payload: { about: { card: str(p.key) }, headSha: p.headSha, pr: p.pr } }); },
    "card.escalated": (e) => { const p = rec(e.payload); return run({ kind: "channel.post", post: "status", payload: { about: { card: str(p.key) }, text: `${str(p.key)} escalated; needs a human` } }); },
    "card.failed": (e) => skip(e, "red after the retry opens a triage-red decision card (a model call, not replayed)"),
    "pr.checks": (e) => {
      const p = rec(e.payload);
      if (p.checks !== "passing") return skip(e, `checks ${String(p.checks)} on PR #${String(p.pr)}: ${p.checks === "failing" ? "opens a triage-red decision card (a model call, not replayed)" : "nothing to arm yet"}`);
      return run({ kind: "pr.arm", base: str(p.base) ?? f.workstream.mainBranch, checks: "green", payload: { pr: p.pr, sha: p.sha } });
    },
    "pr.dirty": (e) => { const p = rec(e.payload); return run({ kind: "pr.merge-forward", payload: { pr: p.pr, card: str(p.key) } }); },
    "pr.merged": (e) => { const p = rec(e.payload); return run({ kind: "channel.post", post: "release", payload: { about: { card: str(p.key) }, item: str(p.key), reason: "merged" } }); },
    "channel.claim": noop, "channel.release": noop, "channel.ready-to-merge": noop, "channel.answer": noop, "channel.decision": noop, "channel.status": noop, "channel.handover": noop,
  };
}

/** The day through inbox, gate and executor in Shadow, then the shadow report. In-memory database, nothing outward. */
export async function replayDay(f: ReplayFixture): Promise<ReplayResult> {
  const db = new Database(":memory:");
  const ws = workstreamOf(f);
  const limits: HardLimits = { ...DEFAULT_HARD_LIMITS, ...f.limits };
  const queue = new SqliteOutboundQueue(db);
  const executor = new CoordinatorExecutor({
    gate: new PolicyGate(new SqliteGateLog(db)), queue, handlers: {},
    context: async (a) => gateContextFor(ws, a.projectId, { limits, mainBranch: f.workstream.mainBranch, shadow: true }),
    quietHours: async () => undefined,
  });
  const result: ReplayResult = { report: undefined as unknown as ShadowReport, duplicates: 0, skipped: [], unhandled: [], live: 0 };
  const run = async (a: Partial<ExecutableAction> & { kind: string }): Promise<void> => {
    const outcome = await executor.execute({ workstreamId: ws.id, projectId: f.workstream.projectId, ...a });
    if (outcome.outcome !== "would") result.live++;
  };
  const dispatcher = new InboxDispatcher({
    inbox: new SqliteInbox(db), handlers: handlerTable(f, run, result.skipped), decisionKinds: ["channel.question"],
    openDecisionCard: (e) => void result.skipped.push(`${e.id}: an open question opens a decide-default decision card (a model call, not replayed)`),
    logger: { warn: (m) => void result.unhandled.push(m) },
  });
  for (const e of f.events) if ((await dispatcher.ingest(e)).duplicate) result.duplicates++;
  const channel: ChannelEntry[] = [
    ...f.external.channel.map((c) => ({ ...c, workstreamId: ws.id, untrusted: true as const })),
    ...f.expected.readyToMerge.map((r, i) => ({ ref: `rtm-${i}`, at: "2026-11-02T12:00:00Z", workstreamId: ws.id, untrusted: true as const, message: { kind: "ready-to-merge" as const, from: "pilot-coordinator", about: { card: r.card }, headSha: r.headSha } })),
  ];
  result.report = shadowReport(ws.id, queue.list(ws.id, "would"), { channel, prs: f.external.prs });
  return result;
}

const answerOf = (kind: DecisionCardKind, o: DecisionOutput): string | undefined =>
  kind === "triage-red" ? (o as { verdict: string }).verdict : kind === "decide-default" ? (o as { lean: string }).lean : kind === "plan-batch" ? (o as { cards: { key: string }[] }).cards.map((c) => c.key).join(",") : undefined;

/** Each case: the card renders (fenced when untrusted), the recorded output is parsed and schema-checked, and the answer is compared with the known good one. */
export function runDecisionSet(f: ReplayFixture): DecisionResult[] {
  const inbox = new SqliteInbox(new Database(":memory:"));
  return f.decisions.map((c, i) => {
    const event = inbox.receive({ ...c.event, id: `${c.event.id}#${i}` }) ?? (() => { throw new Error(`decision case ${c.name}: event not stored`); })();
    const body = renderDecisionCard(c.kind, event, { projectId: f.workstream.projectId, role: "shadow" }, "replay00").body;
    const parsed = parseDecisionOutput(c.output);
    const check = parsed === undefined ? { ok: false as const, error: "output is not JSON" } : validateDecisionOutput(c.kind, parsed);
    const answer = check.ok ? answerOf(c.kind, check.output) : undefined;
    const agrees = c.expected.valid ? check.ok && answer === c.expected.answer : !check.ok;
    return { name: c.name, kind: c.kind, valid: check.ok, ...(check.ok ? {} : { error: check.error }), schemaAgrees: check.ok === c.expected.valid, ...(answer === undefined ? {} : { answer }), agrees, bodyChars: body.length };
  });
}

export function judge(r: ReplayResult, decisions: DecisionResult[]): Check[] {
  const rtm = r.report.readyToMerge.agreement;
  const schemaOk = decisions.filter((d) => d.schemaAgrees).length;
  const agreement = decisions.length ? Math.round((decisions.filter((d) => d.agrees).length / decisions.length) * 100) : 100;
  return [
    { name: `ready-to-merge agreement ${rtm}% (target at least ${TARGETS.readyToMergeAgreement}%)`, pass: rtm >= TARGETS.readyToMergeAgreement },
    { name: `would-be hard-limit violations: ${r.report.hardLimitViolations.length} (target ${TARGETS.hardLimitViolations})`, pass: r.report.hardLimitViolations.length <= TARGETS.hardLimitViolations },
    { name: `shadow acted on nothing and left nothing unhandled (live ${r.live}, unhandled ${r.unhandled.length})`, pass: r.live === 0 && r.unhandled.length === 0 },
    { name: `decision cards: schema verdict as expected on ${schemaOk}/${decisions.length}`, pass: schemaOk === decisions.length },
    { name: `decision cards: agreement ${agreement}% (target at least ${TARGETS.decisionAgreement}%)`, pass: agreement >= TARGETS.decisionAgreement },
  ];
}

if (import.meta.main) {
  const f = loadFixture(process.argv[2] ?? FIXTURE_PATH);
  console.log(`Fixture: ${process.argv[2] ?? FIXTURE_PATH}\n  ${f.note.split(".")[0]}.\n  ${f.events.length} events, ${f.external.channel.length} external channel entries, ${f.external.prs.length} PRs, ${f.decisions.length} decision cases`);
  const r = await replayDay(f);
  const { readyToMerge: rtm, hardLimitViolations, matched, unmatched } = r.report;
  console.log(`\nReplay in Shadow: ${r.report.would} would-entries, ${r.duplicates} duplicate events handled once, ${r.skipped.length} skipped (decision cards), ${matched.length} matched`);
  console.log(`  ready-to-merge: ${rtm.agreement}% agreement; both ${rtm.both.length}, wissel only ${rtm.wisselOnly.length} [${rtm.wisselOnly.map((s) => s.slice(0, 8)).join(", ")}], pilot only ${rtm.externalOnly.length} [${rtm.externalOnly.map((s) => s.slice(0, 8)).join(", ")}]`);
  console.log(`  would-be hard-limit violations: ${hardLimitViolations.length}`);
  for (const v of hardLimitViolations) console.log(`    ${v.action.kind} ${JSON.stringify({ base: v.action.base, repo: v.action.repo, targets: v.action.targets, payload: v.action.payload })}`);
  console.log(`  mismatches: ${unmatched.length}`);
  for (const u of unmatched) console.log(`    ${u.side.padEnd(8)} ${u.kind.padEnd(24)} ${u.ref.slice(0, 8)}  ${u.reason}`);
  for (const s of r.skipped) console.log(`  skipped  ${s}`);
  for (const u of r.unhandled) console.log(`  UNHANDLED  ${u}`);
  const decisions = runDecisionSet(f);
  console.log("\nDecision-card quality set:");
  for (const d of decisions) console.log(`  ${d.agrees && d.schemaAgrees ? "ok  " : "MISS"} ${d.kind.padEnd(14)} ${d.name.padEnd(52)} ${d.valid ? `answer ${d.answer}` : `refused: ${d.error}`}`);
  const checks = judge(r, decisions);
  console.log("");
  for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}`);
  const pass = checks.every((c) => c.pass);
  console.log(`Overall: ${pass ? "PASS" : "FAIL"} (synthetic fixture; no model call, $0)`);
  if (!pass) process.exit(1);
}
