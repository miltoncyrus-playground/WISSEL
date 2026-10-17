/**
 * Validation for `TaskCard.extraAllowedTools`, the per-card grants a
 * write-tier run adds to WriteExecutor's fixed `--allowedTools` pair
 * (src/executors/write.ts). Accepted on `POST /tasks` and
 * `POST /tasks/:id/allowed-tools`.
 *
 * Why it exists: the "Wissel app 1/6" card (2026-10-10) needed
 * `bun install`, a build and Playwright, was refused all three, and
 * looped through 5 review rounds ($9.28) before escalating. Grants are
 * per card so every other card keeps the locked-down default.
 *
 * Only command-scoped Bash grants are accepted: `Bash(<command prefix>)`
 * or `Bash(<command prefix>:*)`, where the prefix starts with a program
 * name and contains no shell operators. A bare `Bash`, `Bash(*)`, or a
 * prefix like `Bash(rm:*)` is refused; so is anything that isn't Bash
 * (file tools are already governed by the worktree and acceptEdits).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const MAX_EXTRA_ALLOWED_TOOLS = 12;

const GRANT_RE = /^Bash\(([a-z][a-z0-9._-]*(?: [A-Za-z0-9@._:/=-]+)*)(:\*)?\)$/;

/** Programs a grant may never start with: destructive, privilege or
 *  network-exfiltration commands, and shells/interpreters that would
 *  make the prefix meaningless. */
const REFUSED_PROGRAMS = new Set([
  "rm", "sudo", "su", "chmod", "chown", "dd", "mkfs", "shutdown", "reboot", "kill", "pkill", "killall",
  "curl", "wget", "ssh", "scp", "rsync", "nc", "git", "docker", "systemctl",
  "sh", "bash", "zsh", "eval", "exec", "env", "xargs", "python", "python3", "node", "perl", "ruby",
]);

/** Subcommands of an allowed program that are still refused: anything
 *  that publishes, deletes or runs arbitrary code. */
const REFUSED_SUBCOMMANDS: Record<string, Set<string>> = {
  bun: new Set(["publish", "x", "pm", "upgrade", "-e", "--eval"]),
  bunx: new Set([]),
  npm: new Set(["publish", "exec", "unpublish", "adduser", "login", "token"]),
  npx: new Set([]),
};

/** Programs whose first argument must be on this list (bunx/npx run any
 *  package, so only named tools). */
const ALLOWED_RUNNER_TARGETS: Record<string, Set<string>> = {
  bunx: new Set(["playwright", "vite", "vitest", "tsc"]),
  npx: new Set(["playwright", "vite", "vitest", "tsc"]),
};

export type AllowedToolsCheck = { ok: true; tools: string[] } | { ok: false; error: string };

/** Validates a client-supplied `extraAllowedTools`. `undefined` and `[]`
 *  are fine (no grants). Duplicates are dropped, order kept. */
export function validateExtraAllowedTools(value: unknown): AllowedToolsCheck {
  if (value === undefined || value === null) return { ok: true, tools: [] };
  if (!Array.isArray(value)) return { ok: false, error: "extraAllowedTools must be a list of strings" };
  if (value.length > MAX_EXTRA_ALLOWED_TOOLS) return { ok: false, error: `extraAllowedTools has ${value.length} entries; at most ${MAX_EXTRA_ALLOWED_TOOLS}` };
  const tools: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return { ok: false, error: "extraAllowedTools must be a list of strings" };
    const error = grantError(entry);
    if (error) return { ok: false, error };
    if (!tools.includes(entry)) tools.push(entry);
  }
  return { ok: true, tools };
}

/** Why one grant is refused, or undefined when it's acceptable. */
export function grantError(entry: string): string | undefined {
  const m = GRANT_RE.exec(entry);
  if (!m) return `"${entry}" is not a command-scoped grant like "Bash(bun install:*)"`;
  const words = m[1]!.split(" ");
  const program = words[0]!;
  if (REFUSED_PROGRAMS.has(program)) return `"${entry}" grants "${program}", which is never granted per card`;
  // `bun --cwd app run test`: the subcommand is the first word that
  // isn't an option or an option's value.
  const sub = firstSubcommand(words.slice(1));
  if (sub && REFUSED_SUBCOMMANDS[program]?.has(sub)) return `"${entry}" grants "${program} ${sub}", which is never granted per card`;
  const targets = ALLOWED_RUNNER_TARGETS[program];
  if (targets && !(sub && targets.has(sub))) return `"${entry}": ${program} may only run ${[...targets].join(", ")}`;
  return undefined;
}

export interface ProjectAllowRules {
  /** Rules that pass grantError, in file order, deduplicated. */
  allowed: string[];
  /** Rules that don't, each with why. */
  refused: { rule: string; error: string }[];
}

/**
 * The repo's own `.claude/settings.json` `permissions.allow` rules, run
 * through the same check as a per-card grant. WriteExecutor passes the
 * allowed ones with `--allowedTools`, because `claude -p` in a worktree
 * drops them ("Ignoring 4 permissions.allow entries from
 * .claude/settings.json: this workspace has not been trusted"). Marking
 * every worktree trusted in ~/.claude.json instead would also trust
 * whatever else that file holds (hooks, MCP servers, any allow rule at
 * all), unchecked.
 *
 * Read from `repo`, the human-controlled main checkout, never from the
 * worktree: an agent that edited the worktree's copy must not grant its
 * own next attempt anything. A missing or malformed file is no rules.
 */
export async function readProjectAllowRules(repo: string): Promise<ProjectAllowRules> {
  const out: ProjectAllowRules = { allowed: [], refused: [] };
  let rules: unknown;
  try {
    const raw = await readFile(join(repo, ".claude", "settings.json"), "utf8");
    rules = (JSON.parse(raw) as { permissions?: { allow?: unknown } } | null)?.permissions?.allow;
  } catch {
    return out;
  }
  if (!Array.isArray(rules)) return out;
  for (const rule of rules) {
    if (typeof rule !== "string") continue;
    const error = grantError(rule);
    if (error) out.refused.push({ rule, error });
    else if (!out.allowed.includes(rule)) out.allowed.push(rule);
  }
  return out;
}

const OPTIONS_WITH_VALUE = new Set(["--cwd", "--prefix", "-C"]);

function firstSubcommand(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (OPTIONS_WITH_VALUE.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("--cwd=") || a.startsWith("--prefix=")) continue;
    if (a === "-e" || a === "--eval") return a;
    if (a.startsWith("-")) continue;
    return a;
  }
  return undefined;
}
