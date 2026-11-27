import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runViaBun } from "../src/executors/claude-cli.ts";
import { readReviewedFingerprint, worktreeDiffFingerprint, writeReviewedFingerprint } from "../src/services/worktree.ts";
import { reviewGuardOn, reviewGuardDecision } from "../src/core/orchestrator.ts";

async function git(cwd: string, ...args: string[]): Promise<void> {
  const r = await runViaBun(["git", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wissel-review-guard-"));
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.email", "t@example.invalid");
  await git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "a\n");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "init");
  return dir;
}

test("worktreeDiffFingerprint: null on a clean tree, ignores empty sandbox stubs, and moves with every real change", async () => {
  const dir = await repo();
  try {
    expect(await worktreeDiffFingerprint(runViaBun, dir)).toBeNull();
    writeFileSync(join(dir, ".bashrc"), ""); // a sandbox mount point, not work
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.local.json"), "");
    expect(await worktreeDiffFingerprint(runViaBun, dir)).toBeNull();

    writeFileSync(join(dir, "a.txt"), "changed\n");
    const one = await worktreeDiffFingerprint(runViaBun, dir);
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(await worktreeDiffFingerprint(runViaBun, dir)).toBe(one); // stable

    writeFileSync(join(dir, "new.ts"), "export const x = 1;\n"); // untracked file counts
    const two = await worktreeDiffFingerprint(runViaBun, dir);
    expect(two).not.toBe(one);
    writeFileSync(join(dir, "new.ts"), "export const x = 2;\n"); // and so does its content
    expect(await worktreeDiffFingerprint(runViaBun, dir)).not.toBe(two);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("worktreeDiffFingerprint answers null, never throws, for a path that is not a repo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-review-guard-norepo-"));
  try {
    writeFileSync(join(dir, "x.txt"), "x");
    expect(await worktreeDiffFingerprint(runViaBun, dir)).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the reviewed fingerprint round-trips through the worktree's git dir and never shows in git status", async () => {
  const dir = await repo();
  try {
    expect(await readReviewedFingerprint(runViaBun, dir)).toBeUndefined();
    await writeReviewedFingerprint(runViaBun, dir, "abc123");
    expect(await readReviewedFingerprint(runViaBun, dir)).toBe("abc123");
    const st = await runViaBun(["git", "status", "--porcelain"], { cwd: dir });
    expect(st.stdout.trim()).toBe("");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reviewGuardOn: off unless WISSEL_REVIEW_GUARD is 1/true/on/yes", () => {
  expect(reviewGuardOn({})).toBe(false);
  expect(reviewGuardOn({ WISSEL_REVIEW_GUARD: "0" })).toBe(false);
  for (const v of ["1", "true", "on", "yes", "TRUE"]) expect(reviewGuardOn({ WISSEL_REVIEW_GUARD: v })).toBe(true);
});

test("reviewGuardDecision: no diff skips the review; an unchanged rework escalates; anything else is reviewed", () => {
  // A first attempt that changed nothing (a report-only card): nothing to review.
  expect(reviewGuardDecision({ fingerprint: null, previous: undefined, pushbackCount: 0 })).toBe("no-diff");
  // A rework that changed nothing since the last review: another review would repeat the same verdict.
  expect(reviewGuardDecision({ fingerprint: "f1", previous: "f1", pushbackCount: 2 })).toBe("unchanged");
  // A rework that changed something: review it.
  expect(reviewGuardDecision({ fingerprint: "f2", previous: "f1", pushbackCount: 2 })).toBe("review");
  // A first attempt with work: review it, even if a stale marker matches.
  expect(reviewGuardDecision({ fingerprint: "f1", previous: "f1", pushbackCount: 0 })).toBe("review");
  // A rework whose whole diff vanished: nothing left to review either.
  expect(reviewGuardDecision({ fingerprint: null, previous: "f1", pushbackCount: 3 })).toBe("no-diff");
});

// ---- End to end through the real orchestrator, real git, fake `claude` (same pattern as
// test/orchestrator-review-lifecycle.test.ts). The guard is opt-in, so these set the env var.
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { Router } from "../src/core/router.ts";
import { Orchestrator } from "../src/core/orchestrator.ts";
import { WriteExecutor } from "../src/executors/write.ts";
import { ReadOnlyExecutor } from "../src/executors/readonly.ts";
import type { CommandRunner } from "../src/executors/claude-cli.ts";
import type { ReviewVerdict } from "../src/core/types.ts";

/** Fake claude: a reviewer call answers the next scripted verdict (and throws past the
 *  script, so an extra review fails the test); an implementer call runs `write(cwd)`. */
function fakeClaude(verdicts: ReviewVerdict[], write: (cwd: string) => void): CommandRunner & { reviewerCalls(): number } {
  let calls = 0;
  const runner: CommandRunner = async (cmd, opts) => {
    if (cmd[0] === "git") return runViaBun(cmd, opts);
    const mode = cmd[cmd.indexOf("--permission-mode") + 1];
    if (mode === "plan") {
      const v = verdicts[calls++];
      if (!v) throw new Error(`reviewer invoked a ${calls}th time; only ${verdicts.length} scripted`);
      const result = `Reviewed.\n\n\`\`\`review-verdict\n${JSON.stringify(v)}\n\`\`\``;
      return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result }), stderr: "", exitCode: 0 };
    }
    write(opts.cwd!);
    return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }), stderr: "", exitCode: 0 };
  };
  return Object.assign(runner, { reviewerCalls: () => calls });
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  const before = process.env.WISSEL_REVIEW_GUARD;
  process.env.WISSEL_REVIEW_GUARD = "1";
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.WISSEL_REVIEW_GUARD;
    else process.env.WISSEL_REVIEW_GUARD = before;
  }
}

async function fixture(verdicts: ReviewVerdict[], write: (cwd: string) => void) {
  const repoDir = await mkdtemp(join(tmpdir(), "wissel-guard-e2e-repo-"));
  await git(repoDir, "init", "-q");
  await git(repoDir, "config", "user.email", "t@example.invalid");
  await git(repoDir, "config", "user.name", "t");
  await git(repoDir, "commit", "--allow-empty", "-q", "-m", "seed");
  const home = await mkdtemp(join(tmpdir(), "wissel-guard-e2e-home-"));
  const runner = fakeClaude(verdicts, write);
  const board = new SqliteBoard();
  const registry = await Registry.load();
  const orchestrator = new Orchestrator(board, registry, new Router(registry), [new WriteExecutor({ runner, homeDir: home }), new ReadOnlyExecutor({ runner })], undefined, { executeWriteTier: true });
  const done = async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  };
  return { repoDir, runner, board, orchestrator, done };
}

test("guard on: a write-tier card that changes nothing gets no reviewer and goes to a human (review)", async () => {
  await guarded(async () => {
    const f = await fixture([], () => {}); // report-only: writes nothing; no verdict scripted
    try {
      const card = await f.board.create({ title: "Report only", body: "Look, report, change nothing.", labels: ["code"], repo: f.repoDir });
      await f.orchestrator.sweep();
      await f.orchestrator.sweep();
      expect((await f.board.get(card.id))!.status).toBe("review");
      expect((await f.board.list()).some((t) => t.parentTaskId === card.id)).toBe(false);
      expect(f.runner.reviewerCalls()).toBe(0);
    } finally {
      await f.done();
    }
  });
});

test("guard on: a rework that changes nothing since the last review escalates instead of being reviewed again", async () => {
  await guarded(async () => {
    // Every attempt writes the same content: attempt 1 is a real change, the rework repeats it exactly.
    const f = await fixture([{ verdict: "changes_requested", feedback: "handle the empty input" }], (cwd) => writeFileSync(join(cwd, "x.ts"), "export const x = 1;\n"));
    try {
      const card = await f.board.create({ title: "Add x", body: "Implement x.", labels: ["code"], repo: f.repoDir });
      for (let i = 0; i < 4; i++) await f.orchestrator.sweep();
      expect(f.runner.reviewerCalls()).toBe(1); // reviewed once, never again
      const rework = (await f.board.list()).find((t) => t.reviewLineageId === card.id && t.pushbackCount === 1 && t.title === "Add x");
      expect(rework).toBeDefined();
      expect((await f.board.get(rework!.id))!.status).toBe("escalated");
    } finally {
      await f.done();
    }
  });
});

test("guard off (default): a card that changes nothing is still handed to the reviewer, as before", async () => {
  const f = await fixture([{ verdict: "approve" } as ReviewVerdict], () => {});
  try {
    const card = await f.board.create({ title: "No-op", body: "Nothing.", labels: ["code"], repo: f.repoDir });
    await f.orchestrator.sweep();
    expect((await f.board.get(card.id))!.status).toBe("pending-review");
  } finally {
    await f.done();
  }
});
