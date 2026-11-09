import { expect, test } from "bun:test";
import { SqliteBoard } from "../src/services/board.ts";
import { SqliteScheduleStore } from "../src/services/schedules.ts";
import { SqliteOwnerTaskStore } from "../src/services/owner-tasks.ts";
import { SqliteGateLog } from "../src/services/policy-gate.ts";
import { SqliteWorkstreamStore, type Workstream } from "../src/services/workstreams.ts";
import { ScheduleRunner } from "../src/core/schedule-runner.ts";
import { SqliteDigestLog, buildDigestSnapshot, createDigestRun, renderDigest, type DigestSnapshot } from "../src/services/digests.ts";
import type { HostProbes } from "../src/services/host-guard.ts";

// Digests (docs/SDD-coordinator.md §4.11): a fixed template filled from
// Wissel's own data, no model call, delivered to the channel log (here: a
// log line and a stored record), never to chat. Fake clock, fake probes.

const GB = 1024 ** 3;
const START = Date.parse("2026-10-12T03:00:00.000Z");
// `0 6 * * *` Europe/Madrid (CEST) is 04:00Z.
const TODAY_0600 = "2026-10-12T04:00:00.000Z";

const probes: HostProbes = {
  load: () => 2.5,
  cores: () => 8,
  memory: () => ({ totalBytes: 32 * GB, freeBytes: 8 * GB }),
  diskFree: async () => 120.25 * GB,
};

async function seed() {
  const board = new SqliteBoard();
  const ownerTasks = new SqliteOwnerTaskStore(board.db);
  const gateLog = new SqliteGateLog(board.db);
  const workstreams = new SqliteWorkstreamStore(board.db);
  const ws = await workstreams.create({ name: "checkout redesign", projects: [], digests: [{ cron: "0 6 * * *", timezone: "Europe/Madrid" }] });

  const running = await board.create({ title: "Card A", body: "", labels: [] });
  await board.move(running.id, "running");
  const dispatched = await board.create({ title: "Card B", body: "", labels: [] });
  await board.move(dispatched.id, "dispatched");
  await board.create({ title: "Card C", body: "", labels: [] });
  const escalated = await board.create({ title: "Card D", body: "", labels: [] });
  await board.move(escalated.id, "escalated");
  const landed = await board.create({ title: "Card E", body: "", labels: [] });
  await board.move(landed.id, "done");
  await board.updateFields(landed.id, { pr: { number: 1, url: "u1", head: "h1", watch: { sha: "h1", checks: "passing", mergeable: "clean", state: "open", at: "2026-10-11T00:00:00Z" } } });
  const armed = await board.create({ title: "Card F", body: "", labels: [] });
  await board.move(armed.id, "done");
  await board.updateFields(armed.id, { pr: { number: 2, url: "u2", head: "h2", watch: { sha: "h2", checks: "passing", mergeable: "clean", state: "armed", at: "2026-10-11T00:00:00Z" } } });
  const unwatched = await board.create({ title: "Card G", body: "", labels: [] });
  await board.updateFields(unwatched.id, { pr: { number: 3, url: "u3", head: "h3" } });

  await ownerTasks.create({ title: "Log in to gh", why: "token expired", steps: [], blocks: [] });
  const dismissed = await ownerTasks.create({ title: "Old one", why: "", steps: [], blocks: [] });
  await ownerTasks.setStatus(dismissed.id, "dismissed");

  const action = { workstreamId: ws.id, projectId: "p1" };
  await gateLog.append({ id: "g1", action: { ...action, kind: "pr.arm", repo: "/r" }, verdict: "ask-decider", rule: "mustAsk", mode: "live", at: "2026-10-12T01:00:00Z" });
  await gateLog.append({ id: "g2", action: { ...action, kind: "channel.post", post: "decision", decision: "naming" }, verdict: "ask-decider", rule: "follow", mode: "live", at: "2026-10-12T02:00:00Z" });
  await gateLog.append({ id: "g3", action: { ...action, kind: "card.start" }, verdict: "allow", rule: "decideAlone", mode: "live", at: "2026-10-12T02:30:00Z" });
  // Another workstream's question is not this one's.
  await gateLog.append({ id: "g4", action: { ...action, workstreamId: "other", kind: "pr.arm" }, verdict: "ask-decider", rule: "mustAsk", mode: "live", at: "2026-10-12T02:40:00Z" });

  return { board, ownerTasks, gateLog, workstreams, ws };
}

test("buildDigestSnapshot counts cards against the cap, PRs by state, decider questions, owner tasks and the host", async () => {
  const s = await seed();
  const snap = await buildDigestSnapshot(s.ws, new Date(START), { board: s.board, ownerTasks: s.ownerTasks, gateLog: s.gateLog, probes, maxConcurrentTasks: 5, diskPaths: ["/srv"] });
  expect(snap.cards).toEqual({ live: 2, cap: 5, byStatus: { inbox: 2, running: 1, dispatched: 1, escalated: 1, done: 2 } });
  expect(snap.prs).toEqual({ open: 1, armed: 1, merged: 0, closed: 0, unwatched: 1 });
  expect(snap.decider).toEqual([
    { kind: "channel.post", detail: "decision naming", at: "2026-10-12T02:00:00Z" },
    { kind: "pr.arm", detail: "/r", at: "2026-10-12T01:00:00Z" },
  ]);
  expect(snap.ownerTasks).toEqual({ open: 1, titles: ["Log in to gh"] });
  expect(snap.host).toEqual({ load: 2.5, cores: 8, memoryFreeFraction: 0.25, disk: [{ path: "/srv", freeBytes: 120.25 * GB }] });
});

test("renderDigest fills the fixed template, and reads the same with nothing to report", () => {
  const snap: DigestSnapshot = {
    workstream: { id: "w1", name: "checkout redesign" },
    at: TODAY_0600,
    timezone: "Europe/Madrid",
    cards: { live: 2, cap: 5, byStatus: { inbox: 2, running: 1, dispatched: 1, escalated: 1, done: 2 } },
    prs: { open: 1, armed: 1, merged: 0, closed: 0, unwatched: 1 },
    decider: [{ kind: "channel.post", detail: "decision naming", at: "2026-10-12T02:00:00Z" }],
    ownerTasks: { open: 1, titles: ["Log in to gh"] },
    host: { load: 2.5, cores: 8, memoryFreeFraction: 0.25, disk: [{ path: "/srv", freeBytes: 120.25 * GB }] },
  };
  expect(renderDigest(snap)).toBe(
    [
      "Digest: checkout redesign, 2026-10-12 06:00 Europe/Madrid",
      "Cards: 2 live of cap 5 (dispatched 1, done 2, escalated 1, inbox 2, running 1)",
      "PRs: open 1, armed 1, merged 0, closed 0, unwatched 1",
      "Waiting on the decider: 1: channel.post (decision naming) since 2026-10-12 04:00 Europe/Madrid",
      "Owner tasks: 1 open: Log in to gh",
      "Host: load 2.5 on 8 cores, memory 25% free, disk /srv 120.3 GB free",
    ].join("\n"),
  );
  const quiet = renderDigest({ ...snap, cards: { live: 0, cap: null, byStatus: {} }, prs: { open: 0, armed: 0, merged: 0, closed: 0, unwatched: 0 }, decider: [], ownerTasks: { open: 0, titles: [] }, host: undefined });
  expect(quiet.split("\n").slice(1)).toEqual(["Cards: 0 live, no cap (none)", "PRs: open 0, armed 0, merged 0, closed 0, unwatched 0", "Waiting on the decider: none", "Owner tasks: none open", "Host: not probed"]);
});

test("SqliteDigestLog keeps one record per delivery, per workstream, newest last", async () => {
  const board = new SqliteBoard();
  const log = new SqliteDigestLog(board.db);
  await log.append({ id: "d1", workstreamId: "w1", at: "2026-10-12T04:00:00.000Z", text: "Digest: one" });
  await log.append({ id: "d2", workstreamId: "w1", at: "2026-10-13T04:00:00.000Z", text: "Digest: two" });
  await log.append({ id: "d3", workstreamId: "w2", at: "2026-10-13T04:00:00.000Z", text: "Digest: other" });
  expect((await log.list("w1")).map((r) => r.text)).toEqual(["Digest: one", "Digest: two"]);
});

test("the runner fires a workstream's digest at its cron once, logs a line, stores the record, and collapses missed occurrences", async () => {
  const s = await seed();
  let clock = START;
  const now = () => new Date(clock);
  const store = new SqliteScheduleStore(s.board.db, { now });
  const digestLog = new SqliteDigestLog(s.board.db);
  const lines: string[] = [];
  const errors: string[] = [];
  const noTimer = { setInterval: () => ({}), clearInterval: () => {}, setTimeout: () => ({}), clearTimeout: () => {} };
  const run = createDigestRun({ board: s.board, ownerTasks: s.ownerTasks, gateLog: s.gateLog, probes, maxConcurrentTasks: 5, diskPaths: [] }, digestLog);
  const runner = new ScheduleRunner({ store, board: s.board, runPipelineNow: async () => { throw new Error("no pipelines here"); }, logger: { log: (l) => lines.push(l), error: (l) => errors.push(l) }, now, ...noTimer, digests: { workstreams: s.workstreams, run } });

  // First sight at 03:00Z schedules the 04:00Z occurrence; nothing fires yet.
  await runner.tick();
  clock = Date.parse(TODAY_0600) - 1000;
  await runner.tick();
  expect(await digestLog.list(s.ws.id)).toEqual([]);

  clock = Date.parse(TODAY_0600) + 5000;
  await runner.tick();
  await runner.tick();
  const records = await digestLog.list(s.ws.id);
  expect(records).toHaveLength(1);
  expect(records[0]!.at).toBe(new Date(clock).toISOString());
  expect(records[0]!.text.split("\n")[0]).toBe("Digest: checkout redesign, 2026-10-12 06:00 Europe/Madrid");
  expect(records[0]!.text).toContain("Cards: 2 live of cap 5");
  expect(lines.filter((l) => l.startsWith("digest:"))).toEqual([`digest: "checkout redesign" posted to the channel log\n${records[0]!.text}`]);
  expect(errors).toEqual([]);

  // Three days later: the missed occurrences collapse into one fire.
  clock += 3 * 24 * 60 * 60 * 1000;
  await runner.tick();
  await runner.tick();
  expect(await digestLog.list(s.ws.id)).toHaveLength(2);

  // A workstream whose digests are cleared stops firing; a bad cron is an error line, not a crash.
  await s.workstreams.update(s.ws.id, { digests: null });
  const bad = await s.workstreams.create({ name: "bad", projects: [], digests: [{ cron: "not a cron", timezone: "Europe/Madrid" }] });
  clock += 24 * 60 * 60 * 1000;
  await runner.tick();
  expect(await digestLog.list(s.ws.id)).toHaveLength(2);
  expect(await digestLog.list(bad.id)).toEqual([]);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toStartWith('digest: "bad" has an invalid cron "not a cron": ');
  await runner.tick();
  expect(errors).toHaveLength(1);
});
