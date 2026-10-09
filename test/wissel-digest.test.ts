import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskCard } from "../src/core/types.ts";
import { runViaBun, type CommandRunner } from "../src/executors/claude-cli.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { DIGEST_LIMITS, assertReadOnlyGit, buildWisselDigest, githubRepoUrl, parsePeriod, type DigestInputs } from "../src/services/wissel-digest.ts";

// docs/SDD-wissel-retro-podcast.md §3.1, gate tests from §4: an in-memory
// board, temp git repos and a telemetry fixture.

const DAY = 24 * 60 * 60 * 1000;

describe("parsePeriod", () => {
  const now = new Date("2026-10-10T12:00:00Z");
  const p = (input: string) => {
    const r = parsePeriod(input, now);
    return { from: r.from.toISOString(), days: r.days };
  };

  test("default is the last 7 days back from now", () => {
    expect(p("")).toEqual({ from: "2026-10-03T12:00:00.000Z", days: 7 });
  });

  test("`last N days` anywhere in the input, any case", () => {
    expect(p("last 30 days")).toEqual({ from: "2026-09-10T12:00:00.000Z", days: 30 });
    expect(p("Give me the LAST 1 DAY please")).toEqual({ from: "2026-10-09T12:00:00.000Z", days: 1 });
  });

  test("`since YYYY-MM-DD` counts from midnight UTC of that day", () => {
    expect(p("since 2026-10-01")).toEqual({ from: "2026-10-01T00:00:00.000Z", days: 10 });
  });

  test("garbage, zero, too long, a future date or an impossible date fall back to 7 days", () => {
    for (const input of ["whatever", "last week", "last 0 days", "last 9999 days", "since 2026-12-01", "since 2026-02-30", "since yesterday"]) {
      expect(p(input), input).toEqual({ from: "2026-10-03T12:00:00.000Z", days: 7 });
    }
  });

  test("a `since` older than the cap is clamped to the cap", () => {
    expect(p("since 2020-01-01").days).toBe(DIGEST_LIMITS.maxDays);
  });
});

describe("githubRepoUrl", () => {
  test("https and ssh GitHub origins, with or without .git", () => {
    expect(githubRepoUrl("https://github.com/milton/wissel.git")).toBe("https://github.com/milton/wissel");
    expect(githubRepoUrl("https://github.com/milton/wissel\n")).toBe("https://github.com/milton/wissel");
    expect(githubRepoUrl("https://token@github.com/milton/wissel.git")).toBe("https://github.com/milton/wissel");
    expect(githubRepoUrl("git@github.com:milton/wissel.git")).toBe("https://github.com/milton/wissel");
    expect(githubRepoUrl("ssh://git@github.com/milton/wis.sel.git")).toBe("https://github.com/milton/wis.sel");
  });

  test("any other origin gives no link", () => {
    for (const o of ["https://gitlab.com/milton/wissel.git", "git@gitlab.com:milton/wissel.git", "/srv/git/wissel.git", "https://github.com/milton", "https://notgithub.com/a/b", ""]) {
      expect(githubRepoUrl(o), o).toBeNull();
    }
  });
});

test("assertReadOnlyGit allows only `git -C <dir> log ...` and `git -C <dir> remote get-url origin`", () => {
  expect(() => assertReadOnlyGit(["git", "-C", "/r", "log", "--merges"])).not.toThrow();
  expect(() => assertReadOnlyGit(["git", "-C", "/r", "remote", "get-url", "origin"])).not.toThrow();
  for (const cmd of [
    ["git", "-C", "/r", "fetch"],
    ["git", "-C", "/r", "checkout", "main"],
    ["git", "-C", "/r", "remote", "set-url", "origin", "x"],
    ["git", "-C", "/r", "remote", "get-url", "origin", "--push"],
    ["git", "log"],
    ["rm", "-rf", "/r"],
  ]) {
    expect(() => assertReadOnlyGit(cmd), cmd.join(" ")).toThrow(/refusing a git command that isn't read-only/);
  }
});

// ---- the full digest over a fixture world -------------------------------

function git(args: string[], cwd: string): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString("utf8")}`);
  return r.stdout.toString("utf8").trim();
}

function initRepo(dir: string, origin: string): void {
  mkdirSync(dir, { recursive: true });
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "wissel-test@example.com"], dir);
  git(["config", "user.name", "wissel test"], dir);
  git(["remote", "add", "origin", origin], dir);
  writeFileSync(join(dir, "a.txt"), "start\n");
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "start"], dir);
}

/** A `git merge --no-ff` of a one-commit branch, the way mergeTaskWorktree
 *  lands a card; returns the merge commit's sha. */
function mergeBranch(dir: string, branch: string, message: string): string {
  git(["checkout", "-q", "-b", branch], dir);
  writeFileSync(join(dir, `${branch.replace(/\W/g, "_")}.txt`), branch);
  git(["add", "."], dir);
  git(["commit", "-q", "-m", `work on ${branch}`], dir);
  git(["checkout", "-q", "main"], dir);
  git(["merge", "-q", "--no-ff", branch, "-m", message], dir);
  return git(["rev-parse", "HEAD"], dir);
}

/** runViaBun, recording every command it was handed. */
function recording(): { runner: CommandRunner; cmds: string[][] } {
  const cmds: string[][] = [];
  return { cmds, runner: (cmd, opts) => (cmds.push(cmd), runViaBun(cmd, opts)) };
}

interface World {
  dir: string;
  repo: string;
  gitlabRepo: string;
  wt: string;
  board: SqliteBoard;
  now: Date;
  telemetryPath: string;
  lessonsPath: string;
  cards: Record<string, TaskCard>;
  shas: Record<string, string>;
  inputs(extra?: Partial<DigestInputs>): DigestInputs & { cmds: string[][] };
}

let world: World;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-digest-"));
  const repo = join(dir, "wissel");
  const gitlabRepo = join(dir, "elsewhere");
  const wt = join(dir, "worktrees");
  const now = new Date(Date.now() + 60_000);
  const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString();
  const board = new SqliteBoard();
  const cards: Record<string, TaskCard> = {};
  const make = async (key: string, card: Partial<TaskCard> & { title: string }) => {
    cards[key] = await board.create({ body: "", labels: [], ...card });
    return cards[key]!;
  };

  // A: implementer, reviewed twice, pushed back once, then a merge conflict.
  const a = await make("a", { title: "Add the thing", repo });
  mkdirSync(join(wt, a.id), { recursive: true }); // a real worktree dir, so only the mapping keeps git out of it
  const aRev1 = await make("aRev1", { title: "Review: Add the thing", labels: ["review"], repo: join(wt, a.id), parentTaskId: a.id, reviewLineageId: a.id, pushbackCount: 0 });
  const a2 = await make("a2", { title: "Add the thing", repo, parentTaskId: aRev1.id, reviewLineageId: a.id, pushbackCount: 1 });
  await board.setSupersededBy(a.id, a2.id);
  await make("aRev2", { title: "Review: Add the thing", labels: ["review"], repo: join(wt, a.id), parentTaskId: a2.id, reviewLineageId: a.id, pushbackCount: 0 });
  await make("conflict", { title: `Resolve merge conflict: ${a2.id}`, labels: ["conflict"], repo });
  await board.move(a2.id, "done");
  // P: planner with one subtask and its integrator.
  const p = await make("p", { title: "Plan the big one", repo });
  await board.move(p.id, "done");
  const s1 = await make("s1", { title: "Subtask one", repo, parentTaskId: p.id });
  await board.move(s1.id, "done");
  await make("integ", { title: "Integrate: Plan the big one", labels: ["integration"], repo, parentTaskId: p.id });
  // F: failed; E: escalated; OLD: only active 30 days ago.
  const f = await make("f", { title: "Broken one", repo });
  await board.move(f.id, "failed");
  await board.recordResult({ taskId: f.id, agentId: "implementer", ok: false, summary: "\nclaude exited 1: out of memory\nstack..." });
  const e = await make("e", { title: "Stuck one", repo });
  await board.escalate(e.id, "same issue twice in a row\ndetails");
  await make("old", { title: "Ancient work", repo });
  // A pipeline run, and the run doing the collecting (left out).
  const run = await make("run", { title: "Pipeline: AI news podcast", pipelineId: "p-ai" });
  await board.move(run.id, "done");
  const step = await make("step", { title: "AI news podcast: Write podcast script", pipelineId: "p-ai", pipelineRunId: run.id, pipelineStepId: "script" });
  const self = await make("self", { title: "Pipeline: Wissel retrospective podcast", pipelineId: "p-retro" });
  const selfStep = await make("selfStep", { title: "Wissel retrospective podcast: Collect activity", pipelineId: "p-retro", pipelineRunId: self.id, pipelineStepId: "collect" });

  // Git: a GitHub repo with A's merge, an unknown card's merge, a plain
  // branch merge and an SDD; a GitLab repo with one card's merge.
  initRepo(repo, "git@github.com:milton/wissel.git");
  mkdirSync(join(repo, "docs"));
  writeFileSync(join(repo, "docs", "SDD-thing.md"), "Intro line\n\n# SDD: The thing\n\nbody\n");
  writeFileSync(join(repo, "docs", "notes.md"), "# Not an SDD\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "docs"], repo);
  const shas: Record<string, string> = {};
  shas.a = mergeBranch(repo, `wissel/${a.id}`, `Merge wissel/${a.id}: Add the thing`);
  shas.loose = mergeBranch(repo, "wissel/0000-gone", "Merge wissel/0000-gone: A card since deleted");
  shas.plain = mergeBranch(repo, "feature", "Merge branch 'feature'");
  initRepo(gitlabRepo, "https://gitlab.com/milton/elsewhere.git");
  const g = await make("g", { title: "Elsewhere work", repo: gitlabRepo });
  await board.move(g.id, "done");
  shas.g = mergeBranch(gitlabRepo, `wissel/${g.id}`, `Merge wissel/${g.id}: Elsewhere work`);

  const telemetryPath = join(dir, "telemetry.jsonl");
  const ev = (o: Record<string, unknown>) => JSON.stringify(o);
  writeFileSync(
    telemetryPath,
    [
      ev({ type: "dispatch", taskId: a.id, agentId: "implementer", model: "claude-opus-5-5", at: ago(2) }),
      ev({ type: "result", taskId: a.id, agentId: "implementer", actualCost: 1.5, harnessId: "claude", at: ago(2) }),
      ev({ type: "result", taskId: aRev1.id, agentId: "reviewer", actualCost: 0.5, harnessId: "claude", at: ago(2) }),
      ev({ type: "dispatch", taskId: a2.id, agentId: "implementer", model: "claude-opus-5-5", at: ago(1) }),
      ev({ type: "result", taskId: a2.id, agentId: "implementer", actualCost: 1.0, harnessId: "claude", at: ago(1) }),
      ev({ type: "result", taskId: cards.aRev2!.id, agentId: "reviewer", actualCost: 0.25, harnessId: "claude", at: ago(1) }),
      ev({ type: "result", taskId: cards.conflict!.id, agentId: "integrator", actualCost: 0.1, harnessId: "claude", at: ago(1) }),
      ev({ type: "result", taskId: p.id, agentId: "planner", actualCost: 0.2, harnessId: "claude", at: ago(3) }),
      ev({ type: "result", taskId: s1.id, agentId: "implementer", actualCost: 0.3, harnessId: "claude", at: ago(3) }),
      ev({ type: "result", taskId: cards.integ!.id, agentId: "integrator", actualCost: 0.05, harnessId: "claude", at: ago(3) }),
      ev({ type: "result", taskId: f.id, agentId: "implementer", retryAfter: ago(0), at: ago(1) }),
      ev({ type: "result", taskId: f.id, agentId: "implementer", actualCost: 0.4, harnessId: "adevinta", at: ago(1) }),
      ev({ type: "result", taskId: e.id, agentId: "implementer", actualCost: 0.6, harnessId: "claude", at: ago(1) }),
      ev({ type: "result", taskId: cards.old!.id, agentId: "implementer", actualCost: 9, harnessId: "claude", at: ago(30) }),
      ev({ type: "result", taskId: cards.old!.id, agentId: "implementer", retryAfter: ago(29), at: ago(30) }),
      ev({ type: "result", taskId: step.id, agentId: "podcast-scriptwriter", actualCost: 0.33, at: ago(1) }),
      ev({ type: "result", taskId: selfStep.id, agentId: "wissel-digest", actualCost: 0, at: ago(0) }),
      "{torn line",
    ].join("\n") + "\n",
  );
  const lessonsPath = join(dir, "lessons.md");
  writeFileSync(lessonsPath, "# Lessons\n\n- Tests: use the real dispatch path.\n");

  world = {
    dir,
    repo,
    gitlabRepo,
    wt,
    board,
    now,
    telemetryPath,
    lessonsPath,
    cards,
    shas,
    inputs: (extra = {}) => {
      const { runner, cmds } = recording();
      return {
        board,
        telemetryPath,
        lessonsPath,
        docsDir: join(repo, "docs"),
        runner,
        now,
        input: "",
        worktreesRoot: wt,
        agentModel: (id) => (id === "podcast-scriptwriter" ? "claude-sonnet-5-5" : undefined),
        excludeRunId: self.id,
        ...extra,
        cmds,
      };
    },
  };
});

afterAll(async () => {
  await rm(world.dir, { recursive: true, force: true });
});

describe("buildWisselDigest", () => {
  test("lineage folding: reviewer, pushback and conflict cards count under A; the integrator under the planner; one story each", async () => {
    const d = await buildWisselDigest(world.inputs());
    const titles = d.stories.map((s) => s.title).sort();
    expect(titles).toEqual(["A card since deleted", "Add the thing", "Broken one", "Elsewhere work", "Plan the big one", "Stuck one", "Subtask one"].sort());
    const a = d.stories.find((s) => s.title === "Add the thing")!;
    expect(a.facts).toBe(`done; 2 review passes; 1 pushback; $3.35; merged ${world.shas.a!.slice(0, 7)} into wissel`);
    const p = d.stories.find((s) => s.title === "Plan the big one")!;
    expect(p.facts).toBe("done; $0.25");
    expect(d.stats).toMatchObject({ cards: 6, done: 4, failed: 1, escalated: 1, reviewPasses: 2, pushbacks: 1 });
  });

  test("failures carry their first reason line; escalations their context's first line", async () => {
    const d = await buildWisselDigest(world.inputs());
    expect(d.stories.find((s) => s.title === "Broken one")!.facts).toBe("failed; failed 1x, last: claude exited 1: out of memory; $0.40");
    expect(d.stories.find((s) => s.title === "Stuck one")!.facts).toBe("escalated; escalated: same issue twice in a row; $0.60");
  });

  test("merge commits link to their card with a GitHub commit URL from an ssh origin; a non-GitHub origin gives no link; a merge with no card is its own story; a non-wissel merge is ignored", async () => {
    const d = await buildWisselDigest(world.inputs());
    const story = (t: string) => d.stories.find((s) => s.title === t)!;
    expect(story("Add the thing").sources).toEqual([`https://github.com/milton/wissel/commit/${world.shas.a}`]);
    expect(story("A card since deleted")).toMatchObject({
      sources: [`https://github.com/milton/wissel/commit/${world.shas.loose}`],
      facts: `merged ${world.shas.loose!.slice(0, 7)} into wissel; its card is not on the board`,
    });
    expect(story("Elsewhere work")).toMatchObject({ sources: [], facts: `done; merged ${world.shas.g!.slice(0, 7)} into elsewhere` });
    expect(JSON.stringify(d)).not.toContain(world.shas.plain!);
    // Unlinked stories have an empty list, never a missing one.
    expect(d.stories.every((s) => Array.isArray(s.sources))).toBe(true);
    expect(d.stories.every((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.date))).toBe(true);
  });

  test("git runs only read-only commands, never inside a task worktree, and the merges' repos are the cards' real repos", async () => {
    const inputs = world.inputs();
    await buildWisselDigest(inputs);
    expect(inputs.cmds.length).toBeGreaterThan(0);
    for (const cmd of inputs.cmds) {
      expect(() => assertReadOnlyGit(cmd)).not.toThrow();
      expect(cmd[3] === "log" || cmd.slice(3).join(" ") === "remote get-url origin", cmd.join(" ")).toBe(true);
      expect(cmd[2]!.startsWith(world.wt), cmd.join(" ")).toBe(false);
    }
    expect([...new Set(inputs.cmds.map((c) => c[2]))].sort()).toEqual([join(world.repo, "docs"), world.gitlabRepo, world.repo].sort());
  });

  test("telemetry: spend in the window by agent, harness and model; 429 retries in the window; nothing older; the collecting run left out", async () => {
    const d = await buildWisselDigest(world.inputs());
    expect(d.stats.spendUsd).toBe(5.23);
    expect(d.stats.byAgent).toEqual({ implementer: 3.8, reviewer: 0.75, integrator: 0.15, planner: 0.2, "podcast-scriptwriter": 0.33, "wissel-digest": 0 });
    expect(d.stats.byHarness).toEqual({ claude: 4.5, adevinta: 0.4, none: 0.33 });
    expect(d.stats.byModel).toEqual({ "claude-opus-5-5": 2.5, "claude-sonnet-5-5": 0.33, unknown: 2.4 });
    expect(d.stats.retries429).toBe(1);
    expect(d.stats.pipelineRuns).toEqual({ "AI news podcast": { runs: 1, failed: 0, costUsd: 0.33 } });
    expect(d.stories.some((s) => s.title === "Ancient work")).toBe(false);
  });

  test("a wider window takes in the older card, its spend and its retry", async () => {
    const d = await buildWisselDigest(world.inputs({ input: "last 60 days" }));
    expect(d.period.days).toBe(60);
    expect(d.stories.find((s) => s.title === "Ancient work")!.facts).toBe("inbox; $9.00");
    expect(d.stats.spendUsd).toBe(14.23);
    expect(d.stats.retries429).toBe(2);
  });

  test("period, lessons and SDDs changed in the window with their first heading", async () => {
    const d = await buildWisselDigest(world.inputs());
    expect(d.period).toEqual({ from: new Date(world.now.getTime() - 7 * DAY).toISOString().slice(0, 10), to: world.now.toISOString().slice(0, 10), days: 7 });
    expect(d.lessons).toBe("# Lessons\n\n- Tests: use the real dispatch path.\n");
    expect(d.docs).toEqual([{ file: "docs/SDD-thing.md", title: "SDD: The thing" }]);
    expect(d.truncated).toBe(0);
  });

  test("missing telemetry, lessons and docs are empty, not errors", async () => {
    const d = await buildWisselDigest(world.inputs({ telemetryPath: join(world.dir, "nope.jsonl"), lessonsPath: join(world.dir, "nope.md"), docsDir: join(world.dir, "nope") }));
    expect(d.stats.spendUsd).toBe(0);
    expect(d.lessons).toBe("");
    expect(d.docs).toEqual([]);
    // Without telemetry only cards with doneAt or a merge are dated.
    expect(d.stories.map((s) => s.title).sort()).toEqual(["A card since deleted", "Add the thing", "Elsewhere work", "Plan the big one", "Subtask one"].sort());
  });
});

describe("caps", () => {
  test("more than 40 lineages keeps 40 (merged first) and counts the rest in `truncated`; titles and facts are capped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wissel-digest-caps-"));
    try {
      const board = new SqliteBoard();
      const now = new Date(Date.now() + 60_000);
      const lines: string[] = [];
      for (let i = 0; i < 50; i++) {
        const c = await board.create({ title: `${"long title ".repeat(i === 0 ? 40 : 1)}${i}`, body: "", labels: [] });
        if (i === 0) {
          await board.move(c.id, "failed");
          await board.recordResult({ taskId: c.id, agentId: "x", ok: false, summary: "why ".repeat(300) });
          await board.escalate(c.id, "context ".repeat(100));
        }
        lines.push(JSON.stringify({ type: "result", taskId: c.id, agentId: "x", actualCost: i, at: new Date(now.getTime() - DAY).toISOString() }));
      }
      const telemetryPath = join(dir, "t.jsonl");
      writeFileSync(telemetryPath, lines.join("\n"));
      const lessonsPath = join(dir, "lessons.md");
      writeFileSync(lessonsPath, "é".repeat(10_000));
      const d = await buildWisselDigest({ board, telemetryPath, lessonsPath, runner: runViaBun, now, input: "" });
      expect(d.stories).toHaveLength(DIGEST_LIMITS.maxStories);
      expect(d.truncated).toBe(10);
      // The escalated one outranks cost; then the 39 most expensive.
      expect(d.stories.some((s) => s.title.startsWith("long title long title"))).toBe(true);
      expect(d.stories.some((s) => s.title === "long title 1")).toBe(false);
      for (const s of d.stories) {
        expect(s.title.length).toBeLessThanOrEqual(DIGEST_LIMITS.maxTitleChars);
        expect(s.facts.length).toBeLessThanOrEqual(DIGEST_LIMITS.maxFactsChars);
      }
      expect(Buffer.byteLength(d.lessons)).toBeLessThanOrEqual(DIGEST_LIMITS.maxLessonsBytes + 20);
      expect(d.lessons.endsWith("\n[cut at 6 KB]")).toBe(true);
      expect(d.lessons).not.toContain("�");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a payload over 40 KB drops stories until it fits, counting them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wissel-digest-caps-"));
    try {
      const board = new SqliteBoard();
      const now = new Date(Date.now() + 60_000);
      const at = new Date(now.getTime() - DAY).toISOString();
      const lines: string[] = [];
      for (let i = 0; i < 30; i++) {
        const c = await board.create({ title: `card ${i} ${"x".repeat(150)}`, body: "", labels: [] });
        lines.push(JSON.stringify({ type: "result", taskId: c.id, agentId: "x", actualCost: 1, at }));
      }
      // 1500 agents make stats alone close to the cap.
      for (let i = 0; i < 1500; i++) lines.push(JSON.stringify({ type: "result", taskId: `t${i}`, agentId: `agent-number-${i}`, actualCost: 0.01, at }));
      const telemetryPath = join(dir, "t.jsonl");
      writeFileSync(telemetryPath, lines.join("\n"));
      const d = await buildWisselDigest({ board, telemetryPath, runner: runViaBun, now, input: "" });
      expect(Buffer.byteLength(JSON.stringify(d))).toBeLessThanOrEqual(DIGEST_LIMITS.maxPayloadBytes);
      expect(d.stories.length).toBeLessThan(30);
      expect(d.truncated).toBe(30 - d.stories.length);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
