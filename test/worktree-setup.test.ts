// Per-project worktree setup (Project.worktreeSetup, e.g. `uv sync
// --frozen`): run once in a new worktree by createTaskWorktree, before
// the agent starts. See docs/SDD-worktree-isolation.md §8.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  createTaskWorktree,
  runWorktreeSetup,
  SETUP_DONE_MARKER,
  SETUP_PENDING_MARKER,
  worktreeGitDir,
  type WorktreeSetupConfig,
} from "../src/services/worktree.ts";
import { DEFAULT_GATE_TIMEOUT_MS, runGateCommand, type GateCommandResult, type GateCommandRunner } from "../src/services/merge-gate.ts";
import { WriteExecutor } from "../src/executors/write.ts";
import { CodexWriteExecutor } from "../src/executors/codex-write.ts";
import { runViaBun, type CommandRunner } from "../src/executors/claude-cli.ts";
import { SqliteProjectStore } from "../src/services/projects.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { finishResult } from "../src/core/orchestrator.ts";
import type { AgentDef, TaskCard } from "../src/core/types.ts";

let dir: string;
let home: string;
let gitDirs: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wissel-worktree-setup-"));
  home = join(dir, "home");
  gitDirs = join(dir, "repo.git", "worktrees");
  mkdirSync(home);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const UV_SYNC = ["uv", "sync", "--frozen"];
const acme: WorktreeSetupConfig = { commands: [UV_SYNC, ["uv", "run", "pre-commit", "install"]] };

function wtPath(key = "t1"): string {
  return join(home, ".wissel", "worktrees", key);
}

/** Fakes git: `worktree list` reports `existing` paths, `worktree add`
 *  makes the directory plus the `.git` file and git dir a real add
 *  writes, so the marker lands where it would in production. */
function fakeGit(existing: string[] = []): CommandRunner & { adds: number } {
  const runner = Object.assign(
    async (cmd: string[]) => {
      if (cmd[0] === "git" && cmd[1] === "worktree" && cmd[2] === "list") {
        return { stdout: existing.map((p) => `worktree ${p}\nHEAD abc\n`).join("\n"), stderr: "", exitCode: 0 };
      }
      if (cmd[0] === "git" && cmd[1] === "worktree" && cmd[2] === "add") {
        runner.adds++;
        const path = cmd[5]!;
        const gitDir = join(gitDirs, path.split("/").pop()!);
        mkdirSync(path, { recursive: true });
        mkdirSync(gitDir, { recursive: true });
        writeFileSync(join(path, ".git"), `gitdir: ${gitDir}\n`);
        existing.push(path);
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    { adds: 0 },
  );
  return runner;
}

/** Records every setup call; `results` maps a command's first word to
 *  its result (default: exit 0). */
function fakeSetup(results: Record<string, Partial<GateCommandResult>> = {}): GateCommandRunner & { calls: { argv: string[]; cwd: string; timeoutMs: number }[] } {
  const calls: { argv: string[]; cwd: string; timeoutMs: number }[] = [];
  const runner = async (argv: string[], opts: { cwd: string; timeoutMs: number }): Promise<GateCommandResult> => {
    calls.push({ argv, ...opts });
    const r = results[argv.join(" ")] ?? {};
    return { exitCode: 0, output: "", timedOut: false, ...r };
  };
  return Object.assign(runner, { calls });
}

const gitDirOf = (key = "t1") => join(gitDirs, key);

// ---------- createTaskWorktree ----------

test("a new worktree runs the setup commands in order, in the worktree, under the merge gate's default timeout", async () => {
  const setupRunner = fakeSetup();
  const result = await createTaskWorktree("/repo", "t1", { runner: fakeGit(), homeDir: home, setup: acme, setupRunner });

  expect(result).toEqual({ path: wtPath(), branch: "wissel/t1" });
  expect(setupRunner.calls).toEqual([
    { argv: UV_SYNC, cwd: wtPath(), timeoutMs: DEFAULT_GATE_TIMEOUT_MS },
    { argv: ["uv", "run", "pre-commit", "install"], cwd: wtPath(), timeoutMs: DEFAULT_GATE_TIMEOUT_MS },
  ]);
  expect(DEFAULT_GATE_TIMEOUT_MS).toBe(10 * 60 * 1000);
  // Marked done in the git dir, never in the checkout.
  expect(existsSync(join(gitDirOf(), SETUP_DONE_MARKER))).toBe(true);
  expect(existsSync(join(gitDirOf(), SETUP_PENDING_MARKER))).toBe(false);
  expect(existsSync(join(wtPath(), SETUP_DONE_MARKER))).toBe(false);
});

test("a configured timeoutMs is passed to every command", async () => {
  const setupRunner = fakeSetup();
  await createTaskWorktree("/repo", "t1", { runner: fakeGit(), homeDir: home, setup: { ...acme, timeoutMs: 5_000 }, setupRunner });
  expect(setupRunner.calls.map((c) => c.timeoutMs)).toEqual([5_000, 5_000]);
});

test("setup stops at the first failing command and returns its output tail as the error", async () => {
  const output = [...Array.from({ length: 250 }, (_, i) => `line ${i}`), "error: lockfile out of date"].join("\n");
  const setupRunner = fakeSetup({ "uv sync --frozen": { exitCode: 2, output } });
  const result = await createTaskWorktree("/repo", "t1", { runner: fakeGit(), homeDir: home, setup: acme, setupRunner });

  expect(setupRunner.calls.map((c) => c.argv)).toEqual([UV_SYNC]);
  if (!("error" in result)) throw new Error("expected an error");
  expect(result.error).toContain("Worktree setup failed: `uv sync --frozen` exited 2");
  expect(result.error).toContain("error: lockfile out of date");
  // 251 lines in, the last 200 kept: line 51 onward.
  expect(result.error).toContain("```\nline 51\n");
  expect(result.error).not.toContain("line 50\n");
  expect(existsSync(join(gitDirOf(), SETUP_DONE_MARKER))).toBe(false);
  expect(existsSync(join(gitDirOf(), SETUP_PENDING_MARKER))).toBe(true);
});

test("a timed-out command fails setup and says so", async () => {
  const setupRunner = fakeSetup({ "uv sync --frozen": { exitCode: null, timedOut: true, output: "Resolving..." } });
  const result = await createTaskWorktree("/repo", "t1", { runner: fakeGit(), homeDir: home, setup: { ...acme, timeoutMs: 3_000 }, setupRunner });
  expect(result).toEqual({ error: expect.stringContaining("`uv sync --frozen` timed out after 3s") });
});

test("a reused worktree (reviewer, fixer, integrator, retry) never runs setup again", async () => {
  const git = fakeGit();
  const setupRunner = fakeSetup();
  await createTaskWorktree("/repo", "t1", { runner: git, homeDir: home, setup: acme, setupRunner });
  expect(setupRunner.calls).toHaveLength(2);

  for (let i = 0; i < 3; i++) {
    const again = await createTaskWorktree("/repo", "t1", { runner: git, homeDir: home, setup: acme, setupRunner });
    expect(again).toEqual({ path: wtPath(), branch: "wissel/t1" });
  }
  expect(git.adds).toBe(1);
  expect(setupRunner.calls).toHaveLength(2);
});

test("a worktree that existed before setup was configured is reused as is, setup skipped", async () => {
  mkdirSync(wtPath(), { recursive: true });
  const setupRunner = fakeSetup();
  const result = await createTaskWorktree("/repo", "t1", { runner: fakeGit([wtPath()]), homeDir: home, setup: acme, setupRunner });
  expect(result).toEqual({ path: wtPath(), branch: "wissel/t1" });
  expect(setupRunner.calls).toHaveLength(0);
});

test("after a failed setup, the next run on that worktree runs setup again, and once it passes it stays done", async () => {
  const git = fakeGit();
  let failing = true;
  const calls: string[][] = [];
  const setupRunner: GateCommandRunner = async (argv) => {
    calls.push(argv);
    return failing ? { exitCode: 1, output: "network down", timedOut: false } : { exitCode: 0, output: "", timedOut: false };
  };

  expect(await createTaskWorktree("/repo", "t1", { runner: git, homeDir: home, setup: acme, setupRunner })).toEqual({ error: expect.stringContaining("network down") });
  failing = false;
  expect(await createTaskWorktree("/repo", "t1", { runner: git, homeDir: home, setup: acme, setupRunner })).toEqual({ path: wtPath(), branch: "wissel/t1" });
  expect(await createTaskWorktree("/repo", "t1", { runner: git, homeDir: home, setup: acme, setupRunner })).toEqual({ path: wtPath(), branch: "wissel/t1" });

  expect(git.adds).toBe(1);
  expect(calls).toEqual([UV_SYNC, UV_SYNC, ["uv", "run", "pre-commit", "install"]]);
  expect(existsSync(join(gitDirOf(), SETUP_PENDING_MARKER))).toBe(false);
});

test("no setup configured (undefined or empty) runs nothing and writes no marker: today's behaviour", async () => {
  const cases: [string, WorktreeSetupConfig | undefined][] = [["a", undefined], ["b", { commands: [] }]];
  for (const [key, setup] of cases) {
    const setupRunner = fakeSetup();
    const result = await createTaskWorktree("/repo", key, { runner: fakeGit(), homeDir: home, setup, setupRunner });
    expect(result).toEqual({ path: wtPath(key), branch: `wissel/${key}` });
    expect(setupRunner.calls).toHaveLength(0);
    expect(existsSync(join(gitDirOf(key), SETUP_DONE_MARKER))).toBe(false);
    expect(existsSync(join(gitDirOf(key), SETUP_PENDING_MARKER))).toBe(false);
  }
});

test("setup still runs after node_modules is linked", async () => {
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "node_modules"), { recursive: true });
  let linkedFirst = false;
  const setupRunner: GateCommandRunner = async (_argv, { cwd }) => {
    linkedFirst = existsSync(join(cwd, "node_modules"));
    return { exitCode: 0, output: "", timedOut: false };
  };
  await createTaskWorktree(repo, "t1", { runner: fakeGit(), homeDir: home, setup: { commands: [UV_SYNC] }, setupRunner });
  expect(linkedFirst).toBe(true);
});

// ---------- runWorktreeSetup / worktreeGitDir ----------

test("runWorktreeSetup skips when the done marker is already in the git dir", async () => {
  const wt = join(dir, "wt");
  const gitDir = join(dir, "gd");
  mkdirSync(wt);
  mkdirSync(gitDir);
  writeFileSync(join(wt, ".git"), `gitdir: ${gitDir}\n`);
  writeFileSync(join(gitDir, SETUP_DONE_MARKER), "2026-10-19\n");
  const setupRunner = fakeSetup();

  expect(await runWorktreeSetup(wt, acme, setupRunner)).toEqual({ status: "skipped", runs: [], durationMs: 0 });
  expect(setupRunner.calls).toHaveLength(0);
});

test("runWorktreeSetup reports each run when it passes", async () => {
  const wt = join(dir, "wt");
  mkdirSync(wt);
  const report = await runWorktreeSetup(wt, { commands: [UV_SYNC] }, fakeSetup());
  expect(report).toMatchObject({ status: "passed", runs: [{ argv: UV_SYNC, exitCode: 0, timedOut: false }] });
});

test("worktreeGitDir reads a relative gitdir, a .git directory, and nothing", () => {
  const wt = join(dir, "wt");
  mkdirSync(wt);
  expect(worktreeGitDir(wt)).toBeUndefined();
  writeFileSync(join(wt, ".git"), "gitdir: ../repo/.git/worktrees/wt\n");
  expect(worktreeGitDir(wt)).toBe(join(dir, "repo", ".git", "worktrees", "wt"));
  rmSync(join(wt, ".git"));
  mkdirSync(join(wt, ".git"));
  expect(worktreeGitDir(wt)).toBe(join(wt, ".git"));
});

test("real git: the marker lands in the worktree's git dir, untracked, and the checkout stays clean", async () => {
  const repo = join(dir, "real");
  mkdirSync(repo);
  const git = (...args: string[]) => runViaBun(["git", ...args], { cwd: repo });
  await git("init", "-q", "-b", "main");
  await git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");

  const result = await createTaskWorktree(repo, "t1", {
    runner: runViaBun,
    homeDir: home,
    setup: { commands: [["sh", "-c", "echo synced > .venv-marker"]] },
    setupRunner: runGateCommand,
  });
  if ("error" in result) throw new Error(result.error);

  expect(readFileSync(join(result.path, ".venv-marker"), "utf8")).toBe("synced\n");
  const gitDir = worktreeGitDir(result.path)!;
  expect(gitDir).toBe(join(repo, ".git", "worktrees", "t1"));
  expect(existsSync(join(gitDir, SETUP_DONE_MARKER))).toBe(true);
  const status = await runViaBun(["git", "status", "--porcelain"], { cwd: result.path });
  expect(status.stdout.trim()).toBe("?? .venv-marker"); // the command's own output only, no marker
});

// ---------- executors and the card ----------

const implementer: AgentDef = {
  id: "implementer",
  name: "Implementer",
  kind: "agent",
  tier: "write",
  description: "d",
  whenToUse: "w",
  tags: ["code"],
  executor: "handoff",
  inputs: [],
  outputs: [],
  trustLevel: "high",
  toolAccess: ["read", "write", "bash"],
  costProfile: { model: "claude-sonnet-5", estUsdPerTask: 0.6 },
};

test("WriteExecutor: a failed setup fails the card with the output, before claude ever runs, and the summary lands on the card", async () => {
  const board = new SqliteBoard();
  const registry = Registry.from([implementer]);
  const card = await board.create({ title: "build", body: "", labels: ["code"], repo: "/acme" });
  const task: TaskCard = { ...card, status: "dispatched" };

  const git = fakeGit();
  let agentCalls = 0;
  const runner: CommandRunner = async (cmd, opts) => {
    if (cmd[0] === "git") return git(cmd, opts);
    agentCalls++;
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  const looked: string[] = [];
  const executor = new WriteExecutor({
    runner,
    homeDir: home,
    worktreeSetupFor: async (repo) => {
      looked.push(repo);
      return { commands: [UV_SYNC] };
    },
    setupRunner: fakeSetup({ "uv sync --frozen": { exitCode: 1, output: "No solution found when resolving dependencies" } }),
  });

  const result = await executor.run(task, implementer);
  expect(looked).toEqual(["/acme"]);
  expect(agentCalls).toBe(0);
  expect(result.ok).toBe(false);
  expect(result.summary).toContain("`uv sync --frozen` exited 1");
  expect(result.summary).toContain("No solution found when resolving dependencies");

  await finishResult(board, registry, result);
  expect((await board.get(card.id))!.status).toBe("failed");
  expect((await board.getResult(card.id))!.summary).toContain("No solution found when resolving dependencies");
});

test("WriteExecutor: with no resolver (today's wiring) setup never runs", async () => {
  const setupRunner = fakeSetup();
  const runner: CommandRunner = async (cmd, opts) =>
    cmd[0] === "git" ? fakeGit()(cmd, opts) : { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }), stderr: "", exitCode: 0 };
  const executor = new WriteExecutor({ runner, homeDir: home, setupRunner });
  const result = await executor.run({ id: "t1", title: "x", body: "", labels: [], repo: "/r", status: "dispatched" }, implementer);
  expect(result.ok).toBe(true);
  expect(setupRunner.calls).toHaveLength(0);
});

test("CodexWriteExecutor runs the project's setup too", async () => {
  const setupRunner = fakeSetup({ "uv sync --frozen": { exitCode: 1, output: "boom" } });
  const executor = new CodexWriteExecutor({ runner: fakeGit(), homeDir: home, worktreeSetupFor: async () => ({ commands: [UV_SYNC] }), setupRunner });
  const result = await executor.run({ id: "t1", title: "x", body: "", labels: [], repo: "/r", status: "dispatched" }, { ...implementer, executor: "codex" });
  expect(result.ok).toBe(false);
  expect(result.summary).toContain("boom");
});

// ---------- the store ----------

test("ProjectStore.worktreeSetupFor returns the project's setup, matching paths like mergeGateFor, and undefined when unset", async () => {
  const store = new SqliteProjectStore(new Database(":memory:"));
  const repo = join(dir, "acme");
  mkdirSync(repo);
  await runViaBun(["git", "init", "-q"], { cwd: repo });
  const added = await store.addLocalProject(repo, {}, runViaBun);
  if ("error" in added) throw new Error(added.error);

  expect(await store.worktreeSetupFor(repo)).toBeUndefined();
  await store.setSettings(added.project.id, { worktreeSetup: [UV_SYNC] });
  expect(await store.worktreeSetupFor(repo)).toEqual({ commands: [UV_SYNC] });
  expect(await store.worktreeSetupFor(`${repo}/`)).toEqual({ commands: [UV_SYNC] });
  expect(await store.worktreeSetupFor(join(dir, "other"))).toBeUndefined();
  await store.setSettings(added.project.id, { worktreeSetup: null });
  expect(await store.worktreeSetupFor(repo)).toBeUndefined();
});
