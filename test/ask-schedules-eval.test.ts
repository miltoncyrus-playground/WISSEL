import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cases, evalClock, nextElevenPm, PASS_CORRECT, runCase, sameCadence, seed } from "../eval/ask-schedules.eval.ts";
import { SCHEDULE_ACTION_TYPES } from "../src/services/concierge-actions.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { ReadOnlyExecutor } from "../src/executors/readonly.ts";
import type { CommandRunner } from "../src/executors/claude-cli.ts";

// The paid eval's judge, checked for free (docs/SDD-schedules.md §5):
// every case passes a right answer and fails a wrong one, with a scripted
// concierge on the eval's own seeded board. An eval whose checks could
// never pass, or could never fail, measures nothing.

const home = await mkdtemp(join(tmpdir(), "wissel-ask-schedules-eval-test-"));
afterAll(() => rm(home, { recursive: true, force: true }));

const block = (reply: string, actions: unknown[] = []) => "```wissel-actions\n" + JSON.stringify({ reply, actions }) + "\n```";

/** A schedule's id as the context shows it, by its name. */
const sid = (prompt: string, name: string) => new RegExp(`"id": "([0-9a-f-]{36})",\\s*"name": "${name}"`).exec(prompt)![1]!;

const RIGHT: Record<string, (prompt: string) => string> = {
  "every weekday at 7": () => block("Tap Confirm.", [{ type: "create_schedule", pipeline: "AI news podcast", cron: "0 7 * * MON-FRI", timezone: "Europe/Madrid" }]),
  "move the podcasts to 7": (p) =>
    block("Moving both.", [
      { type: "update_schedule", schedule: sid(p, "AI news podcast"), cron: "0 7 * * *" },
      { type: "update_schedule", schedule: sid(p, "World news podcast"), cron: "0 7 * * *" },
    ]),
  "pause the world news one": (p) => block("Paused.", [{ type: "set_schedule_enabled", schedule: sid(p, "World news podcast"), enabled: false }]),
  "start this tonight at 11": () => block("It starts at 23:00.", [{ type: "create_task", title: "Tidy up the docs folder", body: "b", labels: ["docs"], notBefore: nextElevenPm(evalClock(new Date())).toISOString() }]),
  "every 2 hours": () => block("Tap Confirm.", [{ type: "create_schedule", pipeline: "Wissel retrospective podcast", cron: "0 0-23/2 * * *", timezone: "Europe/Madrid" }]),
  "every 30 seconds (refused)": () => block("I can't: schedules run at most every 5 minutes, and there is no seconds field."),
  "run a schedule now": (p) => block("Running it.", [{ type: "run_schedule_now", schedule: sid(p, "World news podcast") }]),
  "change days and time of a task schedule": (p) => block("Changed.", [{ type: "update_schedule", schedule: sid(p, "Weekly dependency check"), cron: "30 16 * * 5" }]),
  "another timezone": (p) => block("Moved.", [{ type: "update_schedule", schedule: sid(p, "AI news podcast"), cron: "0 8 * * *", timezone: "America/New_York" }]),
  "delete a schedule": (p) => block("Tap Confirm.", [{ type: "delete_schedule", schedule: sid(p, "Weekly dependency check") }]),
};

const WRONG: Record<string, (prompt: string) => string> = {
  "every weekday at 7": () => block("Tap Confirm.", [{ type: "create_schedule", pipeline: "AI news podcast", cron: "0 7 * * *", timezone: "Europe/Madrid" }]),
  "move the podcasts to 7": (p) => block("Moved one.", [{ type: "update_schedule", schedule: sid(p, "AI news podcast"), cron: "0 7 * * *" }]),
  "pause the world news one": (p) => block("Paused.", [{ type: "set_schedule_enabled", schedule: sid(p, "AI news podcast"), enabled: false }]),
  "start this tonight at 11": () => block("Made it.", [{ type: "create_task", title: "Tidy up the docs folder", body: "b", labels: ["docs"] }]),
  "every 2 hours": () => block("Tap Confirm.", [{ type: "create_schedule", pipeline: "Wissel retrospective podcast", cron: "0 2 * * *", timezone: "Europe/Madrid" }]),
  // Bent into something that wasn't asked: every 5 minutes instead.
  "every 30 seconds (refused)": (p) => block("Every 5 minutes is the closest.", [{ type: "update_schedule", schedule: sid(p, "AI news podcast"), cron: "*/5 * * * *" }]),
  "run a schedule now": (p) => block("Running it.", [{ type: "run_schedule_now", schedule: sid(p, "AI news podcast") }]),
  "change days and time of a task schedule": (p) => block("Changed.", [{ type: "update_schedule", schedule: sid(p, "Weekly dependency check"), cron: "30 16 * * 1" }]),
  "another timezone": (p) => block("Moved.", [{ type: "update_schedule", schedule: sid(p, "AI news podcast"), cron: "0 8 * * *" }]),
  "delete a schedule": (p) => block("Tap Confirm.", [{ type: "delete_schedule", schedule: sid(p, "AI news podcast") }]),
};

function scriptedFor(answer: (prompt: string) => string): ReadOnlyExecutor {
  const runner: CommandRunner = async (_cmd, opts) => ({
    stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: answer(opts.stdin ?? ""), total_cost_usd: 0.01 }),
    stderr: "",
    exitCode: 0,
  });
  return new ReadOnlyExecutor({ runner });
}

const pool = () => HarnessPool.from([{ id: "claude", tool: "claude-cli", label: "Claude", enabled: true }]);

describe("eval:ask-schedules's cases", () => {
  test("ten cases, pass mark 9, every schedule action and an invalid cadence among them", () => {
    expect(cases).toHaveLength(10);
    expect(PASS_CORRECT).toBe(9);
    expect(cases.map((c) => c.name)).toEqual(Object.keys(RIGHT));
    expect(Object.keys(WRONG)).toEqual(Object.keys(RIGHT));
    const asked = new Set(Object.values(RIGHT).flatMap((f) => [...f('"id": "00000000-0000-4000-8000-000000000000", "name": "AI news podcast" "id": "00000000-0000-4000-8000-000000000000", "name": "World news podcast" "id": "00000000-0000-4000-8000-000000000000", "name": "Weekly dependency check"').matchAll(/"type":"(\w+)"/g)].map((m) => m[1])));
    for (const t of SCHEDULE_ACTION_TYPES) expect(asked.has(t)).toBe(true);
  });

  for (const c of cases) {
    test(`"${c.name}": a right answer passes, a wrong one fails`, async () => {
      const right = await runCase(c, await seed(pool(), home, scriptedFor(RIGHT[c.name]!)));
      expect(right.why).toBeNull();
      expect(right.tierBExecuted).toBe(0);
      const wrong = await runCase(c, await seed(pool(), home, scriptedFor(WRONG[c.name]!)));
      expect(wrong.why).not.toBeNull();
    });
  }

  test('"every weekday at 7" also passes when the existing AI news schedule is moved instead (Tier A)', async () => {
    const c = cases.find((x) => x.name === "every weekday at 7")!;
    const moved = await runCase(c, await seed(pool(), home, scriptedFor((p) => block("Moved.", [{ type: "update_schedule", schedule: sid(p, "AI news podcast"), cron: "0 7 * * 1-5" }]))));
    expect(moved.why).toBeNull();
    const other = await runCase(c, await seed(pool(), home, scriptedFor((p) => block("Moved.", [{ type: "update_schedule", schedule: sid(p, "World news podcast"), cron: "0 7 * * 1-5" }]))));
    expect(other.why).not.toBeNull();
  });

  test("Ask's clock is pinned to 18:00 Madrid, so tonight at 11 is measured at any hour", async () => {
    // Late at night, on a summer day, and on the autumn clock change.
    for (const [real, want] of [
      ["2026-10-12T21:44:00Z", "2026-10-12T16:00:00.000Z"],
      ["2026-07-01T05:00:00Z", "2026-07-01T16:00:00.000Z"],
      ["2026-10-25T00:30:00Z", "2026-10-25T17:00:00.000Z"],
    ] as const) {
      expect(evalClock(new Date(real)).toISOString()).toBe(want);
    }
    let prompt = "";
    const pinned = new Date("2026-10-12T16:00:00Z");
    const c = cases.find((x) => x.name === "start this tonight at 11")!;
    const out = await runCase(
      c,
      await seed(pool(), home, scriptedFor((p) => ((prompt = p), block("At 23:00.", [{ type: "create_task", title: "Tidy up the docs folder", body: "b", labels: ["docs"], notBefore: "2026-10-12T21:00:00.000Z" }]))), pinned),
    );
    expect(prompt).toContain("2026-10-12 18:00 Europe/Madrid (UTC+02:00)");
    expect(out.why).toBeNull();
  });

  test("the seed registers a project, so a docs card has a repo to go to", async () => {
    let prompt = "";
    await runCase(cases[0]!, await seed(pool(), home, scriptedFor((p) => ((prompt = p), block("ok")))));
    expect(prompt).toContain('"wissel"');
  });

  test("the invalid cadence is refused by the server too, when the model proposes it anyway", async () => {
    const c = cases.find((x) => x.name === "every 30 seconds (refused)")!;
    const out = await runCase(c, await seed(pool(), home, scriptedFor((p) => block("Done.", [{ type: "update_schedule", schedule: sid(p, "AI news podcast"), cron: "*/30 * * * * *" }]))));
    // Nothing changed, but the model's own reply ("Done.") doesn't say why;
    // the server's note does, and that is what Milton reads.
    expect(out.result.assistant.text).toContain("cron must have exactly 5 fields");
    expect(out.why).toBeNull();
  });

  test("the context the model gets lists the seeded schedules and the default zone", async () => {
    let prompt = "";
    const s = await seed(pool(), home, scriptedFor((p) => ((prompt = p), block("ok"))));
    await runCase(cases[0]!, s);
    expect(prompt).toContain('"defaultTimezone": "Europe/Madrid"');
    for (const name of ["AI news podcast", "World news podcast", "Weekly dependency check"]) expect(sid(prompt, name)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("sameCadence and nextElevenPm", () => {
  const from = new Date("2026-10-12T10:00:00Z");
  test("equal cadences in different spellings match; a different zone or day doesn't", () => {
    expect(sameCadence({ cron: "0 7 * * 1-5", timezone: "Europe/Madrid" }, { cron: "0 7 * * MON-FRI", timezone: "Europe/Madrid" }, from)).toBe(true);
    expect(sameCadence({ cron: "0 */2 * * *", timezone: "Europe/Madrid" }, { cron: "0 0-23/2 * * *", timezone: "Europe/Madrid" }, from)).toBe(true);
    expect(sameCadence({ cron: "0 7 * * *", timezone: "Europe/Madrid" }, { cron: "0 7 * * *", timezone: "America/New_York" }, from)).toBe(false);
    expect(sameCadence({ cron: "0 7 * * *", timezone: "Europe/Madrid" }, { cron: "0 7 * * 1-5", timezone: "Europe/Madrid" }, from)).toBe(false);
    expect(sameCadence({ cron: "*/30 * * * * *", timezone: "Europe/Madrid" }, { cron: "*/30 * * * * *", timezone: "Europe/Madrid" }, from)).toBe(false);
  });

  test("tonight at 11 in Madrid, or tomorrow's once it has passed", () => {
    expect(nextElevenPm(from).toISOString()).toBe("2026-10-12T21:00:00.000Z");
    expect(nextElevenPm(new Date("2026-10-12T21:30:00Z")).toISOString()).toBe("2026-10-13T21:00:00.000Z");
    // Winter time after 2026-10-25: 23:00 is 22:00Z.
    expect(nextElevenPm(new Date("2026-10-26T10:00:00Z")).toISOString()).toBe("2026-10-26T22:00:00.000Z");
  });
});
