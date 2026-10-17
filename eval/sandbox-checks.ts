/**
 * Deterministic checks over a real `claude -p` stream-json transcript,
 * shared by the sandbox live check (scripts/live-check-sandbox.test.ts)
 * and eval/sandbox-denials.eval.ts. Gate-tested in
 * test/sandbox-checks.test.ts.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One Bash call of a run: what was asked and what came back. */
export interface BashCall {
  command: string;
  output: string;
  isError: boolean;
}

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === "object" && c && "text" in c ? String((c as { text: unknown }).text) : "")).join("\n");
  return "";
}

/** Every Bash tool_use in the transcript, paired with its tool_result. */
export function bashCalls(lines: unknown[]): BashCall[] {
  const pending = new Map<string, string>();
  const calls: BashCall[] = [];
  for (const line of lines) {
    const msg = (line as { message?: { content?: unknown } })?.message;
    if (!Array.isArray(msg?.content)) continue;
    for (const c of msg.content as Record<string, unknown>[]) {
      if (c?.type === "tool_use" && c.name === "Bash" && typeof c.id === "string") {
        pending.set(c.id, String((c.input as { command?: unknown })?.command ?? ""));
      } else if (c?.type === "tool_result" && typeof c.tool_use_id === "string" && pending.has(c.tool_use_id)) {
        calls.push({ command: pending.get(c.tool_use_id)!, output: text(c.content), isError: c.is_error === true });
        pending.delete(c.tool_use_id);
      }
    }
  }
  return calls;
}

/** The first call whose command contains `needle`. */
export function findCall(calls: BashCall[], needle: string): BashCall | undefined {
  return calls.find((c) => c.command.includes(needle));
}

/** True when a tool result is Claude Code's permission refusal rather
 *  than the command's own output. */
export function isPermissionRefusal(call: BashCall): boolean {
  return call.isError && /requested permissions|haven't granted|permission to use|was blocked/i.test(call.output);
}

function git(args: string[], cwd: string): void {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
}

/** A throwaway git repo with a tiny bun project: one source file and one
 *  passing test, committed. */
export async function tinyBunRepo(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `wissel-${prefix}-`));
  await Bun.write(join(dir, "package.json"), JSON.stringify({ name: "tiny", private: true, type: "module", scripts: { typecheck: "true" } }, null, 2));
  await Bun.write(join(dir, "src", "math.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n");
  await Bun.write(
    join(dir, "test", "math.test.ts"),
    'import { expect, test } from "bun:test";\nimport { add } from "../src/math.ts";\n\ntest("add", () => {\n  expect(add(2, 3)).toBe(5);\n});\n',
  );
  git(["init", "-q"], dir);
  git(["config", "user.email", "wissel-eval@example.com"], dir);
  git(["config", "user.name", "wissel eval"], dir);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "seed"], dir);
  return dir;
}
