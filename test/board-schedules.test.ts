import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { describeCadence, validateSchedule } from "../src/core/schedule-time.ts";
import { notBeforeRefusal } from "../src/services/board-actions.ts";
import type { ScheduleDef, TaskCard } from "../src/core/types.ts";
import {
  SCHEDULE_DAYS,
  SCHEDULE_MODES,
  buildCron,
  canHaveStartTime,
  defaultScheduleName,
  formatWhen,
  isoToLocalDateTime,
  localDateTimeToIso,
  nextRunsByPipeline,
  parseCron,
  previewView,
  scheduleBody,
  scheduleRows,
  startsChipText,
} from "../src/api/public/board-schedules.js";
import type { SchedulePicker } from "../src/api/public/board-schedules.js";

// docs/SDD-schedules.md §3.7 and §4: the board's schedule picker, the
// Schedules panel's rows, and a card's Start at.

const PUBLIC = join(import.meta.dir, "..", "src", "api", "public");
const BOARD_HTML_PATH = join(PUBLIC, "board.html");
const MADRID = "Europe/Madrid";
// Monday 2026-10-12, 12:00 in Madrid (CEST, UTC+2).
const NOW = new Date("2026-10-12T10:00:00Z");

function schedule(over: Partial<ScheduleDef> & { cadence?: string; lastRunStatus?: TaskCard["status"] | null } = {}) {
  return {
    id: "s1", name: "AI news podcast", kind: "pipeline", pipelineId: "p1", cron: "0 6 * * *", timezone: MADRID,
    enabled: true, catchUpHours: 12, nextRunAt: "2026-10-13T04:00:00.000Z", createdAt: "x", updatedAt: "x",
    cadence: "every day at 06:00", lastRunStatus: null,
    ...over,
  } as ScheduleDef & { cadence?: string; lastRunStatus?: TaskCard["status"] | null };
}

describe("picker -> cron (buildCron)", () => {
  test("every day, weekdays, weekly on chosen days, every N hours", () => {
    expect(buildCron({ mode: "daily", time: "06:00" })).toEqual({ ok: true, cron: "0 6 * * *" });
    expect(buildCron({ mode: "weekdays", time: "07:30" })).toEqual({ ok: true, cron: "30 7 * * 1-5" });
    expect(buildCron({ mode: "weekly", time: "18:05", days: [5, 1, 1, 7] })).toEqual({ ok: true, cron: "5 18 * * 0,1,5" });
    expect(buildCron({ mode: "hours", time: "09:15", everyHours: 3 })).toEqual({ ok: true, cron: "15 */3 * * *" });
    expect(buildCron({ mode: "hours", time: "00:00", everyHours: 1 })).toEqual({ ok: true, cron: "0 * * * *" });
  });

  test("refuses what the picker can't mean, in words", () => {
    expect(buildCron({ mode: "daily", time: "" })).toEqual({ ok: false, error: "Pick a time (HH:MM)." });
    expect(buildCron({ mode: "daily", time: "24:00" }).ok).toBe(false);
    expect(buildCron({ mode: "weekly", time: "06:00", days: [] })).toEqual({ ok: false, error: "Pick at least one day." });
    for (const n of [0, 24, 1.5, Number.NaN]) expect(buildCron({ mode: "hours", time: "06:00", everyHours: n }).ok).toBe(false);
    expect(buildCron({ time: "06:00" }).ok).toBe(false);
    expect(buildCron(null).ok).toBe(false);
  });

  test("every cron it builds passes the server's own rules and reads back in words", () => {
    // The same check GET /schedules/preview and POST /schedules run.
    const cases: [Parameters<typeof buildCron>[0], string][] = [
      [{ mode: "daily", time: "06:00" }, "every day at 06:00"],
      [{ mode: "weekdays", time: "07:30" }, "weekdays at 07:30"],
      [{ mode: "hours", time: "00:00", everyHours: 2 }, "every 2 hours"],
    ];
    for (const [picker, words] of cases) {
      const built = buildCron(picker);
      if (!built.ok) throw new Error(built.error);
      expect(validateSchedule({ cron: built.cron, timezone: MADRID }, NOW)).toEqual({ ok: true });
      expect(describeCadence(built.cron)).toBe(words);
    }
  });
});

describe("cron -> picker (parseCron)", () => {
  test("is the inverse of buildCron for every mode", () => {
    const pickers: SchedulePicker[] = [
      { mode: "daily", time: "06:00", days: [], everyHours: 1 },
      { mode: "weekdays", time: "07:30", days: [], everyHours: 1 },
      { mode: "weekly", time: "18:05", days: [0, 3, 6], everyHours: 1 },
      { mode: "hours", time: "00:15", days: [], everyHours: 4 },
      { mode: "hours", time: "00:00", days: [], everyHours: 1 },
    ];
    for (const p of pickers) {
      const built = buildCron(p);
      if (!built.ok) throw new Error(built.error);
      expect(parseCron(built.cron)).toEqual(p);
    }
  });

  test("reads the other spellings of the same cadence", () => {
    expect(parseCron("0 7 * * MON-FRI")?.mode).toBe("weekdays");
    expect(parseCron("0 7 * * 1,2,3,4,5")?.mode).toBe("weekdays");
    expect(parseCron("0 7 * * 0-6")?.mode).toBe("daily");
    expect(parseCron("0 7 * * sat,7")).toEqual({ mode: "weekly", time: "07:00", days: [0, 6], everyHours: 1 });
    expect(parseCron("  30   2  *  *  * ")).toEqual({ mode: "daily", time: "02:30", days: [], everyHours: 1 });
    expect(parseCron("0 0/6 * * *")?.everyHours).toBe(6);
  });

  test("anything else is null, so the editor opens on Advanced: cron", () => {
    for (const cron of ["", "0 6 * *", "0 6 1 * *", "0 6 * 1 *", "*/15 * * * *", "0 6,18 * * *", "0 */2 * * 1-5", "0 6 * * 1/2", "0 6 * * 5-1", "x 6 * * *", "0 6 * * * *"]) {
      expect(parseCron(cron)).toBeNull();
    }
  });

  test("the picker's tables: Monday first, Sunday = 0, and Advanced last", () => {
    expect(SCHEDULE_DAYS.map((d) => d.day)).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(SCHEDULE_MODES.map((m) => m.mode)).toEqual(["daily", "weekdays", "weekly", "hours", "custom"]);
  });
});

describe("datetime-local <-> UTC ISO", () => {
  test("reads the wall clock in the given zone, both sides of the 2026-10-25 change", () => {
    expect(localDateTimeToIso("2026-10-12T23:00", MADRID)).toBe("2026-10-12T21:00:00.000Z");
    expect(localDateTimeToIso("2026-10-24T06:00", MADRID)).toBe("2026-10-24T04:00:00.000Z");
    expect(localDateTimeToIso("2026-10-25T06:00", MADRID)).toBe("2026-10-25T05:00:00.000Z");
    expect(localDateTimeToIso("2026-10-12T23:00", "UTC")).toBe("2026-10-12T23:00:00.000Z");
    expect(localDateTimeToIso("2026-10-12T23:00:30", "America/New_York")).toBe("2026-10-13T03:00:30.000Z");
    expect(localDateTimeToIso("2026-10-12T23:00", "Asia/Kolkata")).toBe("2026-10-12T17:30:00.000Z");
  });

  test("a wall time the spring change skips lands an hour later", () => {
    // 02:30 doesn't exist in Madrid on 2027-03-28; 03:30 CEST does.
    expect(localDateTimeToIso("2027-03-28T02:30", MADRID)).toBe("2027-03-28T01:30:00.000Z");
  });

  test("null for anything that isn't a real date and time, or a bad zone", () => {
    for (const v of ["", "2026-10-12", "2026-02-30T10:00", "2026-13-01T10:00", "2026-10-12T24:00", "2026-10-12 23:00", null, undefined]) {
      expect(localDateTimeToIso(v, MADRID)).toBeNull();
    }
    expect(localDateTimeToIso("2026-10-12T23:00", "Mars/Olympus")).toBeNull();
  });

  test("isoToLocalDateTime is its inverse, for the drawer's field", () => {
    expect(isoToLocalDateTime("2026-10-12T21:00:00.000Z", MADRID)).toBe("2026-10-12T23:00");
    expect(isoToLocalDateTime("2026-10-25T05:00:00Z", MADRID)).toBe("2026-10-25T06:00");
    expect(isoToLocalDateTime("not a date", MADRID)).toBe("");
    for (const v of ["2026-10-12T00:05", "2026-12-31T23:59", "2026-10-25T02:30"]) {
      expect(isoToLocalDateTime(localDateTimeToIso(v, MADRID)!, MADRID)).toBe(v);
    }
  });
});

describe("times shown on the board", () => {
  test("formatWhen: today, another day, another year, in the given zone", () => {
    expect(formatWhen("2026-10-12T21:00:00Z", NOW, MADRID)).toBe("today 23:00");
    expect(formatWhen("2026-10-13T04:00:00Z", NOW, MADRID)).toBe("Tue 13 Oct 06:00");
    expect(formatWhen("2027-01-04T07:00:00Z", NOW, MADRID)).toBe("Mon 4 Jan 2027 08:00");
    // 22:30 UTC is already tomorrow in Madrid.
    expect(formatWhen("2026-10-12T22:30:00Z", NOW, MADRID)).toBe("Tue 13 Oct 00:30");
    expect(formatWhen("2026-10-12T22:30:00Z", NOW, "UTC")).toBe("today 22:30");
    expect(formatWhen("nope", NOW, MADRID)).toBe("");
  });

  test("the Start at chip: the time today, with the date otherwise", () => {
    const card = { status: "inbox" as const, notBefore: "2026-10-12T21:00:00.000Z" };
    expect(startsChipText(card, NOW, MADRID)).toBe("Starts 23:00");
    expect(startsChipText({ ...card, notBefore: "2026-10-13T21:00:00.000Z" }, NOW, MADRID)).toBe("Starts Tue 13 Oct 23:00");
    expect(startsChipText({ ...card, status: "ready" }, NOW, MADRID)).toBe("Starts 23:00");
  });

  test("no chip without a start time, or once the card is past it", () => {
    const card = { status: "inbox" as const, notBefore: "2026-10-12T21:00:00.000Z" };
    expect(startsChipText({ status: "inbox" }, NOW, MADRID)).toBeNull();
    expect(startsChipText({ ...card, routedTo: "triager" }, NOW, MADRID)).toBeNull();
    expect(startsChipText({ ...card, status: "running" }, NOW, MADRID)).toBeNull();
    expect(startsChipText({ ...card, archivedAt: "2026-10-12T00:00:00Z" }, NOW, MADRID)).toBeNull();
    expect(startsChipText({ ...card, notBefore: "garbage" }, NOW, MADRID)).toBeNull();
    expect(startsChipText(null, NOW, MADRID)).toBeNull();
  });

  test("canHaveStartTime agrees with the server's notBeforeRefusal on every case", () => {
    const statuses: TaskCard["status"][] = ["inbox", "ready", "running", "dispatched", "review", "done", "failed", "escalated"];
    for (const status of statuses) {
      for (const routedTo of [undefined, "triager"]) {
        for (const archivedAt of [undefined, "2026-10-12T00:00:00Z"]) {
          for (const pipelineId of [undefined, "p1"]) {
            const card = { status, routedTo, archivedAt, pipelineId };
            expect(canHaveStartTime(card)).toBe(notBeforeRefusal(card) === undefined);
          }
        }
      }
    }
  });
});

describe("Schedules panel rows (scheduleRows)", () => {
  test("a pipeline schedule: its pipeline's name, cadence, zone and next run on the browser's clock", () => {
    const [row] = scheduleRows([schedule()], [{ id: "p1", name: "AI news" }], NOW, MADRID);
    expect(row).toMatchObject({
      target: "Pipeline: AI news", cadence: "every day at 06:00", timezone: MADRID,
      next: "Tue 13 Oct 06:00", last: null, enabled: true,
    });
    // Shown in New York, the same run is at midnight.
    expect(scheduleRows([schedule()], [], NOW, "America/New_York")[0]!.next).toBe("Tue 13 Oct 00:00");
  });

  test("a task schedule names its task; a disabled one is Paused; pipelines not loaded falls back to the id", () => {
    const rows = scheduleRows(
      [
        schedule({ kind: "task", pipelineId: undefined, taskTemplate: { title: "Tidy the inbox", body: "", labels: [] } }),
        schedule({ enabled: false, nextRunAt: undefined }),
        schedule({ cadence: undefined, cron: "*/30 * * * *" }),
      ],
      null,
      NOW,
      MADRID,
    );
    expect(rows.map((r) => r.target)).toEqual(["Task: Tidy the inbox", "Pipeline: p1", "Pipeline: p1"]);
    expect(rows[1]).toMatchObject({ next: "Paused", enabled: false });
    expect(rows[2]!.cadence).toBe("*/30 * * * *");
  });

  test("last run: when, the outcome in words, the run card and its status", () => {
    const at = "2026-10-12T04:00:20.000Z";
    const rows = scheduleRows(
      [
        schedule({ lastRunAt: at, lastOutcome: "started", lastRunId: "r1", lastRunStatus: "done" }),
        schedule({ lastRunAt: at, lastOutcome: "skipped-overlap", lastRunId: "r0" }),
        schedule({ lastRunAt: at, lastOutcome: "skipped-stale" }),
        schedule({ lastRunAt: at, lastOutcome: "error", lastError: "pipeline deleted" }),
      ],
      [],
      NOW,
      MADRID,
    );
    expect(rows.map((r) => r.last)).toEqual([
      { when: "today 06:00", outcome: "started", runId: "r1", runStatus: "done" },
      { when: "today 06:00", outcome: "skipped: the last run was still going", runId: "r0", runStatus: null },
      { when: "today 06:00", outcome: "skipped: too late to catch up", runId: null, runStatus: null },
      { when: "today 06:00", outcome: "error: pipeline deleted", runId: null, runStatus: null },
    ]);
  });

  test("nextRunsByPipeline: the soonest enabled schedule per pipeline, ignoring task and paused ones", () => {
    const soon = schedule({ id: "a", nextRunAt: "2026-10-12T16:00:00Z" });
    const later = schedule({ id: "b", nextRunAt: "2026-10-13T04:00:00Z" });
    const paused = schedule({ id: "c", enabled: false, nextRunAt: "2026-10-12T11:00:00Z" });
    const other = schedule({ id: "d", pipelineId: "__proto__" });
    const task = schedule({ id: "e", kind: "task", pipelineId: "p1", nextRunAt: "2026-10-12T10:30:00Z" });
    const out = nextRunsByPipeline([later, soon, paused, other, task]);
    expect(Object.keys(out).sort()).toEqual(["__proto__", "p1"]);
    expect(out.p1!.id).toBe("a");
    expect(out["__proto__"]!.id).toBe("d");
    expect(nextRunsByPipeline(null)).toEqual({});
  });
});

describe("the editor's preview and body", () => {
  test("previewView: the first three runs on the browser's clock, or the server's error", () => {
    const next = ["2026-10-13T04:00:00Z", "2026-10-14T04:00:00Z", "2026-10-15T04:00:00Z", "2026-10-16T04:00:00Z", "2026-10-17T04:00:00Z"];
    expect(previewView({ valid: true, cadence: "every day at 06:00", next }, NOW, MADRID)).toEqual({
      valid: true, error: null, cadence: "every day at 06:00",
      lines: ["Tue 13 Oct 06:00", "Wed 14 Oct 06:00", "Thu 15 Oct 06:00"],
    });
    expect(previewView({ valid: false, error: "runs less than 5 minutes apart", cadence: "* * * * *", next: [] }, NOW, MADRID)).toEqual({
      valid: false, error: "runs less than 5 minutes apart", cadence: "* * * * *", lines: [],
    });
    expect(previewView(null, NOW, MADRID).valid).toBe(false);
  });

  test("defaultScheduleName", () => {
    expect(defaultScheduleName("AI news", "every day at 06:00")).toBe("AI news, every day at 06:00");
    expect(defaultScheduleName("AI news", "")).toBe("AI news");
  });

  test("create a pipeline schedule: kind and pipelineId, empty input and repo left out", () => {
    const draft = { kind: "pipeline" as const, name: " AI news, 06:00 ", pipelineId: "p1", input: "", repo: " ", cron: "0 6 * * *", timezone: MADRID, catchUpHours: "" };
    expect(scheduleBody(draft, "create")).toEqual({
      ok: true, body: { name: "AI news, 06:00", kind: "pipeline", pipelineId: "p1", cron: "0 6 * * *", timezone: MADRID },
    });
    expect(scheduleBody({ ...draft, input: "today's news", repo: "/r", catchUpHours: "6" }, "create")).toEqual({
      ok: true, body: { name: "AI news, 06:00", kind: "pipeline", pipelineId: "p1", input: "today's news", repo: "/r", cron: "0 6 * * *", timezone: MADRID, catchUpHours: 6 },
    });
  });

  test("edit a pipeline schedule: no kind or pipelineId (the API refuses them), empty fields clear", () => {
    const draft = { kind: "pipeline" as const, name: "x", pipelineId: "p1", input: "", repo: "", cron: "0 7 * * *", timezone: MADRID, catchUpHours: "0" };
    expect(scheduleBody(draft, "edit")).toEqual({
      ok: true, body: { name: "x", cron: "0 7 * * *", timezone: MADRID, catchUpHours: 0, input: null, repo: null },
    });
  });

  test("a task schedule keeps its template's labels, harness and model; the repo lives in the template", () => {
    const template = { title: "old", body: "old", labels: ["intake"], harnessOverride: "claude-cli", model: "opus", repo: "/old" };
    const draft = { kind: "task" as const, name: "Tidy", title: "Tidy the inbox", body: " triage it ", repo: "/r", template, cron: "0 9 * * 1-5", timezone: MADRID };
    expect(scheduleBody(draft, "create")).toEqual({
      ok: true,
      body: {
        name: "Tidy", kind: "task", cron: "0 9 * * 1-5", timezone: MADRID,
        taskTemplate: { title: "Tidy the inbox", body: "triage it", labels: ["intake"], repo: "/r", harnessOverride: "claude-cli", model: "opus" },
      },
    });
    const edited = scheduleBody({ ...draft, repo: "" }, "edit");
    expect(edited).toEqual({
      ok: true,
      body: {
        name: "Tidy", cron: "0 9 * * 1-5", timezone: MADRID, repo: null,
        taskTemplate: { title: "Tidy the inbox", body: "triage it", labels: ["intake"], harnessOverride: "claude-cli", model: "opus" },
      },
    });
    // The draft's template isn't mutated.
    expect(template.labels).toEqual(["intake"]);
  });

  test("refusals in words", () => {
    const draft = { kind: "pipeline" as const, name: "x", pipelineId: "p1", cron: "0 6 * * *", timezone: MADRID };
    expect(scheduleBody({ ...draft, name: "  " }, "create")).toEqual({ ok: false, error: "Name is required." });
    expect(scheduleBody({ ...draft, cron: "" }, "create")).toEqual({ ok: false, error: "A cadence is required." });
    expect(scheduleBody({ ...draft, catchUpHours: "-1" }, "create").ok).toBe(false);
    expect(scheduleBody({ ...draft, catchUpHours: "soon" }, "create").ok).toBe(false);
    expect(scheduleBody({ ...draft, kind: "task", title: "" }, "create")).toEqual({ ok: false, error: "The task needs a title." });
    // No zone: left out, so the API's DEFAULT_SCHEDULE_TIMEZONE applies.
    expect(scheduleBody({ ...draft, timezone: "" }, "create")).toEqual({ ok: true, body: { name: "x", kind: "pipeline", pipelineId: "p1", cron: "0 6 * * *" } });
  });
});

// --- Served and loaded by the board --------------------------------------

test("board.html loads board-schedules.js before its inline script", async () => {
  const html = await readFile(BOARD_HTML_PATH, "utf8");
  const tag = html.indexOf('<script src="/board-schedules.js"></script>');
  expect(tag).toBeGreaterThan(0);
  expect(tag).toBeLessThan(html.indexOf("<script>\n(function () {"));
});

test("GET /board-schedules.js serves the module the board loads", async () => {
  const app = createApp(new SqliteBoard(), await Registry.load());
  const res = await app(new Request("http://localhost/board-schedules.js"));
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("function buildCron(");
});

test("board.html's inline scripts parse", async () => {
  const html = await readFile(BOARD_HTML_PATH, "utf8");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  expect(scripts.length).toBeGreaterThan(0);
  for (const source of scripts) expect(() => new Function(source)).not.toThrow();
});

test("board.html has the Schedules panel, the editor, Repeat, Start at and the drawer's start section", async () => {
  const html = await readFile(BOARD_HTML_PATH, "utf8");
  for (const id of ["schedulesPanel", "schedulesList", "schedDrawer", "schedForm", "sePicker", "seSave", "ntRepeat", "ntRepeatFields", "ntStartAt", "tdStartSection", "tdStartAt", "tdStartSet", "tdStartClear"]) {
    expect(html).toContain(`id="${id}"`);
  }
  // The browser zone is read once, by the board, and passed in.
  expect(html).toContain("Intl.DateTimeFormat().resolvedOptions().timeZone");
});

test("board-schedules.js reads no clock, zone or DOM of its own, and has no em dashes", async () => {
  const js = await readFile(join(PUBLIC, "board-schedules.js"), "utf8");
  const dts = await readFile(join(PUBLIC, "board-schedules.d.ts"), "utf8");
  const code = js.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  expect(code).not.toMatch(/Date\.now|new Date\(\)|resolvedOptions|document\.|window\.|fetch\(/);
  const EM_DASH = String.fromCharCode(0x2014);
  expect(js.includes(EM_DASH) || dts.includes(EM_DASH)).toBe(false);
});
