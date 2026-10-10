/**
 * Turns `claude -p`'s raw `permission_denials` into short, comparable
 * keys ("Bash: bun install"), and decides when a review loop is stuck on
 * a permission rather than on the code.
 *
 * Why: the "Wissel app 1/6" card (2026-10-10) was refused `bun install`
 * on every attempt; the reviewer kept asking for exactly that, and the
 * loop ran 5 rounds ($9.28) before escalating. The same refusal on two
 * consecutive attempts now escalates at once with the refused commands
 * named, so a human grants them (POST /tasks/:id/allowed-tools) instead.
 *
 * Real refusals for one need come in different wordings:
 *   "cd /x/app && ls -la && timeout 300 bun install 2>&1 | tail -20"
 *   "bun install --cwd /x/app"
 *   "npm install --prefix app"
 * so a key is program + subcommand per command segment, skipping
 * navigation and output helpers, not the raw string.
 */

/** Package managers whose `run <script>` names the script. */
const RUNNERS = new Set(["bun", "npm", "pnpm", "yarn"]);
/** Programs that only navigate or shape output; never the real need. */
const HELPERS = new Set(["cd", "ls", "cat", "echo", "pwd", "tail", "head", "grep", "wc", "sort", "true", "test", "["]);
/** Wrappers whose real command follows their own arguments. */
const WRAPPERS: Record<string, number> = { timeout: 1, nice: 0, time: 0 };

/** Program + subcommand for each real command in a shell line. */
export function commandKeys(command: string): string[] {
  const keys: string[] = [];
  for (const segment of command.split(/&&|\|\||;|\|/)) {
    let words = segment.trim().split(/\s+/).filter((w) => w && !/^\d?>/.test(w) && !w.startsWith("2>"));
    // Leading VAR=value assignments.
    while (words[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words = words.slice(1);
    const wrapperArgs = words[0] !== undefined ? WRAPPERS[words[0]] : undefined;
    if (wrapperArgs !== undefined) words = words.slice(1 + wrapperArgs);
    const program = words[0];
    if (!program || HELPERS.has(program)) continue;
    const args = words.slice(1).filter((w, i, rest) => !w.startsWith("-") && !["--cwd", "--prefix", "-C"].includes(rest[i - 1] ?? ""));
    const sub = args[0];
    let key = sub && /^[a-z][a-z0-9:._-]*$/.test(sub) ? `${program} ${sub}` : program;
    // A script runner's script is the real need: "bun run test", not
    // "bun run" (which also covers the always-granted typecheck).
    const script = args[1];
    if (RUNNERS.has(program) && sub === "run" && script && /^[a-z][a-z0-9:._-]*$/.test(script)) key = `${key} ${script}`;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** Comparable keys for a run's raw `permission_denials`, deduplicated,
 *  first seen first: "Bash: bun install", "Write" (non-Bash tools by
 *  name). Anything malformed is skipped, never thrown on. */
export function summarizeDenials(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const add = (k: string) => {
    if (!out.includes(k)) out.push(k);
  };
  for (const d of raw) {
    if (typeof d !== "object" || d === null) continue;
    const tool = (d as { tool_name?: unknown }).tool_name;
    if (typeof tool !== "string" || tool === "") continue;
    const input = (d as { tool_input?: unknown }).tool_input;
    const command = typeof input === "object" && input !== null ? (input as { command?: unknown }).command : undefined;
    if (tool === "Bash" && typeof command === "string") {
      const keys = commandKeys(command);
      if (keys.length === 0) add("Bash");
      for (const k of keys) add(`Bash: ${k}`);
    } else {
      add(tool);
    }
  }
  return out;
}
