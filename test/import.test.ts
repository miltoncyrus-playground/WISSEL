import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { importItems, parseItems } from "../src/services/import.ts";
import type { TaskCard, TaskPullRequest } from "../src/core/types.ts";
import type { Workstream } from "../src/services/workstreams.ts";

// docs/SDD-coordinator.md §7, phase 3 card 21: an existing coordinator's
// work items, rules, channel cursor and schedule come across; nothing is
// created; conflicts are reported, never overwritten.

const SHA = "b".repeat(40);
const ws: Workstream = { id: "ws1", name: "Checkout", projects: [], createdAt: "x" };
const card = (id: string, over: Partial<TaskCard>): TaskCard => ({ id, title: id, body: "", labels: [], status: "running", repo: "/r", ...over });

describe("items", () => {
  test("JSONL or a list; a bad line is reported with its number, the rest still read", () => {
    const { items, invalid } = parseItems(['{"key":"A4","pr":12,"sha":"' + SHA + '"}', "not json", '{"key":"has space"}', "", '{"key":"A5","round":0}', '{"key":"A6","cardId":"c6"}'].join("\n"));
    expect(items.map((i) => [i.line, i.key])).toEqual([
      [1, "A4"],
      [6, "A6"],
    ]);
    expect(invalid).toEqual([
      { line: 2, reason: "not JSON" },
      { line: 3, reason: "needs a key such as A4" },
      { line: 5, reason: "round must be a whole number from 1" },
    ]);
    expect(parseItems([{ key: "A7" }]).items).toHaveLength(1);
  });

  test("matched by card id or by key in the workstream; conflicts and misses are reported; nothing is created", async () => {
    const writes: string[] = [];
    const cards = [
      card("c1", { workstreamId: "ws1", key: "A4" }),
      card("c2", {}),
      card("c3", { workstreamId: "ws2" }),
      card("c4", { key: "OLD" }),
      card("c5", { workstreamId: "ws1", key: "A9", pr: { number: 3, url: "u", head: SHA } }),
    ];
    const deps = {
      cards,
      prUrlFor: async (_c: TaskCard, n: number) => `https://github.com/o/r/pull/${n}`,
      setKey: async (c: TaskCard, k: string) => void writes.push(`${c.id} key ${k}`),
      setRound: async (c: TaskCard, r: number) => void writes.push(`${c.id} round ${r}`),
      setPr: async (c: TaskCard, pr: TaskPullRequest) => void writes.push(`${c.id} pr #${pr.number} ${pr.url} ${pr.head.slice(0, 4)}`),
    };
    const { items } = parseItems([
      { key: "A4", pr: 12, sha: SHA, round: 2 },
      { key: "A5", cardId: "c2" },
      { key: "A6", cardId: "c3" },
      { key: "A7", cardId: "c4" },
      { key: "A9", pr: 8, sha: SHA },
      { key: "A1" },
      { key: "A4", cardId: "c2" },
      { key: "B1", cardId: "c2", pr: 5 },
    ]);
    const r = await importItems(ws, items, false, deps);
    expect(r.matched).toEqual([
      { key: "A4", cardId: "c1", set: ["round", "pr"] },
      { key: "A5", cardId: "c2", set: ["key"] },
    ]);
    expect(r.conflicts.map((c) => [c.key, c.reason])).toEqual([
      ["A6", "the card belongs to another workstream"],
      ["A7", "the card already has key OLD"],
      ["A9", "the card already has PR #3"],
      ["A4", 'key A4 is already used by "c1" in this workstream'],
      ["B1", "PR #5 needs the full head sha (sha)"],
    ]);
    expect(r.unmatched).toEqual([{ key: "A1", reason: "no live card in this workstream has this key; import creates nothing" }]);
    expect(writes).toEqual(["c1 round 2", `c1 pr #12 https://github.com/o/r/pull/12 bbbb`, "c2 key A5"]);

    const dry: string[] = [];
    await importItems(ws, parseItems([{ key: "A5", cardId: "c2" }]).items, true, { ...deps, setKey: async () => void dry.push("x") });
    expect(dry).toEqual([]);
  });
});

describe("POST /workstreams/:id/import", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wissel-import-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a dry run reports and changes nothing; the real one sets the cards, the project's rules and the schedule", async () => {
    const board = new SqliteBoard();
    const app = createApp(board, Registry.from([]), undefined, { harnesses: HarnessPool.from([]) });
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await app(new Request(`http://x${path}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }));
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    const repo = join(dir, "shop");
    mkdirSync(repo);
    Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
    const projectId = (await call("POST", "/projects/local", { path: repo })).body.id as string;
    const wsId = (await call("POST", "/workstreams", { name: "Checkout", projects: [{ projectId, role: "shadow" }] })).body.id as string;
    const existing = await board.create({ title: "Add retries", body: "", labels: [], repo });
    const body = {
      items: `{"key":"A4","cardId":"${existing.id}","pr":{"number":12,"url":"https://github.com/o/r/pull/12"},"sha":"${SHA}","round":3}\n{"key":"A5"}`,
      rules: { projectId, cardRules: "Stage explicit paths." },
      channelCursor: "blk-41",
      schedule: { digests: [{ cron: "0 9 * * 1-5", timezone: "Europe/Madrid" }] },
    };
    const dry = await call("POST", `/workstreams/${wsId}/import`, { ...body, dryRun: true });
    expect(dry.body).toMatchObject({ dryRun: true, matched: [{ key: "A4", set: ["key", "round", "pr"] }], unmatched: [{ key: "A5" }], rules: expect.stringContaining("would apply cardRules"), channelCursor: "would start after blk-41", schedule: "would set digests" });
    expect((await board.get(existing.id))!.key).toBeUndefined();

    const real = await call("POST", `/workstreams/${wsId}/import`, body);
    expect(real.body).toMatchObject({ dryRun: false, rules: expect.stringContaining("applied cardRules"), schedule: "set digests" });
    const after = (await board.get(existing.id))!;
    expect([after.key, after.workstreamId, after.round, after.pr]).toEqual(["A4", wsId, 3, { number: 12, url: "https://github.com/o/r/pull/12", head: SHA }]);
    expect(((await call("GET", `/workstreams/${wsId}`)).body.digests as unknown[]).length).toBe(1);
    const projects = (await call("GET", "/projects")).body as unknown as Array<{ id: string; cardRules?: string }>;
    expect(projects.find((p) => p.id === projectId)?.cardRules).toBe("Stage explicit paths.");
    expect((await board.list()).length).toBe(1);
  });
});
