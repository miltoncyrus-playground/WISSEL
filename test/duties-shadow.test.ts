import { expect, test } from "bun:test";
import { createApp } from "../src/api/server.ts";
import { Registry } from "../src/core/registry.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { SqliteChannelLog, type ChannelEntry } from "../src/services/channel.ts";
import { SqliteOutboundQueue, gateContextFor, type ExecutableAction, type OutboundEntry } from "../src/services/coordinator-executor.ts";
import { DUTIES, SqliteDutyStore, validateDutyChange } from "../src/services/duties.ts";
import type { PullRequest } from "../src/services/github-status.ts";
import { DEFAULT_HARD_LIMITS, evaluate } from "../src/services/policy-gate.ts";
import { shadowReport } from "../src/services/shadow-report.ts";
import { SqliteWorkstreamStore } from "../src/services/workstreams.ts";

// Duty switches, Shadow and the shadow report (docs/SDD-coordinator.md §4.13,
// §5, §7): eight duties per workstream, each owned by Wissel or an external
// coordinator; only the owner flips one, with confirm:true. The report
// compares Shadow's would-entries with the channel log and the PR list.

const WS = "ws-1";
const SHA_A = "a".repeat(40), SHA_B = "b".repeat(40), SHA_C = "c".repeat(40);
const req = (path: string, method = "GET", body?: unknown): Request => new Request(`http://localhost${path}`, body === undefined ? { method } : { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const act = (kind: string, more: Partial<ExecutableAction> = {}): ExecutableAction => ({ kind, workstreamId: WS, projectId: "p1", ...more });
const external = (message: ChannelEntry["message"], ref: string): ChannelEntry => ({ ref, at: "2026-11-09T10:00:00Z", workstreamId: WS, message, untrusted: true });

test("duty store: every duty defaults to wissel; a switch is stamped and upserted; the gate map lists only switched duties", () => {
  const store = new SqliteDutyStore(new SqliteBoard().db, () => "2026-11-09T12:00:00.000Z");
  expect(store.list(WS)).toEqual(DUTIES.map((duty) => ({ workstreamId: WS, duty, owner: "wissel" })));
  expect(store.map(WS)).toEqual({});
  expect(store.set(WS, "claims", "external")).toEqual({ workstreamId: WS, duty: "claims", owner: "external", changedAt: "2026-11-09T12:00:00.000Z" });
  store.set(WS, "arming", "external");
  store.set(WS, "arming", "wissel");
  expect(store.map(WS)).toEqual({ claims: "external", arming: "wissel" });
  expect(store.list(WS).find((d) => d.duty === "claims")).toMatchObject({ owner: "external", changedAt: expect.any(String) });
  expect(store.list("other")).toEqual(DUTIES.map((duty) => ({ workstreamId: "other", duty, owner: "wissel" })));

  expect(validateDutyChange({ confirm: true, owner: "external" })).toEqual({ ok: true, owner: "external" });
  for (const bad of [undefined, {}, { owner: "external" }, { confirm: "yes", owner: "wissel" }, { confirm: true, owner: "me" }, { confirm: true, owner: "wissel", role: "decide" }]) {
    expect(validateDutyChange(bad).ok).toBe(false);
  }
});

test("API: GET lists the duties, POST needs the owner's confirm and an existing duty, and an external duty makes the gate deny that action", async () => {
  const board = new SqliteBoard();
  const ws = await new SqliteWorkstreamStore(board.db).create({ name: "w", projects: [{ projectId: "p1", role: "decide", decideAlone: [], mustAsk: [], never: [] }] });
  const app = createApp(board, await Registry.load());
  expect(await (await app(req(`/workstreams/${ws.id}/duties`))).json()).toEqual(DUTIES.map((duty) => ({ workstreamId: ws.id, duty, owner: "wissel" })));
  expect((await app(req(`/workstreams/${ws.id}/duties/claims`, "POST", { owner: "external" }))).status).toBe(400);
  expect((await app(req(`/workstreams/${ws.id}/duties/coffee`, "POST", { confirm: true, owner: "external" }))).status).toBe(404);
  expect((await app(req(`/workstreams/nope/duties`))).status).toBe(404);
  const flipped = await app(req(`/workstreams/${ws.id}/duties/claims`, "POST", { confirm: true, owner: "external" }));
  expect(flipped.status).toBe(200);
  expect(await flipped.json()).toMatchObject({ duty: "claims", owner: "external", changedAt: expect.any(String) });
  expect(((await (await app(req(`/workstreams/${ws.id}/duties`))).json()) as { owner: string }[]).map((d) => d.owner)).toEqual(["wissel", "wissel", "wissel", "wissel", "wissel", "external", "wissel", "wissel"]);

  // The switch map is what the executor's gate context reads (rule 3): a claim is denied, a status post still goes.
  const ctx = { ...gateContextFor(ws, "p1", { limits: DEFAULT_HARD_LIMITS, mainBranch: "main", shadow: false, duties: new SqliteDutyStore(board.db).map(ws.id) }), quiet: false };
  expect(evaluate(act("channel.post", { workstreamId: ws.id, post: "claim" }), ctx)).toMatchObject({ verdict: "deny", rule: "3:duty-external" });
  expect(evaluate(act("channel.post", { workstreamId: ws.id, post: "status" }), ctx)).toMatchObject({ verdict: "allow" });
});

test("shadow report: ready-to-merge agreement, would-be hard-limit violations, and unmatched entries each with a reason", () => {
  const queue = new SqliteOutboundQueue(new SqliteBoard().db);
  const would = (a: ExecutableAction, verdict: "allow" | "deny" = "allow", rule = "6:role-table"): OutboundEntry => queue.add(a, { verdict, rule, mode: "shadow" }, "would", "2026-11-09T09:00:00Z");
  const entries = [
    would(act("channel.post", { post: "ready-to-merge", payload: { about: { card: "A4" }, headSha: SHA_A } })),
    would(act("channel.post", { post: "ready-to-merge", payload: { about: { card: "A5" }, headSha: SHA_B } })),
    would(act("channel.post", { post: "claim", payload: { about: { card: "A4" }, item: "A4", version: 1 } })),
    would(act("channel.post", { post: "status", payload: { about: { ticket: "SHOP-1" }, text: "all green" } })),
    would(act("pr.arm", { base: "main", checks: "green", payload: { pr: 7 } })),
    would(act("pr.arm", { base: "release", checks: "green", payload: { pr: 9 } }), "deny", "1:hard-limit"),
    would(act("card.start", { payload: { title: "A6" } })),
  ];
  const channel: ChannelEntry[] = [
    external({ kind: "ready-to-merge", from: "old-coordinator", about: { card: "A4" }, headSha: SHA_A }, "c1"),
    external({ kind: "ready-to-merge", from: "old-coordinator", about: { card: "A7" }, headSha: SHA_C }, "c2"),
    external({ kind: "claim", from: "old-coordinator", about: { card: "A4" }, item: "A4", version: 3 }, "c3"),
    external({ kind: "release", from: "old-coordinator", about: { card: "A1" }, item: "A1" }, "c4"),
    external({ kind: "question", from: "Ana", about: { card: "A4" }, text: "q?", options: ["x", "y"], lean: "x" }, "c5"),
    external({ kind: "status", from: "wissel", about: { ticket: "SHOP-1" }, text: "mine" }, "c6"),
  ];
  const prs: PullRequest[] = [
    { number: 7, title: "A4", url: "u", branch: "a4", state: "open", armed: true, checks: { state: "passing", total: 1, failing: [] } },
    { number: 9, title: "A9", url: "u", branch: "a9", state: "open", checks: { state: "passing", total: 1, failing: [] } },
  ];
  const lines: string[] = [];
  const report = shadowReport(WS, entries, { channel, prs }, (l) => void lines.push(l));
  expect(report.would).toBe(7);
  expect(report.readyToMerge).toEqual({ agreement: 33, both: [SHA_A], wisselOnly: [SHA_B], externalOnly: [SHA_C] });
  expect(report.hardLimitViolations).toEqual([{ id: entries[5]!.id, at: "2026-11-09T09:00:00Z", action: entries[5]!.action }]);
  expect(report.matched.map((m) => `${m.id}=${m.by}`)).toEqual([`${entries[0]!.id}=channel c1`, `${entries[2]!.id}=channel c3`, `${entries[4]!.id}=pr #7`]);
  expect(report.unmatched).toEqual([
    { side: "wissel", ref: entries[1]!.id, kind: "channel.post ready-to-merge", reason: `no external ready-to-merge entry names head ${SHA_B}` },
    { side: "wissel", ref: entries[3]!.id, kind: "channel.post status", reason: "no external status entry is about ticket SHOP-1" },
    { side: "wissel", ref: entries[5]!.id, kind: "pr.arm", reason: "PR #9 is neither armed nor merged" },
    { side: "wissel", ref: entries[6]!.id, kind: "card.start", reason: "card.start is not observable in the channel log or the PR list" },
    { side: "external", ref: "c2", kind: "ready-to-merge", reason: "old-coordinator posted it; Wissel recorded no would-entry for it" },
    { side: "external", ref: "c4", kind: "release", reason: "old-coordinator posted it; Wissel recorded no would-entry for it" },
  ]);
  expect(lines).toHaveLength(6);
  expect(lines[0]).toContain(`shadow ${WS}: unmatched wissel`);
  // Nothing on either side: full agreement, nothing to report.
  expect(shadowReport(WS, [], { channel: [], prs: [] })).toEqual({ workstreamId: WS, would: 0, readyToMerge: { agreement: 100, both: [], wisselOnly: [], externalOnly: [] }, hardLimitViolations: [], matched: [], unmatched: [] });
});

test("API: GET /workstreams/:id/shadow-report reads the would-entries, the channel log and the injected PR list", async () => {
  const board = new SqliteBoard();
  const ws = await new SqliteWorkstreamStore(board.db).create({ name: "w", projects: [{ projectId: "p1", role: "shadow", decideAlone: [], mustAsk: [], never: [] }] });
  const channelLog = new SqliteChannelLog(board.db, { log: () => {} });
  const prs: PullRequest[] = [{ number: 3, title: "A4", url: "u", branch: "a4", state: "merged", headSha: SHA_A, checks: { state: "passing", total: 1, failing: [] } }];
  const app = createApp(board, await Registry.load(), undefined, { channelLog, shadowPrs: async () => prs });
  await channelLog.adapter(ws.id).post({ kind: "ready-to-merge", from: "old-coordinator", about: { card: "A4" }, headSha: SHA_A });
  new SqliteOutboundQueue(board.db).add(act("channel.post", { workstreamId: ws.id, post: "ready-to-merge", payload: { about: { card: "A4" }, headSha: SHA_A } }), { verdict: "allow", rule: "6:role-table", mode: "shadow" }, "would", "2026-11-09T09:00:00Z");
  new SqliteOutboundQueue(board.db).add(act("pr.arm", { workstreamId: ws.id, base: "main", checks: "green", payload: { pr: 3 } }), { verdict: "allow", rule: "6:role-table", mode: "shadow" }, "would", "2026-11-09T09:01:00Z");
  const res = await app(req(`/workstreams/${ws.id}/shadow-report`));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ workstreamId: ws.id, would: 2, readyToMerge: { agreement: 100, both: [SHA_A] }, hardLimitViolations: [], unmatched: [] });
  expect((await app(req(`/workstreams/nope/shadow-report`))).status).toBe(404);
});
