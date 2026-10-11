import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wisselRetroPodcastDraft } from "../pipeline-editor/src/templates.ts";
import { createApp } from "../src/api/server.ts";
import { Registry, validatePersona } from "../src/core/registry.ts";
import type { AgentDef } from "../src/core/types.ts";
import { runViaBun, type CommandRunner } from "../src/executors/claude-cli.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { SqlitePipelineStore } from "../src/services/pipelines.ts";
import { addDays, computeStreak, localDay, mergeDays, readStreak, STREAK_LOOKBACK_DAYS } from "../src/services/streaks.ts";
import { assertReadOnlyGit, buildWisselDigest } from "../src/services/wissel-digest.ts";
import {
  buildWrapped,
  firstLearning,
  latestLesson,
  pipelinesAddedIn,
  WRAPPED_PERIOD_MAX_CHARS,
  wrappedDigestInputs,
  type WrappedDeps,
} from "../src/services/wrapped.ts";

// docs/SDD-wissel-app.md §3.6 (card 6): streaks from merge commits,
// GET /wrapped built on the digest, and agent personas in the manifest.

const DAY = 24 * 60 * 60 * 1000;

// ---- streaks, pure ----------------------------------------------------------

describe("computeStreak", () => {
  // 23:00 local today, so every "earlier today" merge is in the past.
  const now = new Date(2026, 9, 11, 23, 0);
  const today = localDay(now.getTime());
  const back = (n: number) => addDays(today, -n);

  test("addDays steps calendar days, across month, year and DST changes", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    // EU and US DST changes: still exactly one day each.
    expect(addDays("2026-03-29", 1)).toBe("2026-03-30");
    expect(addDays("2026-10-25", -1)).toBe("2026-10-24");
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
  });

  test("a run ending today counts today", () => {
    expect(computeStreak([today, back(1), back(2)], now)).toMatchObject({ current: 3, best: 3, today: true, lastDay: today });
  });

  test("no merge yet today keeps yesterday's run alive", () => {
    expect(computeStreak([back(1), back(2)], now)).toMatchObject({ current: 2, today: false, lastDay: back(1) });
  });

  test("a gap of a whole day ends it; best remembers the longest run", () => {
    const s = computeStreak([back(2), back(3), back(10), back(11), back(12), back(13)], now);
    expect(s).toMatchObject({ current: 0, best: 4, today: false, lastDay: back(2) });
  });

  test("nothing merged: all zero, an empty week", () => {
    expect(computeStreak([], now)).toEqual({ current: 0, best: 0, today: false, lastDay: null, week: [false, false, false, false, false, false, false] });
  });

  test("the week is the last 7 days, oldest first; duplicates and future days don't count", () => {
    const s = computeStreak([today, today, back(6), back(7), addDays(today, 1)], now);
    expect(s.week).toEqual([true, false, false, false, false, false, true]);
    expect(s).toMatchObject({ current: 1, best: 2, lastDay: today });
  });
});

// ---- a git + board world ----------------------------------------------------

function git(args: string[], cwd: string, date?: Date): string {
  const env = date ? { ...process.env, GIT_AUTHOR_DATE: date.toISOString(), GIT_COMMITTER_DATE: date.toISOString() } : process.env;
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString("utf8")}`);
  return r.stdout.toString("utf8").trim();
}

/** A card's branch with one commit, merged --no-ff the way
 *  mergeTaskWorktree lands it, both dated `at`. */
function land(dir: string, branch: string, message: string, at: Date): void {
  git(["checkout", "-q", "-b", branch], dir);
  writeFileSync(join(dir, `${branch.replace(/\W/g, "_")}.txt`), branch);
  git(["add", "."], dir);
  git(["commit", "-q", "-m", `work on ${branch}`], dir, at);
  git(["checkout", "-q", "main"], dir);
  git(["merge", "-q", "--no-ff", branch, "-m", message], dir, at);
}

function recording(): { runner: CommandRunner; cmds: string[][] } {
  const cmds: string[][] = [];
  return { cmds, runner: (cmd, opts) => (cmds.push(cmd), runViaBun(cmd, opts)) };
}

function handoffSummary(data: Record<string, unknown>): string {
  return `done\n\n\`\`\`pipeline-handoff\n${JSON.stringify({ data })}\n\`\`\``;
}

interface World {
  dir: string;
  repo: string;
  board: SqliteBoard;
  pipelines: SqlitePipelineStore;
  now: Date;
  telemetryPath: string;
  deps(runner?: CommandRunner): WrappedDeps;
}

let world: World;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-wrapped-"));
  const repo = join(dir, "wissel");
  const wt = join(dir, "worktrees");
  // 23:00 local today: merges at noon today are in the window.
  const n = new Date();
  const now = new Date(n.getFullYear(), n.getMonth(), n.getDate(), 23, 0);
  const noon = (daysBack: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() - daysBack);
    d.setHours(12, 0, 0, 0);
    return d;
  };
  const board = new SqliteBoard();
  const pipelines = new SqlitePipelineStore(board.db);

  mkdirSync(repo, { recursive: true });
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "wissel-test@example.com"], repo);
  git(["config", "user.name", "wissel test"], repo);
  writeFileSync(join(repo, "a.txt"), "start\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "start"], repo, noon(40));

  // Cards landed today, 1 and 2 days ago (a 3-day streak), two on the
  // same day 20 days ago and one 21 days ago (2 days), and 30 to 33
  // days ago (a 4-day best).
  // Oldest first, as real history is: `git log --since` stops walking at
  // the first commit older than the window.
  const landedDays = [33, 32, 31, 30, 21, 20, 20, 2, 1, 0];
  for (const [i, days] of landedDays.entries()) {
    const c = await board.create({ title: `Card ${i}`, body: "", labels: [], repo });
    await board.move(c.id, "done");
    land(repo, `wissel/${c.id}`, `Merge wissel/${c.id}: Card ${i}`, noon(days));
    // A plain branch merge 1 day ago: a merge, but not a card.
    if (days === 1) land(repo, "feature", "Merge branch 'feature'", noon(1));
  }
  // A card whose worktree points inside the worktrees root: git must
  // never run there, only in the real repo.
  await board.create({ title: "In a worktree", body: "", labels: [], repo: join(wt, "abc") });

  const telemetryPath = join(dir, "telemetry.jsonl");
  const ev = (o: Record<string, unknown>) => JSON.stringify(o);
  const at = (days: number) => new Date(now.getTime() - days * DAY).toISOString();
  writeFileSync(
    telemetryPath,
    [
      ev({ type: "result", taskId: "t1", agentId: "implementer", actualCost: 1.25, harnessId: "claude", at: at(1) }),
      ev({ type: "result", taskId: "t2", agentId: "implementer", actualCost: 0.75, harnessId: "claude", at: at(2) }),
      ev({ type: "result", taskId: "t3", agentId: "reviewer", actualCost: 0.5, harnessId: "claude", at: at(2) }),
      ev({ type: "result", taskId: "t4", agentId: "podcast-audio", actualCost: 0, at: at(1) }),
      ev({ type: "result", taskId: "t4", agentId: "podcast-audio", actualCost: 0, at: at(3) }),
      ev({ type: "result", taskId: "t4", agentId: "podcast-audio", actualCost: 0, at: at(4) }),
      ev({ type: "result", taskId: "t5", agentId: "implementer", retryAfter: at(0), at: at(1) }),
      ev({ type: "result", taskId: "t6", agentId: "planner", actualCost: 4, harnessId: "claude", at: at(20) }),
    ].join("\n") + "\n",
  );

  world = {
    dir,
    repo,
    board,
    pipelines,
    now,
    telemetryPath,
    deps: (runner = runViaBun) => ({ board, pipelines, telemetryPath, runner, worktreesRoot: wt, agentModel: () => "claude-opus-5-5" }),
  };
});

afterAll(async () => {
  await rm(world.dir, { recursive: true, force: true });
});

describe("streak from git", () => {
  test("the local days with a wissel merge, only through read-only git, never in a worktree", async () => {
    const { runner, cmds } = recording();
    const days = await mergeDays({ cards: await world.board.list(), runner, now: world.now, worktreesRoot: join(world.dir, "worktrees") });
    const today = localDay(world.now.getTime());
    expect([...days].sort()).toEqual([0, 1, 2, 20, 21, 30, 31, 32, 33].map((n) => addDays(today, -n)).sort());
    expect(cmds.length).toBe(1);
    for (const cmd of cmds) {
      expect(() => assertReadOnlyGit(cmd)).not.toThrow();
      expect(cmd.slice(0, 5)).toEqual(["git", "-C", world.repo, "log", "--merges"]);
    }
  });

  test("current 3 (today and the two days before), best 4", async () => {
    const s = await readStreak({ cards: await world.board.list(), runner: runViaBun, now: world.now, worktreesRoot: join(world.dir, "worktrees") });
    expect(s).toMatchObject({ current: 3, best: 4, today: true, lastDay: localDay(world.now.getTime()) });
    expect(s.week).toEqual([false, false, false, false, true, true, true]);
  });

  test("the lookback is a year", () => {
    expect(STREAK_LOOKBACK_DAYS).toBe(366);
  });
});

// ---- Wrapped equals the digest ---------------------------------------------

describe("GET /wrapped's numbers", () => {
  for (const period of ["last 7 days", "last 30 days", "since 2020-01-01", "nonsense"]) {
    test(`equal the digest's for the same period: ${period}`, async () => {
      const w = await buildWrapped(world.deps(), period, world.now);
      const d = await buildWisselDigest(wrappedDigestInputs(world.deps(), period, world.now));
      expect(w.period).toEqual({ input: period, ...d.period });
      expect(w.cardsMerged).toBe(d.stats.merges);
      expect(w.commits).toBe(d.stats.commits);
      expect(w.agentRuns).toBe(d.stats.agentRuns);
      expect(w.spendUsd).toBe(d.stats.spendUsd);
      expect(w.topAgent).toEqual(d.stats.topAgent);
      // The retrospective's own digest (with lessons and docs) has the same stats.
      const full = await buildWisselDigest({ ...wrappedDigestInputs(world.deps(), period, world.now), lessonsPath: join(world.dir, "none.md"), docsDir: join(world.repo, "docs") });
      expect(full.stats).toEqual(d.stats);
    });
  }

  test("the last 7 days, by hand: 3 cards merged, 4 commits, 6 runs, $2.50, implementer on top", async () => {
    const w = await buildWrapped(world.deps(), "last 7 days", world.now);
    expect(w).toMatchObject({
      cardsMerged: 3,
      // The three cards' own commits and the feature branch's.
      commits: 4,
      agentRuns: 6,
      spendUsd: 2.5,
      topAgent: { id: "implementer", runs: 2, spendUsd: 2 },
      streak: { current: 3, best: 4 },
      pipelinesAdded: [],
      lesson: null,
    });
    expect(w.period.days).toBe(7);
  });

  test("the last 30 days take in the merges 20 and 21 days ago and the planner's run", async () => {
    const w = await buildWrapped(world.deps(), "last 30 days", world.now);
    expect(w).toMatchObject({ cardsMerged: 6, agentRuns: 7, spendUsd: 6.5, topAgent: { id: "implementer", runs: 2, spendUsd: 2 } });
  });
});

// ---- pipelines added and the lesson of the week -----------------------------

test("pipelinesAddedIn: created within the period, oldest first", () => {
  const from = new Date("2026-10-04T00:00:00Z");
  const to = new Date("2026-10-11T00:00:00Z");
  const defs = [
    { id: "b", name: "B", createdAt: "2026-10-09T00:00:00Z" },
    { id: "old", name: "Old", createdAt: "2026-09-01T00:00:00Z" },
    { id: "a", name: "A", createdAt: "2026-10-05T00:00:00Z" },
    { id: "future", name: "Future", createdAt: "2026-10-12T00:00:00Z" },
    { id: "bad", name: "Bad", createdAt: "" },
  ];
  expect(pipelinesAddedIn(defs, from, to)).toEqual([
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ]);
});

test("firstLearning: the first `learnings` item with a title, capped; null without one", () => {
  const stories = [
    { group: "done", title: "Built it", explanation: "x" },
    { group: "learnings", title: "  ", explanation: "blank title, skipped" },
    { group: "learnings", title: "Test the real path", explanation: "You learned it.  Twice.", date: "2026-10-10" },
    { group: "learnings", title: "Second", explanation: "y" },
  ];
  expect(firstLearning({ stories }, "run-1")).toEqual({ title: "Test the real path", text: "You learned it. Twice.", runId: "run-1", date: "2026-10-10" });
  expect(firstLearning({ stories: [{ group: "learnings", title: "No text", date: "soon" }] }, "r")).toEqual({ title: "No text", text: "", runId: "r" });
  expect(firstLearning({ stories: [{ group: "done", title: "x" }] }, "r")).toBeNull();
  expect(firstLearning({ nope: 1 }, "r")).toBeNull();
  expect(firstLearning(undefined, "r")).toBeNull();
  expect(firstLearning({ stories: [{ group: "learnings", title: "t".repeat(500) }] }, "r")!.title.length).toBeLessThanOrEqual(200);
});

test("latestLesson: the newest retro run with an analysis wins; a newer run still collecting doesn't hide it", async () => {
  const board = new SqliteBoard();
  const pipelines = new SqlitePipelineStore(board.db);
  expect(await latestLesson(board, pipelines, await board.list())).toBeNull();
  const def = await pipelines.create(wisselRetroPodcastDraft());

  const retroRun = async (lesson: string | null) => {
    const root = await board.create({ title: `Pipeline: ${def.name}`, body: "last 7 days", labels: [], pipelineId: def.id });
    if (lesson !== null) {
      const step = await board.create({ title: "Analyse", body: "", labels: [], pipelineId: def.id, pipelineRunId: root.id, pipelineStepId: "analyse" });
      const stories = [{ group: "done", title: "Shipped" }, ...(lesson ? [{ group: "learnings", title: lesson, explanation: "Because." }] : [])];
      await board.recordResult({ taskId: step.id, agentId: "wissel-retro-analyst", ok: true, summary: handoffSummary({ stories }) });
    }
    return root;
  };

  await retroRun("Old lesson");
  const second = await retroRun("New lesson");
  await retroRun(null); // still collecting: no analysis yet
  expect(await latestLesson(board, pipelines, await board.list())).toEqual({ title: "New lesson", text: "Because.", runId: second.id });

  // The latest analysed run had no learnings: none, not an older one.
  await retroRun("");
  expect(await latestLesson(board, pipelines, await board.list())).toBeNull();
});

// ---- the route --------------------------------------------------------------

const registry = await Registry.load();

describe("GET /wrapped", () => {

  test("answers the period's Wrapped, the last 7 days by default, through read-only git only", async () => {
    const { runner, cmds } = recording();
    const app = createApp(world.board, registry, undefined, { pipelines: world.pipelines, commandRunner: runner });
    const res = await app(new Request("http://x/wrapped"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.period).toMatchObject({ input: "last 7 days", days: 7 });
    expect(Object.keys(body).sort()).toEqual(["agentRuns", "cardsMerged", "commits", "lesson", "period", "pipelinesAdded", "spendUsd", "streak", "topAgent"]);
    // The route uses the real clock: today's noon merge may not have happened yet.
    expect(body.cardsMerged).toBeGreaterThanOrEqual(2);
    for (const cmd of cmds) expect(() => assertReadOnlyGit(cmd)).not.toThrow();

    const month = (await (await app(new Request(`http://x/wrapped?period=${encodeURIComponent("last 30 days")}`))).json()) as { period: { days: number } };
    expect(month.period.days).toBe(30);
  });

  test("a period text over the cap is a 400", async () => {
    const app = createApp(new SqliteBoard(), registry);
    const res = await app(new Request(`http://x/wrapped?period=${"x".repeat(WRAPPED_PERIOD_MAX_CHARS + 1)}`));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("at most");
  });

  test("an empty board is all zeros, no streak, no lesson", async () => {
    const app = createApp(new SqliteBoard(), registry, undefined, { commandRunner: recording().runner });
    const body = await (await app(new Request("http://x/wrapped"))).json();
    expect(body).toMatchObject({ cardsMerged: 0, commits: 0, agentRuns: 0, spendUsd: 0, topAgent: null, pipelinesAdded: [], lesson: null, streak: { current: 0, best: 0 } });
  });
});

// ---- personas in the manifest ----------------------------------------------

describe("persona", () => {
  test("validatePersona: color #RRGGBB and a glyph of one or two characters, either optional", () => {
    for (const ok of [undefined, {}, { color: "#C8F25A" }, { glyph: "Im" }, { glyph: "W" }, { glyph: "🦉" }, { color: "#abcdef", glyph: "Rv" }]) expect(validatePersona(ok), JSON.stringify(ok)).toBeNull();
    for (const bad of [null, "lime", [], { color: "lime" }, { color: "#abc" }, { glyph: "" }, { glyph: "Abc" }, { glyph: "a b" }, { glyph: 7 }, { colour: "#000000" }]) {
      expect(validatePersona(bad), JSON.stringify(bad)).not.toBeNull();
    }
  });

  test("the registry refuses a malformed persona at load", () => {
    const agent = { id: "x", name: "X", kind: "agent", tier: "readonly", description: "", whenToUse: "", tags: [], executor: "readonly", inputs: [], outputs: [], costProfile: { model: "m", estUsdPerTask: 0 }, trustLevel: "low", toolAccess: [] } as unknown as AgentDef;
    expect(() => Registry.from([{ ...agent, persona: { color: "red" } }])).toThrow(/agent "x": persona.color/);
    expect(Registry.from([{ ...agent, persona: { color: "#FF0000" } }]).get("x")!.persona).toEqual({ color: "#FF0000" });
  });

  test("the real manifest loads, and the agents that set one are served by GET /agents", async () => {
    const withPersona = registry.all().filter((a) => a.persona);
    expect(withPersona.map((a) => a.id).sort()).toEqual(["concierge", "implementer", "planner", "reviewer"]);
    const app = createApp(new SqliteBoard(), registry);
    const agents = (await (await app(new Request("http://x/agents"))).json()) as AgentDef[];
    expect(agents.find((a) => a.id === "implementer")!.persona).toEqual({ color: "#C8F25A", glyph: "Im" });
  });
});
