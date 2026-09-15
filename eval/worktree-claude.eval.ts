#!/usr/bin/env bun
/**
 * Periodic eval for WorktreeClaudeExecutor: a real `claude` call with
 * --dangerously-skip-permissions against a real, disposable git worktree.
 * Not run by `bun test` (gate lane) — invoke explicitly with
 * `bun run eval:worktree-claude` before ship / nightly.
 *
 * Checks the property gate tests can't: that a real headless claude call
 * with full permissions actually writes a file (proving the permission
 * bypass genuinely works, not just that we passed the right flag) and that
 * the executor commits it.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeClaudeExecutor } from "../src/executors/worktree-claude.ts";
import { WorktreeService } from "../src/services/worktree.ts";
import { TmuxSupervisor } from "../src/services/session.ts";
import { Provisioner } from "../src/services/provisioner.ts";
import type { AgentDef, TaskCard } from "../src/core/types.ts";

async function run(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { ok: exitCode === 0, stdout: stdout.trim() };
}

const agent: AgentDef = {
  id: "implementer",
  name: "Implementer",
  tier: "write",
  description: "Writes code in an isolated worktree.",
  whenToUse: "Card has clear acceptance criteria and needs code written.",
  tags: ["code"],
  executor: "worktree-claude",
};

interface EvalCase {
  name: string;
  run: () => Promise<{ pass: boolean; detail: string }>;
}

const cases: EvalCase[] = [
  {
    name: "writes and commits a real file with full permissions in the worktree",
    async run() {
      const origin = await mkdtemp(join(tmpdir(), "wissel-eval-origin-"));
      const worktreeRoot = await mkdtemp(join(tmpdir(), "wissel-eval-worktrees-"));
      await run(["init", "-b", "main"], origin);
      await run(["config", "user.email", "eval@wissel.dev"], origin);
      await run(["config", "user.name", "wissel eval"], origin);
      await writeFile(join(origin, "README.md"), "hello\n");
      await run(["add", "."], origin);
      await run(["commit", "-m", "init"], origin);

      const executor = new WorktreeClaudeExecutor(new WorktreeService(worktreeRoot), new TmuxSupervisor(), new Provisioner());
      const task: TaskCard = {
        id: "eval-write-1",
        title: "Create a file named hello.txt in the current directory containing exactly the text: hi",
        body: "",
        labels: [],
        repo: origin,
        status: "ready",
      };

      const result = await executor.run(task, agent);
      const worktreePath = join(worktreeRoot, task.id);
      let fileContent = "";
      try {
        fileContent = (await readFile(join(worktreePath, "hello.txt"), "utf8")).trim();
      } catch {
        // leave empty — reported below
      }
      const log = await run(["log", "--oneline", "wissel/eval-write-1"], origin);

      await rm(origin, { recursive: true, force: true });
      await rm(worktreeRoot, { recursive: true, force: true });

      const pass = result.ok && fileContent === "hi" && log.ok && log.stdout.length > 0;
      return {
        pass,
        detail: `ok=${result.ok} file=${JSON.stringify(fileContent)} committed=${log.ok && log.stdout.length > 0} summary=${JSON.stringify(result.summary)}`,
      };
    },
  },
];

const PASS_THRESHOLD = 1.0;

let passed = 0;
for (const c of cases) {
  const { pass, detail } = await c.run();
  console.log(`${pass ? "PASS" : "FAIL"}  ${c.name}  (${detail})`);
  if (pass) passed++;
}

const score = passed / cases.length;
console.log(`\n${passed}/${cases.length} passed (${(score * 100).toFixed(0)}%), threshold ${(PASS_THRESHOLD * 100).toFixed(0)}%`);

if (score < PASS_THRESHOLD) {
  process.exit(1);
}
