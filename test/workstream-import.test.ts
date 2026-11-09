import { expect, test } from "bun:test";
import { createApp } from "../src/api/server.ts";
import { Registry } from "../src/core/registry.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { SqliteProjectStore } from "../src/services/projects.ts";
import { importWorkstream, parseRegistry } from "../src/services/workstream-import.ts";
import { SqliteWorkstreamStore, type Workstream } from "../src/services/workstreams.ts";

// Import (docs/SDD-coordinator.md §7 step 1): a team with an existing
// coordinator hands over its registry of work items, its standing rules,
// its channel cursor and its schedule. Existing cards get key, pr and
// round; nothing is created; unknown cards are reported; a key that would
// collide inside the workstream is refused; ?dryRun=1 only plans.

const SHA = "a".repeat(40);
const PR = { number: 41, url: "https://example.test/pr/41", head: "feat/a1" };
const base = { title: "t", body: "", labels: ["intake"], repo: "/repo/shop" };
const jsonl = (items: unknown[]) => items.map((i) => JSON.stringify(i)).join("\n");

function req(path: string, method = "GET", body?: unknown): Request {
  return new Request(`http://localhost${path}`, body === undefined ? { method } : { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}

async function setup() {
  const board = new SqliteBoard();
  const projects = new SqliteProjectStore(board.db);
  const workstreams = new SqliteWorkstreamStore(board.db);
  const dir = `${process.env.TMPDIR ?? "/tmp"}/wissel-import-${Math.random().toString(36).slice(2)}`;
  await Bun.write(`${dir}/.keep`, "");
  const added = await projects.addLocalProject(dir, { initGit: false }, async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  if ("error" in added) throw new Error(added.error);
  const ws = await workstreams.create({ name: "checkout", projects: [{ projectId: added.project.id, role: "shadow", decideAlone: [], mustAsk: [], never: [] }] });
  const app = createApp(board, await Registry.load(), undefined, { projects });
  return { board, projects, workstreams, project: added.project, ws, app, deps: { board, projects, workstreams } };
}

test("parseRegistry: one JSON object per line, blank lines skipped, bad lines and bad fields named by line", () => {
  const ok = parseRegistry(`${JSON.stringify({ key: "A1", cardId: "c1", pr: PR, sha: SHA, round: 2 })}\n\n{"key":"B2"}\n`);
  expect(ok).toEqual({ ok: true, items: [{ key: "A1", cardId: "c1", pr: PR, sha: SHA, round: 2 }, { key: "B2" }] });
  expect(parseRegistry([{ key: "A1" }])).toEqual({ ok: true, items: [{ key: "A1" }] });
  for (const [bad, re] of [
    ["", /empty/],
    ["nope", /line 1.*JSON/],
    ["[1]", /line 1.*object/],
    ['{"cardId":"c1"}', /line 1.*key/],
    ['{"key":"A1","round":0}', /round/],
    ['{"key":"A1","pr":41}', /pr/],
    ['{"key":"A1","sha":"xyz"}', /sha/],
    ['{"key":"A1","extra":1}', /unknown field extra/],
    ['{"key":"A1"}\n{"key":"A1"}', /line 2.*key "A1".*twice/],
    ['{"key":"A1","cardId":"c"}\n{"key":"A2","cardId":"c"}', /line 2.*card c.*twice/],
  ] as const) {
    const r = parseRegistry(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(re);
  }
});

test("dry run plans without writing: existing cards matched, unknown cards reported, keys without a card left alone, nothing created", async () => {
  const { board, projects, workstreams, project, ws, deps } = await setup();
  const card = await board.create(base);
  const body = {
    registry: jsonl([{ key: "A1", cardId: card.id, pr: PR, sha: SHA, round: 2 }, { key: "A2", cardId: "ghost" }, { key: "A3" }]),
    rules: { cardRules: "Keep PRs small.", cardTemplates: { coder: "Do {key}" } },
    channelCursor: "17",
    schedule: { cron: "0 9 * * 1-5", timezone: "Europe/Madrid" },
  };
  const r = await importWorkstream(ws, body, true, deps);
  expect(r).toEqual({
    ok: true,
    plan: {
      dryRun: true,
      cards: [{ cardId: card.id, key: "A1", round: 2, pr: { ...PR, reviewedSha: SHA } }],
      unknownCards: [{ key: "A2", cardId: "ghost" }],
      unplaced: ["A3"],
      rules: { projectIds: [project.id], cardRules: "Keep PRs small.", cardTemplates: { coder: "Do {key}" } },
      channelCursor: "17",
      schedule: [{ cron: "0 9 * * 1-5", timezone: "Europe/Madrid" }],
    },
  });
  expect(await board.get(card.id)).toEqual(card);
  expect((await board.list()).length).toBe(1);
  expect((await projects.list())[0]!.cardRules).toBeUndefined();
  expect(await workstreams.get(ws.id)).toEqual(ws);
});

test("apply writes key, round, pr and workstreamId on existing cards, the rules on every project, the cursor and the schedule", async () => {
  const { board, projects, workstreams, project, ws, deps } = await setup();
  const a = await board.create(base);
  const b = await board.create({ ...base, title: "b", pr: { number: 7, url: "u", head: "h" } });
  const body = { registry: jsonl([{ key: "A1", cardId: a.id, pr: PR, round: 2 }, { key: "B1", cardId: b.id, sha: SHA }]), rules: { cardRules: "Rules." }, channelCursor: "3", schedule: [{ cron: "0 9 * * *", timezone: "UTC" }] };
  const r = await importWorkstream(ws, body, false, deps);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.plan.dryRun).toBe(false);
  expect(await board.get(a.id)).toMatchObject({ key: "A1", round: 2, pr: PR, workstreamId: ws.id });
  // A sha without a pr lands on the card's own pr; a card's round is kept when the item has none.
  expect(await board.get(b.id)).toMatchObject({ key: "B1", pr: { number: 7, url: "u", head: "h", reviewedSha: SHA }, workstreamId: ws.id });
  expect((await board.get(b.id))!.round).toBeUndefined();
  expect((await projects.list()).find((p) => p.id === project.id)).toMatchObject({ cardRules: "Rules." });
  expect(await workstreams.get(ws.id)).toMatchObject({ channelCursor: "3", digests: [{ cron: "0 9 * * *", timezone: "UTC" }] });
  expect((await board.list()).length).toBe(2);

  // Re-importing the same registry is a no-op, and re-keying two cards at once is not a collision.
  expect((await importWorkstream(ws, { registry: body.registry }, false, deps)).ok).toBe(true);
  const swapped = await importWorkstream(ws, { registry: jsonl([{ key: "B1", cardId: a.id }, { key: "A1", cardId: b.id }]) }, false, deps);
  expect(swapped.ok).toBe(true);
  expect((await board.get(a.id))!.key).toBe("B1");
  expect((await board.get(b.id))!.key).toBe("A1");
});

test("refusals: a key held by another card of the workstream, a card of another workstream, bad rules, bad schedule, unknown fields; nothing is written", async () => {
  const { board, workstreams, ws, deps } = await setup();
  const other = await workstreams.create({ name: "other", projects: [] });
  const held = await board.create({ ...base, key: "A1", workstreamId: ws.id });
  const free = await board.create(base);
  const foreign = await board.create({ ...base, workstreamId: other.id });
  const bad: [unknown, RegExp][] = [
    [{ registry: jsonl([{ key: "A1", cardId: free.id }]) }, new RegExp(`key "A1".*${held.id}`)],
    [{ registry: jsonl([{ key: "F1", cardId: foreign.id }]) }, new RegExp(`${foreign.id}.*workstream ${other.id}`)],
    [{ registry: jsonl([{ key: "X" }]), rules: { cardRules: 3 } }, /cardRules/],
    [{ registry: jsonl([{ key: "X" }]), rules: { cardTemplates: { bogus: "t" } } }, /bogus/],
    [{ registry: jsonl([{ key: "X" }]), rules: { other: 1 } }, /rules.*other/],
    [{ registry: jsonl([{ key: "X" }]), schedule: { cron: "bad", timezone: "UTC" } }, /cron/],
    [{ registry: jsonl([{ key: "X" }]), channelCursor: 5 }, /channelCursor/],
    [{ registry: jsonl([{ key: "X" }]), nope: 1 }, /unknown field nope/],
    [{}, /registry/],
    [null, /object/],
  ];
  for (const [body, re] of bad) {
    const r = await importWorkstream(ws, body, false, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(re);
  }
  expect((await board.get(free.id))!.key).toBeUndefined();
  expect(await workstreams.get(ws.id)).toEqual(ws);
  // Rules need a project to land on.
  const empty = await importWorkstream(other, { registry: jsonl([{ key: "X" }]), rules: { cardRules: "r" } }, false, deps);
  expect(empty).toMatchObject({ ok: false, error: expect.stringContaining("no project") });
});

test("API: POST /workstreams/:id/import, ?dryRun=1 plans only, 400 on refusal, 404 on an unknown workstream", async () => {
  const { app, board, ws } = await setup();
  const card = await board.create(base);
  const body = { registry: jsonl([{ key: "A1", cardId: card.id, pr: PR }]), channelCursor: "9" };
  const dry = await app(req(`/workstreams/${ws.id}/import?dryRun=1`, "POST", body));
  expect(dry.status).toBe(200);
  expect(await dry.json()).toMatchObject({ dryRun: true, cards: [{ cardId: card.id, key: "A1", pr: PR }], channelCursor: "9" });
  expect((await board.get(card.id))!.key).toBeUndefined();

  const applied = await app(req(`/workstreams/${ws.id}/import`, "POST", body));
  expect(applied.status).toBe(200);
  expect(await applied.json()).toMatchObject({ dryRun: false });
  expect(await board.get(card.id)).toMatchObject({ key: "A1", pr: PR, workstreamId: ws.id });
  expect(((await (await app(req(`/workstreams/${ws.id}`))).json()) as Workstream).channelCursor).toBe("9");

  const refused = await app(req(`/workstreams/${ws.id}/import`, "POST", { registry: "nope" }));
  expect(refused.status).toBe(400);
  expect(await refused.json()).toMatchObject({ error: expect.stringContaining("line 1") });
  expect((await app(req("/workstreams/nope/import", "POST", body))).status).toBe(404);
});
