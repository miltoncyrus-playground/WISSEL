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
    const m = GRANT_RE.exec(entry);
    if (!m) return { ok: false, error: `"${entry}" is not a command-scoped grant like "Bash(bun install:*)"` };
    const words = m[1]!.split(" ");
    const program = words[0]!;
    if (REFUSED_PROGRAMS.has(program)) return { ok: false, error: `"${entry}" grants "${program}", which is never granted per card` };
    // `bun --cwd app run test`: the subcommand is the first word that
    // isn't an option or an option's value.
    const sub = firstSubcommand(words.slice(1));
    if (sub && REFUSED_SUBCOMMANDS[program]?.has(sub)) return { ok: false, error: `"${entry}" grants "${program} ${sub}", which is never granted per card` };
    const targets = ALLOWED_RUNNER_TARGETS[program];
    if (targets && !(sub && targets.has(sub))) {
      return { ok: false, error: `"${entry}": ${program} may only run ${[...targets].join(", ")}` };
    }
    if (!tools.includes(entry)) tools.push(entry);
  }
  return { ok: true, tools };
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
