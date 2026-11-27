import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectEnvError, runEnv, validateProjectSettings } from "../src/services/project-settings.ts";
import { SqliteProjectStore } from "../src/services/projects.ts";
import { runGateCommand, runMergeGate, type GateCommandRunner } from "../src/services/merge-gate.ts";
import { runWorktreeSetup } from "../src/services/worktree.ts";
import { runViaBun } from "../src/executors/claude-cli.ts";

// docs/SDD-coordinator.md §3.2, §4.12, phase 1 card 6: a project's env
// (TMPDIR on a disk with room) for its card runs, gate and setup. The
// pilot's temp volume filled because every card inherited the harness's
// temp directory.

describe("validation", () => {
  test("plain names are stored; null and {} clear", () => {
    expect(validateProjectSettings({ env: { TMPDIR: "/data/tmp", BUN_INSTALL_CACHE_DIR: "/data/bun" } })).toEqual({ ok: true, patch: { env: { TMPDIR: "/data/tmp", BUN_INSTALL_CACHE_DIR: "/data/bun" } } });
    expect(validateProjectSettings({ env: null })).toEqual({ ok: true, patch: { env: null } });
    expect(validateProjectSettings({ env: {} })).toEqual({ ok: true, patch: { env: null } });
  });

  test("refuses Wissel's own settings, account and tool config, what runs, and anything like a credential", () => {
    for (const name of ["WISSEL_PORT", "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "CODEX_HOME", "OPENAI_BASE_URL", "GIT_SSH_COMMAND", "LD_PRELOAD", "PATH", "HOME", "NODE_OPTIONS", "GITHUB_TOKEN", "DB_PASSWORD", "AWS_SECRET_ACCESS_KEY", "STRIPE_KEY", "MY_API_KEY"]) {
      expect(projectEnvError(name, "x")).toContain("can't be set per project");
    }
    expect(projectEnvError("tmpdir", "x")).toContain("upper-case");
    expect(projectEnvError("TMPDIR", "a\nb")).toContain("single line");
    expect(projectEnvError("TMPDIR", 5)).toContain("single line");
    expect(validateProjectSettings({ env: ["TMPDIR=/x"] }).ok).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`V${i}`, "x"]));
    expect(validateProjectSettings({ env: many })).toMatchObject({ ok: false, error: expect.stringContaining("at most 20") });
  });

  test("runEnv: the harness's account pointers win over the project's; nothing set stays undefined", () => {
    expect(runEnv({ TMPDIR: "/data/tmp", FOO: "p" }, { CLAUDE_CONFIG_DIR: "/h", FOO: "h" })).toEqual({ TMPDIR: "/data/tmp", FOO: "h", CLAUDE_CONFIG_DIR: "/h" });
    expect(runEnv({ TMPDIR: "/t" }, undefined)).toEqual({ TMPDIR: "/t" });
    expect(runEnv(undefined, undefined)).toBeUndefined();
  });
});

describe("where it applies", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wissel-project-env-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("the project's merge gate and worktree setup carry its env", async () => {
    const store = new SqliteProjectStore(new Database(":memory:"));
    const repo = join(dir, "repo");
    mkdirSync(repo);
    const added = await store.addLocalProject(repo, { initGit: true }, runViaBun);
    if (!("project" in added)) throw new Error(added.error);
    await store.setMergeGate(added.project.id, [["bun", "test"]]);
    await store.setSettings(added.project.id, { env: { TMPDIR: "/data/tmp" }, worktreeSetup: [["bun", "install"]] });
    expect(await store.mergeGateFor(repo)).toEqual({ commands: [["bun", "test"]], env: { TMPDIR: "/data/tmp" } });
    expect(await store.worktreeSetupFor(repo)).toEqual({ commands: [["bun", "install"]], env: { TMPDIR: "/data/tmp" } });
    expect((await store.settingsFor(repo))?.env).toEqual({ TMPDIR: "/data/tmp" });
  });

  test("runMergeGate and runWorktreeSetup hand the env to every command; without one, nothing is passed", async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const runner: GateCommandRunner = async (_argv, o) => (seen.push(o.env), { exitCode: 0, output: "", timedOut: false });
    await runMergeGate({ commands: [["a"], ["b"]], env: { TMPDIR: "/t" } }, dir, runner);
    await runMergeGate({ commands: [["c"]] }, dir, runner);
    const wt = join(dir, "wt");
    mkdirSync(wt);
    await runWorktreeSetup(wt, { commands: [["d"]], env: { TMPDIR: "/s" } }, runner);
    expect(seen).toEqual([{ TMPDIR: "/t" }, { TMPDIR: "/t" }, undefined, { TMPDIR: "/s" }]);
  });

  test("a real gate command sees the project's TMPDIR", async () => {
    const res = await runGateCommand(["sh", "-c", 'echo "$TMPDIR"'], { cwd: dir, timeoutMs: 10_000, env: { TMPDIR: "/data/tmp-for-this-repo" } });
    expect(res.exitCode).toBe(0);
    expect(res.output.trim()).toBe("/data/tmp-for-this-repo");
  });
});
