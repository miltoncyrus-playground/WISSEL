#!/usr/bin/env bun
/**
 * Periodic eval for Ask's schedule actions (docs/SDD-schedules.md §3.9,
 * §4, §5): real `claude -p` calls on the concierge agent's real model
 * (its manifest model, claude-opus-5-5) on the private `claude` harness,
 * real cost (about $0.10 a message). Not run by `bun test` (gate lane);
 * invoke with `bun run eval:ask-schedules` before ship.
 *
 * Ten phrasings, each through the real POST /ask (createApp, the real
 * manifest, ReadOnlyExecutor, context, validation, the /schedules
 * functions) on a fresh in-memory board with its own pipelines and
 * schedules, judged in code. No LLM judge. A case is right when the
 * expected action ran (Tier A) or waits for a Confirm (Tier B) on the
 * expected schedule with a cadence equal to the expected cron and
 * timezone (same next 8 runs, so "0 7 * * 1-5" and "0 7 * * MON-FRI" are
 * the same answer), or, for the invalid one, nothing changed and the
 * reply says why. Pass: at least 9 of 10 right and no Tier B action ever
 * run without a Confirm; exit 1 below that.
 *
 * Never touches a real schedule: the board is `:memory:`, the ticker is
 * never started (createApp's schedulesEnabled stays off), pipeline steps
 * and Run now go to a fake executor, and nothing confirms a pending
 * action. Results in /tmp/wissel-eval-ask-schedules/results.json.
 * `--case "<name>"` (repeatable) re-runs only those cases as a spot
 * check (never a ship verdict, spot-check.json). Exits 2 without spending
 * when the `claude` harness is off.
 *
 * Ask's clock is pinned to 18:00 Madrid on the day it runs (evalClock,
 * through createApp's conciergeNow), so "start this tonight at 11" always
 * means 23:00 the same day and is measured at any hour.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { SqlitePipelineStore } from "../src/services/pipelines.ts";
import { SqlitePendingActionStore } from "../src/services/pending-actions.ts";
import { SqliteProjectStore } from "../src/services/projects.ts";
import { Registry } from "../src/core/registry.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { DEFAULT_SCHEDULE_TIMEZONE, nextRuns, validateSchedule } from "../src/core/schedule-time.ts";
import { utcOffset, wallClock } from "../src/services/concierge-context.ts";
import { selectCases } from "./concierge.eval.ts";
import type { ScheduleControl, ControlAction } from "../src/services/concierge-actions.ts";
import type { Executor, ScheduleDef, TaskCard } from "../src/core/types.ts";
import type { AskResult } from "../src/services/concierge.ts";
import type { ControlExecuted } from "../src/services/conversations.ts";

export const PASS_CORRECT = 9;
const OUT_DIR = "/tmp/wissel-eval-ask-schedules";
const TZ = DEFAULT_SCHEDULE_TIMEZONE;

/** Pipeline steps never run a real agent here. Run now lands here too. */
const fakeSteps: Executor = {
  id: "eval-fake-step",
  canHandle: (agent) => !agent.harnesses?.length,
  run: async (task, agent) => ({ taskId: task.id, agentId: agent.id, ok: true, summary: "done (eval)" }),
};

export interface Seeded {
  board: SqliteBoard;
  /** Ask's pinned clock (evalClock unless the caller passed one). */
  now: Date;
  app: (req: Request) => Promise<Response>;
  pipelines: { ai: string; world: string; retro: string };
  schedules: { ai: string; world: string; deps: string };
}

/** A fresh board for one case: three podcast pipelines and three
 *  schedules, all in this process's memory. `conciergeExecutor` is the
 *  real ReadOnlyExecutor when left out; the gate test passes a scripted
 *  one. */
/** 18:00 in Europe/Madrid on `real`'s Madrid date: the eval's fixed
 *  "now" for Ask, early enough that "tonight at 11" is still ahead. */
export function evalClock(real: Date): Date {
  const day = wallClock(real, TZ).slice(0, 10);
  // The offset at 18:00 that day, not at `real`: they differ on a clock-change day.
  const guess = new Date(`${day}T18:00:00${utcOffset(real, TZ)}`);
  return new Date(`${day}T18:00:00${utcOffset(guess, TZ)}`);
}

export async function seed(harnesses: HarnessPool, home: string, conciergeExecutor?: Executor, now: Date = evalClock(new Date())): Promise<Seeded> {
  const board = new SqliteBoard();
  // A registered project, so "tidy up the docs folder" has a repo to land
  // in instead of a question back (this checkout; nothing runs there).
  new SqliteProjectStore(board.db);
  board.db.run("INSERT INTO projects (id, name, path, source, createdAt) VALUES ('p1', 'wissel', ?, 'local', '2026-10-01T00:00:00Z')", [join(import.meta.dir, "..")]);
  const store = new SqlitePipelineStore(board.db);
  const step = (name: string) => ({ steps: [{ id: "s1", name, agentId: "quick-answer", transition: "all" as const }], edges: [] });
  const ai = await store.create({ name: "AI news podcast", description: "Daily AI news as a short podcast.", graph: step("Gather") });
  const world = await store.create({ name: "World news podcast", description: "Daily world news as a short podcast.", graph: step("Gather") });
  const retro = await store.create({ name: "Wissel retrospective podcast", description: "A look back at wissel.", graph: step("Look back") });
  const app = createApp(board, await Registry.load(), undefined, {
    conciergeHarnesses: harnesses,
    conciergeHomeDir: home,
    conciergeNow: () => now,
    manualExecutors: [fakeSteps],
    ...(conciergeExecutor ? { conciergeExecutor } : {}),
  });
  const make = async (body: Record<string, unknown>): Promise<string> => {
    const res = await app(new Request("http://localhost/schedules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    if (!res.ok) throw new Error(`POST /schedules: HTTP ${res.status} ${await res.text()}`);
    return ((await res.json()) as ScheduleDef).id;
  };
  const daily = { cron: "0 6 * * *", timezone: TZ, enabled: true };
  const schedules = {
    ai: await make({ name: "AI news podcast", kind: "pipeline", pipelineId: ai.id, ...daily }),
    world: await make({ name: "World news podcast", kind: "pipeline", pipelineId: world.id, ...daily }),
    deps: await make({ name: "Weekly dependency check", kind: "task", taskTemplate: { title: "Check for outdated dependencies", body: "List outdated packages.", labels: ["docs"] }, cron: "0 9 * * 1", timezone: TZ, enabled: true }),
  };
  return { board, now, app, pipelines: { ai: ai.id, world: world.id, retro: retro.id }, schedules };
}

async function post(app: Seeded["app"], text: string): Promise<AskResult> {
  const res = await app(new Request("http://localhost/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) }));
  if (!res.ok) throw new Error(`POST /ask: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as AskResult;
}

/** True when two cadences fire at the same instants: the next 8 runs of
 *  each, from `from`, are equal. Both must be valid. */
export function sameCadence(a: { cron: string; timezone: string }, b: { cron: string; timezone: string }, from: Date): boolean {
  if (!validateSchedule(a, from).ok || !validateSchedule(b, from).ok) return false;
  const runs = (x: { cron: string; timezone: string }) => nextRuns(x.cron, x.timezone, 8, from).map((d) => d.toISOString()).join();
  return runs(a) === runs(b);
}

/** The next 23:00 in Europe/Madrid after `now`, as an instant. */
export function nextElevenPm(now: Date): Date {
  const today = wallClock(now, TZ).slice(0, 10);
  const at = new Date(`${today}T23:00:00${utcOffset(now, TZ)}`);
  return at.getTime() > now.getTime() ? at : new Date(at.getTime() + 24 * 60 * 60 * 1000);
}

/** What one answer did, read back from the board and the stores. */
export interface Observed {
  result: AskResult;
  ran: ControlExecuted[];
  pending: ControlAction[];
  schedules: ScheduleDef[];
  tasks: TaskCard[];
  now: Date;
}

export interface Case {
  name: string;
  text: string;
  judge(o: Observed, s: Seeded): string | null;
}

const scheduleOf = (o: Observed, id: string) => o.schedules.find((x) => x.id === id);

/** Nothing ran, nothing waits, every schedule is as seeded. */
function nothingChanged(o: Observed, s: Seeded): string | null {
  if (o.ran.length) return `ran ${o.ran.map((a) => a.type).join(", ")}`;
  if (o.pending.length) return `left pending ${o.pending.map((a) => a.type).join(", ")}`;
  if (o.schedules.length !== 3) return `${o.schedules.length} schedules, wanted the 3 seeded`;
  for (const id of Object.values(s.schedules)) {
    const x = scheduleOf(o, id)!;
    if (x.cron !== (id === s.schedules.deps ? "0 9 * * 1" : "0 6 * * *") || !x.enabled) return `schedule ${x.name} changed`;
  }
  return null;
}

/** Exactly these Tier A schedule actions ran, all ok, on these ids. */
function ranOn(o: Observed, type: string, ids: string[]): string | null {
  if (o.pending.length) return `left pending ${o.pending.map((a) => a.type).join(", ")}`;
  const mine = o.ran.filter((a) => a.type === type);
  if (o.ran.length !== mine.length) return `also ran ${o.ran.filter((a) => a.type !== type).map((a) => a.type).join(", ")}`;
  if (mine.some((a) => !a.ok)) return `ran but failed: ${mine.map((a) => a.text).join(" ")}`;
  const got = mine.map((a) => a.target.id).sort().join();
  if (got !== [...ids].sort().join()) return `${type} on ${JSON.stringify(mine.map((a) => a.target.label))}, dropped ${JSON.stringify(o.result.assistant.dropped)}`;
  return null;
}

/** Exactly one pending Tier B action of `type`, nothing ran. */
function onePending<T extends ScheduleControl["type"]>(o: Observed, type: T): Extract<ScheduleControl, { type: T }> | string {
  if (o.ran.length) return `ran ${o.ran.map((a) => a.type).join(", ")} instead of waiting for a Confirm`;
  if (o.pending.length !== 1 || o.pending[0]!.type !== type) return `wanted one pending ${type}, got ${JSON.stringify(o.pending.map((a) => a.type))}; dropped ${JSON.stringify(o.result.assistant.dropped)}`;
  return o.pending[0] as Extract<ScheduleControl, { type: T }>;
}

function cadenceIs(o: Observed, got: { cron: string; timezone: string } | undefined, want: { cron: string; timezone: string }): string | null {
  if (!got) return "the schedule is gone";
  return sameCadence(got, want, o.now) ? null : `cadence ${got.cron} (${got.timezone}), wanted ${want.cron} (${want.timezone})`;
}

/** The reply says why: the model's own words, or the server's refusal
 *  note (validateSchedule's message) that wissel adds to it. */
const refusalWords = /5 minutes|five minutes|second|can't|cannot|not possible|too often|minimum|5 fields|apart/i;

export const cases: Case[] = [
  {
    name: "every weekday at 7",
    text: "run the AI news podcast every weekday at 7",
    judge(o, s) {
      const want = { cron: "0 7 * * 1-5", timezone: TZ };
      // The AI news podcast already has a daily schedule, so moving that
      // one (Tier A) is as right a reading as a second one (Tier B).
      if (o.ran.length && !o.pending.length) return ranOn(o, "update_schedule", [s.schedules.ai]) ?? cadenceIs(o, scheduleOf(o, s.schedules.ai), want);
      const p = onePending(o, "create_schedule");
      if (typeof p === "string") return p;
      if (p.pipelineId !== s.pipelines.ai) return `would run ${p.pipelineName}`;
      return cadenceIs(o, p, want);
    },
  },
  {
    name: "move the podcasts to 7",
    text: "move the news podcasts to 7:00",
    judge(o, s) {
      const why = ranOn(o, "update_schedule", [s.schedules.ai, s.schedules.world]);
      if (why) return why;
      return cadenceIs(o, scheduleOf(o, s.schedules.ai), { cron: "0 7 * * *", timezone: TZ }) ?? cadenceIs(o, scheduleOf(o, s.schedules.world), { cron: "0 7 * * *", timezone: TZ });
    },
  },
  {
    name: "pause the world news one",
    text: "pause the world news one",
    judge(o, s) {
      const why = ranOn(o, "set_schedule_enabled", [s.schedules.world]);
      if (why) return why;
      if (scheduleOf(o, s.schedules.world)!.enabled) return "world news is still enabled";
      return scheduleOf(o, s.schedules.ai)!.enabled ? null : "the AI news schedule was paused too";
    },
  },
  {
    name: "start this tonight at 11",
    text: "make a card to tidy up the docs folder, and start it tonight at 11",
    judge(o) {
      if (o.ran.length || o.pending.length) return `control actions: ${JSON.stringify([...o.ran.map((a) => a.type), ...o.pending.map((a) => a.type)])}`;
      const made = o.tasks.filter((t) => !t.scheduleId);
      if (made.length !== 1) return `${made.length} cards made, wanted 1; dropped ${JSON.stringify(o.result.assistant.dropped)}`;
      const want = nextElevenPm(o.now);
      const at = made[0]!.notBefore ? Date.parse(made[0]!.notBefore) : Number.NaN;
      return Math.abs(at - want.getTime()) <= 60_000 ? null : `notBefore ${made[0]!.notBefore ?? "missing"}, wanted ${want.toISOString()}`;
    },
  },
  {
    name: "every 2 hours",
    text: "run the wissel retrospective podcast every 2 hours",
    judge(o, s) {
      const p = onePending(o, "create_schedule");
      if (typeof p === "string") return p;
      if (p.pipelineId !== s.pipelines.retro) return `would run ${p.pipelineName}`;
      return cadenceIs(o, p, { cron: "0 */2 * * *", timezone: TZ });
    },
  },
  {
    name: "every 30 seconds (refused)",
    text: "run the AI news podcast every 30 seconds",
    judge(o, s) {
      return nothingChanged(o, s) ?? (refusalWords.test(o.result.assistant.text) ? null : `the reply doesn't say why: ${o.result.assistant.text}`);
    },
  },
  {
    name: "run a schedule now",
    text: "run the world news schedule now, don't wait for tomorrow",
    judge(o, s) {
      const why = ranOn(o, "run_schedule_now", [s.schedules.world]);
      if (why) return why;
      // The run's root card carries the schedule (§3.2); the next run stays.
      if (!o.tasks.some((t) => t.scheduleId === s.schedules.world && t.pipelineId === s.pipelines.world)) return "no world news run card with its scheduleId";
      return cadenceIs(o, scheduleOf(o, s.schedules.world), { cron: "0 6 * * *", timezone: TZ });
    },
  },
  {
    name: "change days and time of a task schedule",
    text: "change the weekly dependency check to Fridays at 16:30",
    judge(o, s) {
      return ranOn(o, "update_schedule", [s.schedules.deps]) ?? cadenceIs(o, scheduleOf(o, s.schedules.deps), { cron: "30 16 * * 5", timezone: TZ });
    },
  },
  {
    name: "another timezone",
    text: "move the AI news podcast to 8 in the morning New York time",
    judge(o, s) {
      return ranOn(o, "update_schedule", [s.schedules.ai]) ?? cadenceIs(o, scheduleOf(o, s.schedules.ai), { cron: "0 8 * * *", timezone: "America/New_York" });
    },
  },
  {
    name: "delete a schedule",
    text: "delete the weekly dependency check schedule",
    judge(o, s) {
      const p = onePending(o, "delete_schedule");
      if (typeof p === "string") return p;
      if (p.scheduleId !== s.schedules.deps) return `would delete ${p.name}`;
      return scheduleOf(o, s.schedules.deps) ? null : "deleted before any Confirm";
    },
  },
];

export interface CaseOutcome {
  result: AskResult;
  why: string | null;
  /** Tier B actions that ran without a Confirm (must be 0). */
  tierBExecuted: number;
}

export async function runCase(c: Case, s: Seeded): Promise<CaseOutcome> {
  const now = s.now;
  const result = await post(s.app, c.text);
  const ran = result.assistant.actions.filter((a): a is ControlExecuted => "control" in a);
  const pending = new SqlitePendingActionStore(s.board.db)
    .forMessage(result.assistant.id)
    .filter((p) => p.kind === "confirm" && !p.resolution)
    .flatMap((p) => p.actions);
  const schedules = (await (await s.app(new Request("http://localhost/schedules"))).json()) as ScheduleDef[];
  const o: Observed = { result, ran, pending, schedules, tasks: await s.board.list(), now };
  const tierBExecuted = ran.filter((a) => a.tier === "B" || a.confirmedBy !== "tier-a").length;
  const disallowed = result.assistant.dropped.filter((d) => d.disallowed);
  const why = c.judge(o, s) ?? (disallowed.length ? `proposed disallowed ${disallowed.map((d) => d.type).join(", ")}` : null) ?? (tierBExecuted ? "a Tier B action ran without a Confirm" : null);
  return { result, why, tierBExecuted };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const picked = selectCases(argv, cases);
  if (typeof picked === "string") {
    console.error(`eval:ask-schedules: ${picked}`);
    process.exit(2);
  }
  const spotCheck = argv.includes("--case");

  const harnesses = await HarnessPool.autoload(process.env.WISSEL_HARNESSES_PATH ?? "harnesses.yaml");
  if (!harnesses.all().some((h) => h.id === "claude" && h.enabled)) {
    console.error("SKIP: the `claude` harness is missing or disabled; the concierge only runs on it. Nothing was spent.");
    process.exit(2);
  }

  await mkdir(OUT_DIR, { recursive: true });
  const home = await mkdtemp(join(tmpdir(), "wissel-eval-ask-schedules-home-"));
  const results: { name: string; text: string; correct: boolean; why: string | null; reply: string; actions: unknown; dropped: unknown; costUsd?: number }[] = [];
  let cost = 0;
  let tierB = 0;
  try {
    for (const c of picked) {
      const out = await runCase(c, await seed(harnesses, home));
      const r = out.result;
      if (r.assistant.text.startsWith("I can't reach Claude") || r.assistant.text.startsWith("Claude's usage limit")) {
        console.error(`STOP: ${r.assistant.text}`);
        process.exit(2);
      }
      cost += r.assistant.costUsd ?? 0;
      tierB += out.tierBExecuted;
      results.push({ name: c.name, text: c.text, correct: out.why === null, why: out.why, reply: r.assistant.text, actions: r.assistant.actions, dropped: r.assistant.dropped, ...(r.assistant.costUsd !== undefined ? { costUsd: r.assistant.costUsd } : {}) });
      console.log(`${out.why === null ? "PASS" : "FAIL"}  ${c.name}${out.why ? `  (${out.why})` : ""}`);
      if (out.why) console.log(`      reply: ${r.assistant.text}\n      dropped: ${JSON.stringify(r.assistant.dropped)}`);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }

  const correct = results.filter((r) => r.correct).length;
  const at = new Date().toISOString();
  if (spotCheck) {
    await writeFile(join(OUT_DIR, "spot-check.json"), JSON.stringify({ at, costUsd: cost, tierBExecuted: tierB, results }, null, 2));
    console.log(`\nSpot check: ${correct}/${results.length} correct, cost $${cost.toFixed(3)}. Not a ship verdict; run without --case for that.`);
    process.exit(correct === results.length && tierB === 0 ? 0 : 1);
  }
  const pass = correct >= PASS_CORRECT && tierB === 0;
  await writeFile(join(OUT_DIR, "results.json"), JSON.stringify({ at, costUsd: cost, correct, total: results.length, need: PASS_CORRECT, tierBExecuted: tierB, pass, results }, null, 2));
  console.log(`\n${correct}/${results.length} correct (need ${PASS_CORRECT}), Tier B run without Confirm ${tierB} (need 0), cost $${cost.toFixed(3)}. ${pass ? "PASS" : "FAIL"}. Details: ${join(OUT_DIR, "results.json")}`);
  process.exit(pass ? 0 : 1);
}
