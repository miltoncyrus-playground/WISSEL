import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { Router } from "../src/core/router.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { Orchestrator, resolveLiveTip } from "../src/core/orchestrator.ts";
import { runViaBun, type CommandRunner } from "../src/executors/claude-cli.ts";
import { cardFilesError, describeCondition, findOverlaps, overlapWarning, StartConditionChecker, startConditionsError } from "../src/services/start-conditions.ts";
import type { AgentDef, Executor, StartCondition, TaskCard } from "../src/core/types.ts";

// docs/SDD-coordinator.md §4.8, phase 2 card 11: start conditions the
// sweep waits on, and a warning when two open cards (or a card and an
// open PR) name the same files.

const exists = async (id: string) => id === "known";

describe("validation", () => {
  test("each kind is checked; a card-done must name a real card; unknown kinds and extra fields are refused", async () => {
    expect(await startConditionsError([{ kind: "card-done", cardId: "known" }, { kind: "pr-merged", repo: "o/r", number: 4 }, { kind: "path-on-main", repo: "/repo", path: "src/a.ts" }], exists)).toBeUndefined();
    expect(await startConditionsError([{ kind: "card-done", cardId: "nope" }], exists)).toContain("names no card");
    expect(await startConditionsError([{ kind: "pr-merged", repo: "https://github.com/o/r", number: 4 }], exists)).toContain("org/repo");
    expect(await startConditionsError([{ kind: "pr-merged", repo: "o/r", number: 0 }], exists)).toContain("positive");
    expect(await startConditionsError([{ kind: "path-on-main", repo: "/repo", path: "../etc" }], exists)).toContain("relative");
    expect(await startConditionsError([{ kind: "card-done", cardId: "known", extra: 1 }], exists)).toContain("only cardId");
    expect(await startConditionsError([{ kind: "time" }], exists)).toContain("unknown waitsFor kind");
    expect(cardFilesError(["src/a.ts", "docs/"])).toBeUndefined();
    expect(cardFilesError(["/abs"])).toContain("relative");
  });
});

describe("the checker", () => {
  const byId = (cards: TaskCard[]) => new Map(cards.map((c) => [c.id, c]));
  const card = (id: string, status: TaskCard["status"], over: Partial<TaskCard> = {}): TaskCard => ({ id, title: id, body: "", labels: [], status, ...over });

  test("card-done follows a replaced card to its live re-attempt", async () => {
    const checker = new StartConditionChecker({ runner: runViaBun });
    const map = byId([card("a", "failed", { supersededBy: "b" }), card("b", "done")]);
    const tip = (t: TaskCard | undefined) => resolveLiveTip(t, map);
    expect(await checker.firstUnmet([{ kind: "card-done", cardId: "a" }], map, tip)).toBeUndefined();
    const open = byId([card("a", "running")]);
    expect(await checker.firstUnmet([{ kind: "card-done", cardId: "a" }], open, (t) => resolveLiveTip(t, open))).toEqual({ kind: "card-done", cardId: "a" });
  });

  test("pr-merged asks gh once a minute until merged, then keeps the answer; a failing gh is not met", async () => {
    let state = "OPEN";
    let now = 0;
    const calls: string[][] = [];
    const runner: CommandRunner = async (cmd) => (calls.push(cmd), state === "fail" ? { stdout: "", stderr: "no", exitCode: 1 } : { stdout: JSON.stringify({ state }), stderr: "", exitCode: 0 });
    const checker = new StartConditionChecker({ runner, now: () => now });
    const c: StartCondition = { kind: "pr-merged", repo: "o/r", number: 7 };
    const none = new Map<string, TaskCard>();
    expect(await checker.firstUnmet([c], none, () => undefined)).toEqual(c);
    expect(await checker.firstUnmet([c], none, () => undefined)).toEqual(c);
    expect(calls).toEqual([["gh", "pr", "view", "7", "--repo", "o/r", "--json", "state"]]);
    state = "MERGED";
    now = 61_000;
    expect(await checker.firstUnmet([c], none, () => undefined)).toBeUndefined();
    state = "fail";
    now = 999_000;
    expect(await checker.firstUnmet([c], none, () => undefined)).toBeUndefined();
    expect(calls).toHaveLength(2);
    const fresh = new StartConditionChecker({ runner, now: () => now });
    expect(await fresh.firstUnmet([c], none, () => undefined)).toEqual(c);
  });

  test("path-on-main reads the checkout's main branch (real git)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wissel-conditions-"));
    try {
      const g = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } });
      g(["init", "-q", "-b", "main"]);
      writeFileSync(join(dir, "schema.sql"), "x\n");
      g(["add", "--", "schema.sql"]);
      g(["commit", "-q", "-m", "x"]);
      const checker = new StartConditionChecker({ runner: runViaBun, cacheMs: 0 });
      const none = new Map<string, TaskCard>();
      expect(await checker.firstUnmet([{ kind: "path-on-main", repo: dir, path: "schema.sql" }], none, () => undefined)).toBeUndefined();
      expect(await checker.firstUnmet([{ kind: "path-on-main", repo: dir, path: "missing.sql" }], none, () => undefined)).toMatchObject({ path: "missing.sql" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("describeCondition reads as a sentence fragment", () => {
    expect(describeCondition({ kind: "pr-merged", repo: "o/r", number: 7 })).toBe("o/r#7 merged");
    expect(describeCondition({ kind: "card-done", cardId: "1234567890" })).toBe("card 12345678 done");
  });
});

describe("the sweep", () => {
  test("a card waits on its conditions and starts once they hold", async () => {
    const agent: AgentDef = { id: "reader", name: "reader", kind: "agent", tier: "readonly", description: "t", whenToUse: "t", tags: ["intake"], executor: "readonly", inputs: [], outputs: [], trustLevel: "low", toolAccess: ["read"], costProfile: { model: "claude-sonnet-5-5", estUsdPerTask: 0.01 } };
    const ran: string[] = [];
    const exec: Executor = { id: "fake", canHandle: () => true, run: async (t, a) => (ran.push(t.title), { taskId: t.id, agentId: a.id, ok: true, summary: "ok" }) };
    const board = new SqliteBoard();
    const registry = Registry.from([agent]);
    const checker = new StartConditionChecker({ runner: runViaBun });
    const orch = new Orchestrator(board, registry, new Router(registry), [exec], undefined, {
      startConditions: async (task, byId) => {
        const unmet = await checker.firstUnmet(task.waitsFor ?? [], byId, (t) => resolveLiveTip(t, byId));
        return unmet ? describeCondition(unmet) : undefined;
      },
    });
    const first = await board.create({ title: "schema", body: "", labels: [], repo: "r" });
    await board.move(first.id, "review");
    await board.create({ title: "after", body: "", labels: ["intake"], repo: "r", waitsFor: [{ kind: "card-done", cardId: first.id }] });
    await orch.sweep();
    expect(ran).toEqual([]);
    await board.move(first.id, "done");
    await orch.sweep();
    expect(ran).toEqual(["after"]);
  });
});

describe("overlap", () => {
  const base = (id: string, over: Partial<TaskCard>): TaskCard => ({ id, title: id, body: "", labels: [], status: "inbox", repo: "/r", ...over });

  test("same file or a directory holding it, in the same repo, on an open card or an open PR; not its own lineage, not a finished card", () => {
    const me = base("me", { files: ["src/importer/retry.ts"] });
    const all = [
      me,
      base("dir", { files: ["src/importer/"], key: "B2" }),
      base("other-repo", { repo: "/s", files: ["src/importer/retry.ts"] }),
      base("done", { status: "done", files: ["src/importer/retry.ts"] }),
      base("open-pr", { status: "done", files: ["src/importer/retry.ts"], pr: { number: 3, url: "https://x/pull/3", head: "a".repeat(40) } }),
      base("merged-pr", { status: "done", files: ["src/importer/retry.ts"], pr: { number: 4, url: "https://x/pull/4", head: "a".repeat(40), watch: { lifecycle: "merged" } as never } }),
      base("review-of-me", { reviewLineageId: "me", files: ["src/importer/retry.ts"] }),
      base("elsewhere", { files: ["docs/x.md"] }),
    ];
    expect(findOverlaps(me, all).map((o) => [o.id, o.via])).toEqual([
      ["dir", "card"],
      ["open-pr", "pr"],
    ]);
    expect(overlapWarning(me, findOverlaps(me, all))).toBe('"me" touches the same files as B2 "dir" on src/importer/; "open-pr" (open PR) on src/importer/retry.ts');
    expect(findOverlaps(base("x", {}), all)).toEqual([]);
  });

  test("POST /tasks says which open cards name the same files, and still creates the card", async () => {
    const board = new SqliteBoard();
    const app = createApp(board, Registry.from([]), undefined, { harnesses: HarnessPool.from([]) });
    const post = (body: object) => app(new Request("http://x/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "", labels: [], repo: "/r", ...body }) }));
    await post({ title: "first", files: ["src/a.ts"] });
    const res = await post({ title: "second", files: ["src/a.ts", "src/b.ts"] });
    expect(res.status).toBe(201);
    const card = (await res.json()) as { overlaps?: Array<{ id: string; title: string; via: string; files: string[] }> };
    expect(card.overlaps).toEqual([{ id: expect.any(String), title: "first", via: "card", files: ["src/a.ts"] }]);
    const bad = await post({ title: "third", waitsFor: [{ kind: "card-done", cardId: "nope" }] });
    expect(bad.status).toBe(400);
  });
});
