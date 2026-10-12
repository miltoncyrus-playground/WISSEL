import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { SqlitePipelineStore } from "../src/services/pipelines.ts";
import { Registry } from "../src/core/registry.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { ReadOnlyExecutor } from "../src/executors/readonly.ts";
import { DEFAULT_SCHEDULE_TIMEZONE } from "../src/core/schedule-time.ts";
import { ACTION_TIERS, SCHEDULE_ACTION_TYPES, resolveSchedule, validateActions, type ActionContext, type ContextSchedule } from "../src/services/concierge-actions.ts";
import { buildConciergeContext, conciergeData, utcOffset, wallClock } from "../src/services/concierge-context.ts";
import type { ScheduleView } from "../src/services/board-actions.ts";
import type { CommandRunner } from "../src/executors/claude-cli.ts";
import type { Executor } from "../src/core/types.ts";
import type { ChatMessage, Conversation, ControlExecuted, PendingView } from "../src/services/conversations.ts";

// docs/SDD-schedules.md §3.9 and §4: Ask's schedule actions and
// create_task's notBefore. The model proposes; validateSchedule and
// validateNotBefore decide, with their own words. Tier A runs at once
// through the /schedules routes' own functions; Tier B waits for the tap.

// ---------- validation, pure ----------

const NOW = new Date("2026-10-12T10:00:00.000Z");
const AI: ContextSchedule = { id: "aaaaaaaa-0000-4000-8000-000000000001", name: "AI news podcast", kind: "pipeline", pipelineId: "p-ai", cron: "0 6 * * *", timezone: "Europe/Madrid", enabled: true };
const WORLD: ContextSchedule = { id: "bbbbbbbb-0000-4000-8000-000000000002", name: "World news podcast", kind: "pipeline", pipelineId: "p-world", cron: "0 6 * * *", timezone: "Europe/Madrid", enabled: false };
const DEPS: ContextSchedule = { id: "cccccccc-0000-4000-8000-000000000003", name: "Check dependencies", kind: "task", cron: "0 9 * * 1", timezone: "Europe/Madrid", enabled: true };

function ctx(over: Partial<ActionContext> = {}): ActionContext {
  return {
    projects: [{ name: "wissel", path: "/r/wissel" }],
    pipelines: [
      { id: "p-ai", name: "AI news podcast" },
      { id: "p-world", name: "World news podcast" },
      { id: "p-review", name: "Implement and review" },
    ],
    knownLabels: ["code", "docs"],
    taskIds: [],
    repoRequiredBy: (labels) => (labels.includes("code") ? "implementer" : undefined),
    pipelineNeedsRepo: (id) => id === "p-review",
    tasks: [],
    schedules: [AI, WORLD, DEPS],
    now: NOW,
    ...over,
  };
}

const one = (raw: Record<string, unknown>, c = ctx()) => validateActions([raw], c);

describe("the schedule actions' tiers (§3.9)", () => {
  test("create and delete wait for a Confirm; update, enable and run now run at once", () => {
    expect(Object.fromEntries(SCHEDULE_ACTION_TYPES.map((t) => [t, ACTION_TIERS[t]]))).toEqual({
      create_schedule: "B",
      update_schedule: "A",
      set_schedule_enabled: "A",
      run_schedule_now: "A",
      delete_schedule: "B",
    });
  });
});

describe("update_schedule", () => {
  test("a new cron by id is kept as the model gave it, resolved to the schedule", () => {
    expect(one({ type: "update_schedule", schedule: AI.id, cron: "0 7 * * *" })).toEqual({
      valid: [{ type: "update_schedule", tier: "A", scheduleId: AI.id, name: "AI news podcast", cron: "0 7 * * *" }],
      dropped: [],
    });
  });

  test("an id8, the exact name, or whole words of the name all name it", () => {
    for (const ref of [AI.id.slice(0, 8), "ai news podcast", "world news"]) {
      const { valid } = one({ type: "update_schedule", schedule: ref, cron: "0 7 * * *" });
      expect(valid).toHaveLength(1);
    }
    expect(resolveSchedule("news", [AI, WORLD])).toMatchObject({ ok: false, reason: "ambiguous" });
  });

  test("a bad cron is refused with validateSchedule's own message, never repaired", () => {
    const six = one({ type: "update_schedule", schedule: AI.id, cron: "0 0 7 * * *" });
    expect(six.valid).toEqual([]);
    expect(six.dropped[0]!.reason).toBe('cron must have exactly 5 fields (minute hour day-of-month month day-of-week), "0 0 7 * * *" has 6');
    expect(six.dropped[0]!.text).toBe(`Did not change schedule 'AI news podcast': ${six.dropped[0]!.reason}.`);
    expect(one({ type: "update_schedule", schedule: AI.id, cron: "every morning" }).dropped[0]!.reason).toContain("cron must have exactly 5 fields");
    expect(one({ type: "update_schedule", schedule: AI.id, cron: "99 7 * * *" }).dropped[0]!.reason).toStartWith('cron "99 7 * * *" is not valid');
  });

  test("a bad timezone is refused", () => {
    const r = one({ type: "update_schedule", schedule: AI.id, timezone: "Mars/Olympus" });
    expect(r.valid).toEqual([]);
    expect(r.dropped[0]!.reason).toBe('unknown timezone "Mars/Olympus", use an IANA name like Europe/Madrid');
  });

  test("runs under 5 minutes apart are refused", () => {
    const r = one({ type: "update_schedule", schedule: AI.id, cron: "*/2 * * * *" });
    expect(r.dropped[0]!.reason).toBe('runs must be at least 5 minutes apart; "*/2 * * * *" runs 2 minutes apart');
    expect(one({ type: "update_schedule", schedule: AI.id, cron: "*/5 * * * *" }).valid).toHaveLength(1);
  });

  test("an unknown or ambiguous schedule is a question, not an action", () => {
    const none = one({ type: "update_schedule", schedule: "dddddddd-9999", cron: "0 7 * * *" });
    expect(none.valid).toEqual([]);
    expect(none.dropped[0]!.question).toBe('Which schedule should I change? No schedule matches "dddddddd-9999".');
    const both = one({ type: "update_schedule", schedule: "news podcast", cron: "0 7 * * *" });
    expect(both.dropped[0]!.question).toBe("Which schedule should I change: 'AI news podcast' or 'World news podcast'?");
    expect(one({ type: "update_schedule", cron: "0 7 * * *" }).dropped[0]!.question).toBe("Which schedule should I change?");
  });

  test("nothing to change, the same cadence, or an input on a task schedule is refused", () => {
    expect(one({ type: "update_schedule", schedule: AI.id }).dropped[0]!.reason).toBe("say what to change: cron, timezone or input");
    expect(one({ type: "update_schedule", schedule: AI.id, cron: "0 6 * * *", timezone: "Europe/Madrid" }).dropped[0]!.reason).toBe("it already runs every day at 06:00 (Europe/Madrid)");
    expect(one({ type: "update_schedule", schedule: DEPS.id, input: "x" }).dropped[0]!.reason).toBe("only a pipeline schedule takes an input");
  });

  test("one update per podcast: two actions on two schedules both pass", () => {
    const r = validateActions(
      [
        { type: "update_schedule", schedule: AI.id, cron: "0 7 * * *" },
        { type: "update_schedule", schedule: WORLD.id, cron: "0 7 * * *" },
      ],
      ctx(),
    );
    expect(r.valid.map((a) => ("scheduleId" in a ? a.scheduleId : ""))).toEqual([AI.id, WORLD.id]);
  });

  test("a timezone change alone is checked against the schedule's own cron", () => {
    expect(one({ type: "update_schedule", schedule: AI.id, timezone: "America/New_York" }).valid).toEqual([
      { type: "update_schedule", tier: "A", scheduleId: AI.id, name: "AI news podcast", timezone: "America/New_York" },
    ]);
  });
});

describe("set_schedule_enabled, run_schedule_now, delete_schedule", () => {
  test("pause an enabled one; turning on an enabled one is refused in plain words", () => {
    expect(one({ type: "set_schedule_enabled", schedule: "AI news podcast", enabled: false }).valid).toEqual([
      { type: "set_schedule_enabled", tier: "A", scheduleId: AI.id, name: "AI news podcast", enabled: false },
    ]);
    const already = one({ type: "set_schedule_enabled", schedule: AI.id, enabled: true });
    expect(already.dropped[0]!.text).toBe("Did not turn on schedule 'AI news podcast': it is already on.");
    expect(one({ type: "set_schedule_enabled", schedule: AI.id, enabled: "no" }).dropped[0]!.reason).toBe("say enabled: true or false");
  });

  test("run now and delete need only the schedule", () => {
    expect(one({ type: "run_schedule_now", schedule: WORLD.id }).valid).toEqual([{ type: "run_schedule_now", tier: "A", scheduleId: WORLD.id, name: "World news podcast" }]);
    expect(one({ type: "delete_schedule", schedule: DEPS.id }).valid).toEqual([{ type: "delete_schedule", tier: "B", scheduleId: DEPS.id, name: "Check dependencies" }]);
    expect(one({ type: "delete_schedule", schedule: "nothing like it" }).dropped[0]!.question).toBe('Which schedule should I delete? No schedule matches "nothing like it".');
  });

  test("without board controls every schedule action is dropped with the reason", () => {
    expect(one({ type: "run_schedule_now", schedule: WORLD.id }, ctx({ controlsEnabled: false })).dropped[0]!.reason).toBe("board controls are not set up on this server; use the board");
  });
});

describe("create_schedule", () => {
  test("a pipeline by name, with cron and timezone as given, named after it and its cadence", () => {
    expect(one({ type: "create_schedule", pipeline: "ai news podcast", cron: "0 7 * * 1-5", timezone: "Europe/Madrid" }).valid).toEqual([
      { type: "create_schedule", tier: "B", name: "AI news podcast, weekdays at 07:00", kind: "pipeline", pipelineId: "p-ai", pipelineName: "AI news podcast", cron: "0 7 * * 1-5", timezone: "Europe/Madrid" },
    ]);
  });

  test("a card template meets create_task's checks", () => {
    expect(one({ type: "create_schedule", task: { title: "Check deps", body: "b", labels: ["docs"] }, cron: "0 9 * * 1", timezone: "Europe/Madrid", name: "Deps" }).valid).toEqual([
      { type: "create_schedule", tier: "B", name: "Deps", kind: "task", taskTemplate: { title: "Check deps", body: "b", labels: ["docs"] }, cron: "0 9 * * 1", timezone: "Europe/Madrid" },
    ]);
    expect(one({ type: "create_schedule", task: { title: "Fix it", labels: ["code"] }, cron: "0 9 * * 1", timezone: "Europe/Madrid" }).dropped[0]!.reason).toBe(
      "the card it makes: it would go to implementer, which needs a repo, and none was given",
    );
  });

  test("no timezone, a bad cron, an unknown pipeline, a repo-needing pipeline or no target is refused", () => {
    const reason = (raw: Record<string, unknown>) => one({ type: "create_schedule", ...raw }).dropped[0]?.reason;
    expect(reason({ pipeline: "AI news podcast", cron: "0 7 * * *" })).toBe("say the timezone, an IANA name like Europe/Madrid");
    expect(reason({ pipeline: "AI news podcast", cron: "*/30 * * * * *", timezone: "Europe/Madrid" })).toContain("has 6");
    expect(reason({ pipeline: "AI news podcast", cron: "* * * * *", timezone: "Europe/Madrid" })).toBe('runs must be at least 5 minutes apart; "* * * * *" runs 1 minute apart');
    expect(reason({ pipeline: "Nope", cron: "0 7 * * *", timezone: "Europe/Madrid" })).toBe('there is no pipeline called "Nope"');
    expect(reason({ pipeline: "Implement and review", cron: "0 7 * * *", timezone: "Europe/Madrid" })).toBe('"Implement and review" needs a repo; schedule it from the board');
    expect(reason({ cron: "0 7 * * *", timezone: "Europe/Madrid" })).toBe('say what it runs: "pipeline" (a pipeline name) or "task" (a card)');
  });
});

describe("create_task notBefore (§4)", () => {
  const card = (notBefore: unknown) => one({ type: "create_task", title: "Start later", body: "", labels: ["docs"], notBefore });

  test("a zoned future time within 30 days is kept, in UTC", () => {
    expect(card("2026-10-12T23:00:00+02:00").valid).toEqual([{ type: "create_task", title: "Start later", body: "", labels: ["docs"], notBefore: "2026-10-12T21:00:00.000Z" }]);
    expect(card(null).valid).toEqual([{ type: "create_task", title: "Start later", body: "", labels: ["docs"] }]);
  });

  test("past, too far, or zoneless is refused with validateNotBefore's words", () => {
    expect(card("2026-10-12T09:00:00Z").dropped[0]!.reason).toBe("notBefore must be in the future");
    expect(card("2026-11-20T09:00:00Z").dropped[0]!.reason).toBe("notBefore must be at most 30 days from now");
    expect(card("2026-10-12T23:00").dropped[0]!.reason).toBe("notBefore must be a date and time with a zone, e.g. 2026-10-12T23:00:00Z");
  });
});

// ---------- the context (§3.9) ----------

describe("Ask's context lists the schedules and the default timezone", () => {
  const input = {
    tasks: [],
    pipelines: [{ id: "p-ai", name: "AI news podcast" }],
    projects: [],
    accounts: [],
    knownLabels: ["docs"],
    history: [],
    message: "move the podcasts to 7",
    nonce: "n0nce123",
    now: "2026-10-12T10:00:00.000Z",
    schedules: [
      { id: AI.id, name: "AI news podcast", kind: "pipeline" as const, pipelineId: "p-ai", cron: "0 6 * * *", timezone: "Europe/Madrid", enabled: true, nextRunAt: "2026-10-13T04:00:00.000Z" },
      { id: WORLD.id, name: "World news podcast", kind: "pipeline" as const, pipelineId: "p-gone", cron: "0 6 * * *", timezone: "Europe/Madrid", enabled: false },
      { id: DEPS.id, name: "Check dependencies", kind: "task" as const, taskTemplate: { title: "Check deps", body: "", labels: ["docs"] }, cron: "0 9 * * 1", timezone: "Europe/Madrid", enabled: true, nextRunAt: "2026-10-19T07:00:00.000Z" },
    ],
  };

  test("id, name, what it runs, cadence, cron, timezone, next run in its zone, enabled", () => {
    const data = conciergeData(input);
    expect(data.defaultTimezone).toBe(DEFAULT_SCHEDULE_TIMEZONE);
    expect(data.localNow).toBe("2026-10-12 12:00 Europe/Madrid (UTC+02:00)");
    expect(data.schedules).toEqual([
      { id: AI.id, name: "AI news podcast", runs: "pipeline AI news podcast", cadence: "every day at 06:00", cron: "0 6 * * *", timezone: "Europe/Madrid", enabled: true, nextRun: "2026-10-13 06:00 Europe/Madrid" },
      { id: WORLD.id, name: "World news podcast", runs: "pipeline a deleted pipeline", cadence: "every day at 06:00", cron: "0 6 * * *", timezone: "Europe/Madrid", enabled: false, nextRun: null },
      { id: DEPS.id, name: "Check dependencies", runs: "card 'Check deps'", cadence: "every Monday at 09:00", cron: "0 9 * * 1", timezone: "Europe/Madrid", enabled: true, nextRun: "2026-10-19 09:00 Europe/Madrid" },
    ]);
  });

  test("the schedules sit inside the untrusted fence, like everything from the board", () => {
    const body = buildConciergeContext(input);
    const fenced = body.slice(body.indexOf("```untrusted-n0nce123"), body.lastIndexOf("```"));
    expect(fenced).toContain('"name": "World news podcast"');
    expect(fenced).toContain('"defaultTimezone": "Europe/Madrid"');
  });

  test("without a schedules list there is no schedules key, but the zone is still there", () => {
    const data = conciergeData({ ...input, schedules: undefined });
    expect("schedules" in data).toBe(false);
    expect(data.defaultTimezone).toBe("Europe/Madrid");
  });

  test("wallClock and utcOffset across the DST change (2026-10-25 in Madrid)", () => {
    expect(wallClock(new Date("2026-10-24T04:00:00Z"), "Europe/Madrid")).toBe("2026-10-24 06:00");
    expect(utcOffset(new Date("2026-10-24T04:00:00Z"), "Europe/Madrid")).toBe("+02:00");
    expect(utcOffset(new Date("2026-10-26T05:00:00Z"), "Europe/Madrid")).toBe("+01:00");
    expect(utcOffset(new Date("2026-10-26T05:00:00Z"), "UTC")).toBe("+00:00");
    expect(utcOffset(new Date("2026-10-26T05:00:00Z"), "Asia/Kolkata")).toBe("+05:30");
  });
});

// ---------- through the routes: POST /ask, then the Confirm tap ----------

const home = await mkdtemp(join(tmpdir(), "wissel-ask-schedules-test-"));
afterAll(() => rm(home, { recursive: true, force: true }));

const block = (reply: string, actions: unknown[] = []) => "```wissel-actions\n" + JSON.stringify({ reply, actions }) + "\n```";

interface AskBody {
  conversation: Conversation;
  assistant: ChatMessage;
}

function scripted(answers: string[]): CommandRunner {
  return async () => {
    const next = answers.shift();
    if (next === undefined) throw new Error("concierge called more times than scripted");
    return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: next, total_cost_usd: 0.01 }), stderr: "", exitCode: 0 };
  };
}

const SCHEDULE_NOW = new Date("2026-10-12T03:00:00.000Z");

/** Pipeline steps and Run now land here, so nothing real runs. */
const fakeSteps: Executor = { id: "test-steps", canHandle: (agent) => !agent.harnesses?.length, run: async (task, agent) => ({ taskId: task.id, agentId: agent.id, ok: true, summary: "ok" }) };

async function setup(answers: string[]) {
  const board = new SqliteBoard();
  const pipelines = new SqlitePipelineStore(board.db);
  const step = { steps: [{ id: "s1", name: "Gather", agentId: "quick-answer", transition: "all" as const }], edges: [] };
  const ai = await pipelines.create({ name: "AI news podcast", description: "", graph: step });
  const world = await pipelines.create({ name: "World news podcast", description: "", graph: step });
  const app = createApp(board, await Registry.load(), undefined, {
    conciergeExecutor: new ReadOnlyExecutor({ runner: scripted(answers) }),
    conciergeHarnesses: HarnessPool.from([{ id: "claude", tool: "claude-cli", label: "Claude", enabled: true }]),
    conciergeHomeDir: home,
    manualExecutors: [fakeSteps],
    harnesses: HarnessPool.from([{ id: "codex", tool: "codex-cli", label: "Codex", enabled: true }]),
    harnessesPath: join(home, `harnesses-${Math.random()}.yaml`),
    // 05:00 in Madrid: 06:00 and 07:00 are both still ahead today.
    scheduleClock: { now: () => SCHEDULE_NOW },
  });
  const call =async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await app(new Request(`http://localhost${path}`, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }));
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  };
  const ask = async (text: string) => (await call<AskBody>("POST", "/ask", { text })).body;
  const schedule = async (name: string, over: Record<string, unknown> = {}) =>
    (await call<ScheduleView>("POST", "/schedules", { name, kind: "pipeline", pipelineId: ai.id, cron: "0 6 * * *", timezone: "Europe/Madrid", enabled: false, ...over })).body;
  const get = async (id: string) => (await call<ScheduleView>("GET", `/schedules/${id}`)).body;
  const list = async () => (await call<ScheduleView[]>("GET", "/schedules")).body;
  return { board, app, call, ask, schedule, get, list, ai, world };
}

const controls = (m: ChatMessage) => m.actions.filter((a): a is ControlExecuted => "control" in a);

describe("Tier A schedule actions run at once, through the /schedules functions", () => {
  test("'move the news podcasts to 7:00': one update_schedule per podcast, both moved, nextRunAt recomputed", async () => {
    const made: ScheduleView[] = [];
    const t = await setupWith([], async (s) => {
      made.push(await s.schedule("AI news podcast", { enabled: true }), await s.schedule("World news podcast", { pipelineId: s.world.id, enabled: true }));
      return [block("Moving both to 07:00.", made.map((m) => ({ type: "update_schedule", schedule: m.id, cron: "0 7 * * *" })))];
    });
    const body = await t.ask("move the news podcasts to 7:00");
    expect(controls(body.assistant).map((a) => [a.type, a.ok, a.tier, a.confirmedBy, a.target])).toEqual(
      made.map((m) => ["update_schedule", true, "A", "tier-a", { kind: "schedule", id: m.id, label: m.name }]),
    );
    expect(body.assistant.text).toContain("Schedule 'AI news podcast' now runs every day at 07:00.");
    for (const m of made) {
      const after = await t.get(m.id);
      expect(after.cron).toBe("0 7 * * *");
      // 07:00 in Madrid, an hour after the 06:00 it had.
      expect(Date.parse(after.nextRunAt!) - Date.parse(m.nextRunAt!)).toBe(60 * 60 * 1000);
    }
  });

  test("a bad cron from the model changes nothing and says why", async () => {
    const t = await setupWith([], async (s) => {
      const ai = await s.schedule("AI news podcast", { enabled: true });
      return [block("Every 30 seconds it is.", [{ type: "update_schedule", schedule: ai.id, cron: "*/30 * * * * *" }])];
    });
    const body = await t.ask("run the AI news one every 30 seconds");
    expect(controls(body.assistant)).toEqual([]);
    expect(body.assistant.text).toContain("Did not change schedule 'AI news podcast': cron must have exactly 5 fields");
    expect((await t.list())[0]!.cron).toBe("0 6 * * *");
  });

  test("'pause the world news one': set_schedule_enabled false, nextRunAt cleared", async () => {
    const t = await setupWith([], async (s) => {
      const w = await s.schedule("World news podcast", { pipelineId: s.world.id, enabled: true });
      return [block("Paused it.", [{ type: "set_schedule_enabled", schedule: w.id, enabled: false }])];
    });
    const body = await t.ask("pause the world news one");
    expect(controls(body.assistant)).toMatchObject([{ type: "set_schedule_enabled", ok: true, tier: "A", text: "Paused schedule 'World news podcast'; it won't run until you turn it back on." }]);
    const w = (await t.list())[0]!;
    expect(w.enabled).toBe(false);
    expect(w.nextRunAt).toBeUndefined();
  });

  test("run_schedule_now fires a task schedule's card now, with its scheduleId, and leaves nextRunAt", async () => {
    const t = await setupWith([], async (s) => {
      const d = await s.schedule("Weekly docs check", { kind: "task", pipelineId: undefined, taskTemplate: { title: "Check the docs", body: "b", labels: ["docs"] }, cron: "0 9 * * 1", enabled: true });
      return [block("Running it now.", [{ type: "run_schedule_now", schedule: d.id }])];
    });
    const [before] = await t.list();
    const body = await t.ask("run the weekly docs check now");
    expect(controls(body.assistant)).toMatchObject([{ type: "run_schedule_now", ok: true, text: "Started schedule 'Weekly docs check' now; its next run stays as it was." }]);
    const cards = await t.board.list();
    expect(cards.map((c) => [c.title, c.scheduleId])).toEqual([["Check the docs", before!.id]]);
    expect((await t.get(before!.id)).nextRunAt).toBe(before!.nextRunAt!);
  });
});

describe("Tier B schedule actions wait for the Confirm tap", () => {
  test("create_schedule: pending, no schedule; Confirm creates it through POST /schedules' function", async () => {
    const t = await setupWith([block("Tap Confirm to schedule it.", [{ type: "create_schedule", pipeline: "AI news podcast", cron: "0 7 * * 1-5", timezone: "Europe/Madrid" }])]);
    const body = await t.ask("run the AI news podcast every weekday at 7");
    expect(controls(body.assistant)).toEqual([]);
    expect(await t.list()).toEqual([]);
    const [p] = body.assistant.pending! as PendingView[];
    expect(p).toMatchObject({ kind: "confirm", state: "open", lines: ["Create schedule 'AI news podcast, weekdays at 07:00': runs AI news podcast weekdays at 07:00 (Europe/Madrid)"] });

    const ok = await t.call<{ message: ChatMessage }>("POST", `/ask/actions/${p!.id}/confirm`, { conversationId: body.conversation.id });
    expect(ok.status).toBe(200);
    const [made] = await t.list();
    expect(made).toMatchObject({ name: "AI news podcast, weekdays at 07:00", kind: "pipeline", pipelineId: t.ai.id, cron: "0 7 * * 1-5", timezone: "Europe/Madrid", enabled: true, cadence: "weekdays at 07:00" });
    expect(controls(ok.body.message)).toMatchObject([{ type: "create_schedule", ok: true, tier: "B", confirmedBy: "confirm", target: { kind: "schedule", id: made!.id } }]);
  });

  test("delete_schedule: pending, still there; Confirm deletes it", async () => {
    const t = await setupWith([], async (s) => {
      const d = await s.schedule("AI news podcast");
      return [block("Tap Confirm to delete it.", [{ type: "delete_schedule", schedule: d.id }])];
    });
    const body = await t.ask("delete the AI news schedule");
    expect(await t.list()).toHaveLength(1);
    const [p] = body.assistant.pending!;
    expect(p!.lines).toEqual(["Delete schedule 'AI news podcast'"]);
    // A "yes" in chat is not a Confirm: it isn't even scripted, so the
    // pending action is all there is until the tap.
    await t.call("POST", `/ask/actions/${p!.id}/confirm`, { conversationId: body.conversation.id });
    expect(await t.list()).toEqual([]);
  });

  test("a create_schedule rechecked at Confirm: a pipeline deleted in between is refused, nothing made", async () => {
    const t = await setupWith([block("Tap Confirm.", [{ type: "create_schedule", pipeline: "World news podcast", cron: "0 7 * * *", timezone: "Europe/Madrid" }])]);
    const body = await t.ask("run the world news every day at 7");
    await t.call("DELETE", `/pipelines/${t.world.id}`);
    const ok = await t.call<{ message: ChatMessage }>("POST", `/ask/actions/${body.assistant.pending![0]!.id}/confirm`, { conversationId: body.conversation.id });
    expect(controls(ok.body.message)).toMatchObject([{ type: "create_schedule", ok: false, error: 'there is no pipeline called "' + t.world.id + '"' }]);
    expect(await t.list()).toEqual([]);
  });
});

describe("create_task with notBefore: 'start this tonight at 11'", () => {
  test("the card is made with its start time in UTC; a past one makes no card", async () => {
    const at = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const iso = at.toISOString().replace(/\.\d{3}Z$/, "+00:00");
    const t = await setupWith([
      block("It starts tonight.", [{ type: "create_task", title: "Tidy the docs", body: "b", labels: ["docs"], notBefore: iso }]),
      block("Done.", [{ type: "create_task", title: "Too late", body: "b", labels: ["docs"], notBefore: "2020-01-01T00:00:00Z" }]),
    ]);
    await t.ask("make a card to tidy the docs and start it tonight at 11");
    const [card] = await t.board.list();
    expect(card!.notBefore).toBe(new Date(iso).toISOString());
    const late = await t.ask("make a card, start it in 2020");
    expect(late.assistant.text).toContain("notBefore must be in the future");
    expect(await t.board.list()).toHaveLength(1);
  });
});

/** A fresh app whose concierge answers `answers`, then what `prepare`
 *  returns once the schedules it makes exist (their ids go in the
 *  script). */
async function setupWith(answers: string[], prepare?: (s: Awaited<ReturnType<typeof setup>>) => Promise<string[]>) {
  const script: string[] = [...answers];
  const s = await setup(script);
  if (prepare) script.push(...(await prepare(s)));
  return s;
}
