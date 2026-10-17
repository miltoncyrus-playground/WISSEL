/**
 * Gate: every paid eval and live check runs under the server's harness
 * pool (eval/eval-harness.ts). Static scan, no LLM, no network.
 *
 * Why: model precedence is task.model ?? harness.model ?? manifest
 * (src/core/model-resolution.ts). Eleven evals built executors or an
 * Orchestrator with no harness, so they ran the manifest model
 * (claude-fable-5-1), which the private account has no credits for:
 * 429 credits_required at $0, or a measurement of a model production
 * never uses (2026-10-17). Every file that builds something that runs
 * `claude` must also reach the pool through evalHarness /
 * evalHarnessPool / HarnessPool.autoload, or be in ALLOWLIST with a
 * reason. HarnessPool.load( is banned outright: it skips validation and
 * picks a stale entry (the macOS claude-personal CLAUDE_CONFIG_DIR),
 * which fails with "Not logged in".
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { mainCheckoutRoot, requireEnabled, serverHarnessesPath } from "../eval/eval-harness.ts";

const ROOT = join(import.meta.dir, "..");

/** Files that build a runner but deliberately don't use the server's
 *  pool. Each needs a reason a reviewer can check. No eval tests model
 *  or harness selection without a pool (concierge's control suite
 *  builds a HarnessPool.from fixture, but its main suite uses the
 *  server's pool, so it passes on its own). */
const ALLOWLIST: Record<string, string> = {
  "eval/stt.eval.ts": "createApp only to serve POST /voice to local speaches; it creates no card and never runs claude, so no model is resolved",
  "eval/claude-cli-429-replay.eval.ts": "runClaude with a stub runner that replays stored stdout; no claude process, $0, the model is never sent anywhere",
};

/** Constructions that end in a `claude`/`codex` process run. */
const BUILDS_RUNNER = [
  /\bnew\s+(?:WriteExecutor|ReadOnlyExecutor|CodexWriteExecutor|CodexReadOnlyExecutor|Orchestrator)\s*\(/,
  /\brunClaude\s*\(/,
  /\bPipelineRunnerContext\b/,
  /\bcreateApp\s*\(/,
];
const USES_SERVER_POOL = /\bevalHarness(?:Pool)?\s*\(|\bHarnessPool\.autoload\s*\(/;
const BANNED_LOAD = /\bHarnessPool\.load\s*\(/;

/** Drops comments, so a comment naming evalHarness can't satisfy the
 *  check and a comment naming an executor can't trip it. Keeps `//`
 *  inside a URL (`http://`) and a string. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

interface WiringProblem {
  file: string;
  problem: string;
}

/** What's wrong with one file's source, [] when nothing is. */
function checkWiring(file: string, src: string, allowlist: Record<string, string> = ALLOWLIST): WiringProblem[] {
  const code = stripComments(src);
  const problems: WiringProblem[] = [];
  if (BANNED_LOAD.test(code)) problems.push({ file, problem: "calls HarnessPool.load(): use evalHarnessPool() (eval/eval-harness.ts), which autoloads and validates like the server" });
  const builds = BUILDS_RUNNER.some((re) => re.test(code));
  if (builds && !USES_SERVER_POOL.test(code) && !(file in allowlist)) {
    problems.push({ file, problem: "builds an executor, Orchestrator, pipeline context or app with no harness pool: pass evalHarnessPool() / evalHarness() from eval/eval-harness.ts" });
  }
  return problems;
}

function scannedFiles(): string[] {
  const evals = readdirSync(join(ROOT, "eval"))
    .filter((f) => f.endsWith(".eval.ts"))
    .map((f) => `eval/${f}`);
  const liveChecks = readdirSync(join(ROOT, "scripts"))
    .filter((f) => f.startsWith("live-check-") && f.endsWith(".ts"))
    .map((f) => `scripts/${f}`);
  return [...evals, ...liveChecks].sort();
}

/** Every .ts under eval/ (helpers too) for the HarnessPool.load ban. */
function allEvalTs(): string[] {
  return readdirSync(join(ROOT, "eval"), { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `eval/${f}`);
}

describe("eval harness wiring", () => {
  test("scans the real eval and live-check files", () => {
    const files = scannedFiles();
    expect(files.length).toBeGreaterThan(15);
    expect(files).toContain("eval/readonly.eval.ts");
    expect(files).toContain("scripts/live-check-sandbox.test.ts");
  });

  test("every eval and live check that runs claude uses the server's harness pool", () => {
    const problems = scannedFiles().flatMap((f) => checkWiring(f, readFileSync(join(ROOT, f), "utf8")));
    expect(problems).toEqual([]);
  });

  test("nothing under eval/ calls HarnessPool.load(", () => {
    const offenders = allEvalTs().filter((f) => BANNED_LOAD.test(stripComments(readFileSync(join(ROOT, f), "utf8"))));
    expect(offenders).toEqual([]);
  });

  test("every allowlist entry names a real file that still needs it, with a reason", () => {
    const files = new Set(scannedFiles());
    for (const [file, reason] of Object.entries(ALLOWLIST)) {
      expect(files.has(file)).toBe(true);
      expect(reason.trim().length).toBeGreaterThan(20);
      expect(checkWiring(file, readFileSync(join(ROOT, file), "utf8"), {})).not.toEqual([]);
    }
  });
});

describe("checkWiring", () => {
  test("flags a direct executor run with no harness (the original bug)", () => {
    const src = `const executor = new ReadOnlyExecutor();\nawait executor.run(task, agent);`;
    expect(checkWiring("eval/x.eval.ts", src, {})).toHaveLength(1);
  });

  test("flags an Orchestrator, a pipeline context and an app with no pool", () => {
    expect(checkWiring("a", "new Orchestrator(board, registry, router, executors, undefined, { executeWriteTier: true });", {})).toHaveLength(1);
    expect(checkWiring("b", "const ctx: PipelineRunnerContext = { executors, pipelines };", {})).toHaveLength(1);
    expect(checkWiring("c", "const app = createApp(board, registry, undefined, { taskOutputDir });", {})).toHaveLength(1);
  });

  // One construction per case, so a pattern that misses one class name
  // (CodexReadonly vs the real CodexReadOnlyExecutor) can't hide behind
  // another class on the same line.
  for (const src of [
    "new WriteExecutor({ runner });",
    "new ReadOnlyExecutor();",
    "new CodexWriteExecutor();",
    "new CodexReadOnlyExecutor();",
    "new Orchestrator(board, registry, router, executors);",
    "await runClaude({ runner, task, agent, permissionMode: 'plan' });",
  ]) {
    test(`flags \`${src}\` alone with no pool`, () => {
      expect(checkWiring("x", src, {})).toHaveLength(1);
    });
  }

  test("the executor class names the pattern matches are the real exports", () => {
    const exported = ["write.ts", "readonly.ts", "codex-write.ts", "codex-readonly.ts"]
      .map((f) => readFileSync(join(ROOT, "src/executors", f), "utf8"))
      .join("\n");
    for (const cls of ["WriteExecutor", "ReadOnlyExecutor", "CodexWriteExecutor", "CodexReadOnlyExecutor"]) {
      expect(exported).toMatch(new RegExp(`export class ${cls}\\b`));
    }
    expect(readFileSync(join(ROOT, "src/executors/claude-cli.ts"), "utf8")).toMatch(/export async function runClaude\b/);
  });

  test("passes when the file reaches the server's pool", () => {
    expect(checkWiring("a", "const run = await evalHarness();\nnew WriteExecutor({}).run(t, a, run.harness);", {})).toEqual([]);
    expect(checkWiring("b", "new Orchestrator(b, r, ro, e, undefined, { harnesses: await evalHarnessPool() });", {})).toEqual([]);
    expect(checkWiring("c", "const pool = await HarnessPool.autoload(path);\nnew ReadOnlyExecutor();", {})).toEqual([]);
  });

  test("a comment naming the helper doesn't count, a comment naming an executor doesn't trip it", () => {
    expect(checkWiring("a", "// uses evalHarness()\nnew ReadOnlyExecutor();", {})).toHaveLength(1);
    expect(checkWiring("b", "/* evalHarnessPool() */\nnew ReadOnlyExecutor();", {})).toHaveLength(1);
    expect(checkWiring("c", "/** runs new ReadOnlyExecutor() */\nconst url = 'http://x';", {})).toEqual([]);
  });

  test("bans HarnessPool.load( even next to an autoload, allowlisted or not", () => {
    const src = "const p = await HarnessPool.load();\nconst q = await HarnessPool.autoload();";
    expect(checkWiring("a", src, {})).toHaveLength(1);
    expect(checkWiring("a", src, { a: "allowlisted for a long enough reason" })).toHaveLength(1);
  });

  test("an allowlisted file may build a runner with no pool", () => {
    expect(checkWiring("a", "new ReadOnlyExecutor();", { a: "tests the manifest model with no harness on purpose" })).toEqual([]);
  });
});

describe("requireEnabled", () => {
  const h = (id: string, tool: "claude-cli" | "codex-cli", enabled: boolean) => ({ id, tool, label: id, enabled, env: {} });

  test("passes with one enabled harness of the tool", () => {
    expect(() => requireEnabled(HarnessPool.from([h("a", "claude-cli", false), h("claude", "claude-cli", true)]), "claude-cli", "h.yaml")).not.toThrow();
  });

  test("throws, naming what it found, when every harness of the tool is off (an eval would hang holding its cards)", () => {
    const pool = HarnessPool.from([h("claude", "claude-cli", false), h("codex", "codex-cli", true)]);
    expect(() => requireEnabled(pool, "claude-cli", "/x/harnesses.yaml")).toThrow("no enabled claude-cli harness in /x/harnesses.yaml [claude (disabled)]; not run, nothing spent");
  });
});

describe("serverHarnessesPath", () => {
  test("WISSEL_HARNESSES_PATH wins, as it does for the server", () => {
    expect(serverHarnessesPath({ WISSEL_HARNESSES_PATH: "/x/h.yaml" })).toBe("/x/h.yaml");
  });

  test("a worktree resolves to its main checkout's harnesses.yaml, not its own copy", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "wissel-eval-harness-path-")));
    try {
      const repo = join(dir, "repo");
      const git = (args: string[], cwd: string) => {
        const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
        if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
      };
      mkdirSync(repo);
      git(["init", "-q"], repo);
      git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "seed"], repo);
      const wt = join(dir, "wt");
      git(["worktree", "add", "-q", wt], repo);
      expect(mainCheckoutRoot(repo)).toBe(repo);
      expect(mainCheckoutRoot(wt)).toBe(repo);
      expect(serverHarnessesPath({}, wt)).toBe(join(repo, "harnesses.yaml"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("outside a git repo it falls back to the directory itself", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "wissel-eval-harness-nogit-")));
    try {
      expect(mainCheckoutRoot(dir)).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
