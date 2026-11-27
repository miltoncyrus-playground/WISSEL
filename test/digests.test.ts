import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { buildDigest, digestDue, DigestRuns, dueDigests } from "../src/services/digests.ts";
import type { ChatAdapter } from "../src/services/tracker-rules.ts";
import type { TaskCard } from "../src/core/types.ts";
import type { Workstream } from "../src/services/workstreams.ts";
import type { OwnerTask } from "../src/services/owner-tasks.ts";

// docs/SDD-coordinator.md §4.11, phase 3 card 19: a digest is a fixed
// template from Wissel's own data, no model call, sent when its cron
// comes round, through the gate.

const NOW = new Date("2026-11-28T09:00:00Z");
const ws: Workstream = { id: "ws1", name: "Checkout", ticket: "SHOP-12", projects: [{ projectId: "p1", role: "follow", decider: "Dana", decideAlone: [], mustAsk: [], never: [] }], digests: [{ cron: "0 9 * * *", timezone: "UTC" }], createdAt: "x" };
const card = (id: string, over: Partial<TaskCard>): TaskCard => ({ id, title: id, body: "", labels: [], status: "inbox", workstreamId: "ws1", ...over });
const task = (title: string): OwnerTask => ({ id: title, title, why: "", steps: [], blocks: [], status: "open", cardId: "c", createdAt: "x" });

describe("the digest", () => {
  test("cards against the cap, PRs by state, what waits on the decider, owner tasks, quiet-hours queue and the host", () => {
    const text = buildDigest({
      ws,
      cards: [
        card("a", { status: "running" }),
        card("b", { status: "review" }),
        card("c", { status: "done", pr: { number: 1, url: "u", head: "h", watch: { lifecycle: "merged" } as never } }),
        card("d", { status: "done", pr: { number: 2, url: "u", head: "h" } }),
        card("x", { workstreamId: "other", status: "running" }),
        card("dec", { labels: ["decision"], status: "running" }),
      ],
      ownerTasks: [task("Wissel asks Dana: card.start"), task("Rotate the key")],
      queued: 2,
      cap: 4,
      host: { load1: 1.5, cores: 4, memoryFreePct: 42, disk: [{ path: "/home/x/.wissel", freeGb: 78, temp: false }] },
      now: NOW,
    });
    expect(text).toBe(
      [
        "Digest for Checkout (SHOP-12), 2026-11-28 09:00 UTC",
        "Cards: 2 live cards against a cap of 4; 1 running, 1 waiting on review or a decision.",
        "PRs: 1 open, 0 ready, 1 merged, 0 closed.",
        "Waiting on Dana: card.start.",
        "Owner tasks open: Rotate the key.",
        "Held for quiet hours: 2 actions.",
        "Host: load 1.5 on 4 cores, 42% memory free, 78 GB free under /home/x/.wissel.",
      ].join("\n"),
    );
  });

  test("due when its cron came round since the last run, or since watching began; never a backlog", () => {
    const since = new Date("2026-11-28T08:00:00Z");
    expect(digestDue("0 9 * * *", "UTC", undefined, since, NOW)).toBe(true);
    expect(digestDue("0 9 * * *", "UTC", NOW, since, new Date("2026-11-28T09:30:00Z"))).toBe(false);
    expect(digestDue("0 9 * * *", "UTC", undefined, new Date("2026-11-28T09:01:00Z"), new Date("2026-11-28T09:30:00Z"))).toBe(false);
    const runs = new DigestRuns(new SqliteBoard().db);
    expect(dueDigests([ws], runs, since, NOW).map((d) => d.key)).toEqual(["ws1:0 9 * * *:UTC"]);
    runs.mark("ws1:0 9 * * *:UTC", NOW);
    expect(dueDigests([ws], runs, since, NOW)).toEqual([]);
  });
});

describe("in the app", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wissel-digest-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("preview it; send it to the workstream's chat through the gate; with neither chat nor channel there is nothing to send", async () => {
    const posted: string[] = [];
    const chat: ChatAdapter = { post: async (channel, text) => (posted.push(`${channel}: ${text.split("\n")[0]}`), { ts: "1" }) };
    const app = createApp(new SqliteBoard(), Registry.from([]), undefined, { harnesses: HarnessPool.from([]), chat });
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await app(new Request(`http://x${path}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }));
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    const repo = join(dir, "shop");
    mkdirSync(repo);
    Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
    const projectId = (await call("POST", "/projects/local", { path: repo })).body.id as string;
    const id = (await call("POST", "/workstreams", { name: "Checkout", projects: [{ projectId, role: "decide" }], chat: { adapter: "slack", channel: "slack:#team" } })).body.id as string;
    expect(((await call("GET", `/workstreams/${id}/digest`)).body.text as string).split("\n")[0]).toStartWith("Digest for Checkout, ");
    expect((await call("POST", `/workstreams/${id}/digest`)).body).toMatchObject({ status: "done" });
    expect(posted[0]).toStartWith("slack:#team: Digest for Checkout");
    const bare = (await call("POST", "/workstreams", { name: "Bare", projects: [] })).body.id as string;
    expect((await call("POST", `/workstreams/${bare}/digest`)).status).toBe(409);
  });
});
