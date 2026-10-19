/**
 * The OS-enforced Bash sandbox for write-tier `claude -p` runs
 * (implementer, fixer, integrator, lint-fixer). See
 * docs/SDD-write-tier-sandbox.md.
 *
 * Why: write-tier runs were refused read-only shell (grep, sed -n, cat),
 * allowed commands inside a pipe (`bun test 2>&1 | tail`), and so on,
 * because the only gate was an explicit `--allowedTools` prefix list
 * (card 494f87d6, 2026-10-17: 16 refusals in one run). With the sandbox
 * on, the operating system (bubblewrap on Linux) bounds what any Bash
 * command can write, read and reach, so Claude Code approves sandboxed
 * Bash without a prompt (`autoAllowBashIfSandboxed`).
 *
 * Setting names are from https://code.claude.com/docs/en/sandboxing and
 * https://code.claude.com/docs/en/settings-reference (sandbox.*). They
 * are passed with `--settings`, a CLI scope: with
 * `allowUnsandboxedCommands: false` there the sandbox is "admin-required"
 * and a repository's own .claude/settings.json cannot loosen it.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskResult } from "../core/types.ts";

/** What the telemetry `result` event records per claude-cli run:
 *  "on" = sandboxed, "off" = the allowlist mode (readonly runs, tests,
 *  WISSEL_WRITE_SANDBOX=off), "unavailable" = the preflight found the
 *  sandbox can't start here, so the run fell back to the allowlist. */
export type SandboxState = NonNullable<TaskResult["sandbox"]>;

/** The startup preflight's verdict, shown on GET /version. */
export interface SandboxStatus {
  state: SandboxState;
  /** Why it isn't "on"; one line per problem, each with its fix. */
  problems: string[];
}

/** Hosts every sandboxed command may reach: the npm registry (bun and
 *  npm install from it) and github.com. A project adds its own with
 *  `Project.sandboxAllowedDomains` (mergeAllowedDomains). Everything
 *  else is refused, not prompted for (`strictAllowlist`). */
export const SANDBOX_ALLOWED_DOMAINS = ["registry.npmjs.org", "github.com"] as const;

/** The network allowlist for one run: the fixed hosts, then the
 *  project's own in their configured order, each host once. The
 *  project's list is already validated (domainError,
 *  src/services/project-settings.ts); this only merges. Undefined or
 *  empty gives exactly the fixed list. */
export function mergeAllowedDomains(projectDomains?: readonly string[]): string[] {
  const all = [...SANDBOX_ALLOWED_DOMAINS, ...(projectDomains ?? [])];
  return all.filter((d, i) => d && all.indexOf(d) === i);
}

/** Read-denied for sandboxed commands, `~/` resolved by Claude Code:
 *  keys, cloud and gh credentials, every Claude/Codex profile, and the
 *  board database. The worktree itself lives under ~/.wissel/worktrees,
 *  so ~/.wissel as a whole can't be denied. */
export const SANDBOX_DENY_READ = [
  "~/.ssh",
  "~/.aws",
  "~/.gnupg",
  "~/.config/gh",
  "~/.claude",
  "~/.claude.json",
  "~/.claude-adevinta",
  "~/.codex",
  "~/.wissel/board.sqlite*",
] as const;

/** Git commands that write history, refs or the shared stash. Denied
 *  as permission rules so the agent gets a clear refusal; the real
 *  boundary is the denyWrite on the main repo's .git (see
 *  buildSandboxSettings), which no wrapper or script gets around.
 *  Commands that are mostly read (`git branch --show-current`, `git
 *  config --get`, `git remote -v`) aren't listed: the denyWrite already
 *  stops their writing forms. */
export const GIT_WRITE_DENY = [
  "add", "commit", "push", "reset", "rebase", "merge", "cherry-pick", "revert",
  "stash", "update-ref", "checkout", "switch", "worktree", "fetch", "pull",
].map((sub) => `Bash(git ${sub} *)`);

export interface SandboxSettingsInput {
  /** The repo the worktree was cut from. Its `.git` is shared with the
   *  worktree, and Claude Code's sandbox lets a linked worktree write
   *  there (for `git commit`), so it is write-denied here. */
  repo: string;
  /** Extra read-denied paths: every configured harness's
   *  CLAUDE_CONFIG_DIR / CODEX_HOME, and the run's own. */
  extraDenyRead?: string[];
  /** The project's `sandboxAllowedDomains` (Project in
   *  src/core/types.ts, looked up by task.repo), appended to
   *  SANDBOX_ALLOWED_DOMAINS. Undefined or empty: the fixed list alone,
   *  today's output. */
  allowedDomains?: readonly string[];
}

/** The `--settings` object for a sandboxed write-tier run. Writes stay
 *  at Claude Code's default: the cwd (the worktree), the per-user temp
 *  dir and `--add-dir` (TaskCard.extraAllowedDirs), nothing more. */
export function buildSandboxSettings(input: SandboxSettingsInput): Record<string, unknown> {
  const denyRead = [...SANDBOX_DENY_READ, ...(input.extraDenyRead ?? [])].filter((p, i, all) => p && all.indexOf(p) === i);
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      filesystem: {
        denyRead,
        denyWrite: [join(input.repo, ".git")],
      },
      network: {
        allowedDomains: mergeAllowedDomains(input.allowedDomains),
        strictAllowlist: true,
      },
    },
    permissions: { deny: GIT_WRITE_DENY },
  };
}

/** Config dirs of the given harness env blocks, for extraDenyRead. */
export function harnessConfigDirs(envs: (Record<string, string> | undefined)[]): string[] {
  const out: string[] = [];
  for (const env of envs) {
    for (const key of ["CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
      const dir = env?.[key];
      if (dir && !out.includes(dir)) out.push(dir);
    }
  }
  return out;
}

/** What the preflight asks the host. Injectable so tests mock every probe. */
export interface SandboxProbes {
  platform: NodeJS.Platform;
  /** Absolute path of a binary on PATH, or null. */
  which: (bin: string) => string | null;
  /** File contents, or null when it can't be read. */
  readFile: (path: string) => Promise<string | null>;
  /** Exit code of a short command (no shell). */
  run: (cmd: string[]) => Promise<number>;
}

export const realProbes: SandboxProbes = {
  platform: process.platform,
  which: (bin) => Bun.which(bin),
  readFile: async (path) => {
    try {
      return await readFile(path, "utf8");
    } catch {
      return null;
    }
  },
  run: async (cmd) => {
    try {
      const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
      const timer = setTimeout(() => proc.kill(), 5000);
      const code = await proc.exited;
      clearTimeout(timer);
      return code;
    } catch {
      return -1;
    }
  },
};

const APPARMOR_SYSCTL = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";

/**
 * Can Claude Code's Bash sandbox start on this host? Checked once at
 * server startup. Linux needs bubblewrap and socat on PATH, and bwrap
 * must be able to create a user + network namespace: on Ubuntu 24.04
 * with kernel.apparmor_restrict_unprivileged_userns=1 that takes the
 * AppArmor bwrap profile from the sandboxing docs. The namespace check
 * runs bwrap for real (`bwrap --ro-bind / / --unshare-user
 * --unshare-net true`), since a profile file that exists but isn't
 * loaded passes every static check and still fails.
 *
 * `disabled` (WISSEL_WRITE_SANDBOX=off) skips the probes: state "off".
 */
export async function probeSandbox(probes: SandboxProbes = realProbes, disabled = false): Promise<SandboxStatus> {
  if (disabled) return { state: "off", problems: ["turned off with WISSEL_WRITE_SANDBOX=off"] };
  if (probes.platform === "darwin") return { state: "on", problems: [] };
  if (probes.platform !== "linux") return { state: "unavailable", problems: [`the sandbox doesn't run on ${probes.platform}`] };

  const problems: string[] = [];
  const bwrap = probes.which("bwrap");
  if (!bwrap) problems.push("bubblewrap is not installed (sudo apt-get install bubblewrap)");
  if (!probes.which("socat")) problems.push("socat is not installed (sudo apt-get install socat)");
  if (bwrap) {
    const code = await probes.run([bwrap, "--ro-bind", "/", "/", "--unshare-user", "--unshare-net", "true"]);
    if (code !== 0) {
      const restricted = (await probes.readFile(APPARMOR_SYSCTL))?.trim() === "1";
      problems.push(
        restricted
          ? "bwrap can't create user namespaces: kernel.apparmor_restrict_unprivileged_userns=1 and no AppArmor profile lets bwrap (add /etc/apparmor.d/bwrap, then sudo systemctl reload apparmor)"
          : `bwrap can't create a sandbox here (exit ${code})`,
      );
    }
  }
  return problems.length === 0 ? { state: "on", problems: [] } : { state: "unavailable", problems };
}

/** The startup log line(s) for a preflight verdict. */
export function sandboxStartupLines(status: SandboxStatus): string[] {
  if (status.state === "on") return ["write-tier sandbox: on (Bash runs inside Claude Code's OS sandbox)"];
  if (status.state === "off") return [`write-tier sandbox: off (${status.problems.join("; ")}), write-tier Bash uses the allowlist`];
  return [
    "!!! write-tier sandbox: UNAVAILABLE, write-tier Bash falls back to the allowlist (more permission denials) !!!",
    ...status.problems.map((p) => `!!!   ${p}`),
  ];
}
