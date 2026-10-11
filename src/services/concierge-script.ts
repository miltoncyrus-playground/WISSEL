// A scripted concierge for e2e (docs/SDD-wissel-app.md §4.2): a
// CommandRunner that answers `claude -p` from a fixed script instead of
// spawning anything, so the real ReadOnlyExecutor and runClaude parsing
// run end to end with no model and no spend. Set by WISSEL_CONCIERGE_SCRIPT
// (playwright.config.ts); never used otherwise.

import { readFile } from "node:fs/promises";
import type { CommandRunner } from "../executors/claude-cli.ts";

export interface ScriptRule {
  /** Case-insensitive regex tested against Milton's message. */
  match: string;
  /** The model's whole final message, ```wissel-actions block and all.
   *  `$1` to `$9` are the match's groups, escaped for a JSON string, so
   *  an e2e test can name a card made just for it. */
  reply: string;
  costUsd?: number;
}

/** The line buildConciergeContext puts right before Milton's message. */
const MESSAGE_MARKER = "Milton's message, the only thing to act on:\n";

/** Milton's message out of a concierge prompt: everything after the
 *  marker, up to the agent's output contract (buildAgentPrompt appends
 *  it after a blank line). */
export function messageFromPrompt(prompt: string): string {
  const at = prompt.lastIndexOf(MESSAGE_MARKER);
  if (at === -1) return "";
  const rest = prompt.slice(at + MESSAGE_MARKER.length);
  const end = rest.indexOf("\n\n");
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}

export function parseScript(raw: string): ScriptRule[] {
  const rules = JSON.parse(raw) as unknown;
  if (!Array.isArray(rules)) throw new Error("concierge script must be a JSON list of {match, reply}");
  return rules.map((r, i) => {
    const rule = r as Partial<ScriptRule>;
    if (typeof rule.match !== "string" || typeof rule.reply !== "string") throw new Error(`concierge script rule ${i}: needs match and reply strings`);
    new RegExp(rule.match, "i"); // fail at load on a bad pattern
    return { match: rule.match, reply: rule.reply, ...(typeof rule.costUsd === "number" ? { costUsd: rule.costUsd } : {}) };
  });
}

/** The fallback answer when no rule matches. */
const NO_RULE_REPLY = '```wissel-actions\n{"reply": "Scripted concierge: no rule for that.", "actions": []}\n```';

/** `reply` with `$1`..`$9` replaced by the match's groups, each escaped
 *  to sit inside a JSON string. A group that didn't match is "". */
export function withGroups(reply: string, groups: RegExpExecArray | null): string {
  return reply.replace(/\$([1-9])/g, (_, n: string) => JSON.stringify(groups?.[Number(n)] ?? "").slice(1, -1));
}

export function scriptedConciergeRunner(rules: ScriptRule[]): CommandRunner {
  return async (cmd, opts) => {
    if (cmd[0] !== "claude") return { stdout: "", stderr: `scripted concierge only answers claude, got ${cmd[0]}`, exitCode: 1 };
    const message = messageFromPrompt(opts.stdin ?? "");
    let groups: RegExpExecArray | null = null;
    const rule = rules.find((r) => (groups = new RegExp(r.match, "i").exec(message)) !== null);
    const result = {
      type: "result",
      subtype: "success",
      is_error: false,
      result: rule ? withGroups(rule.reply, groups) : NO_RULE_REPLY,
      total_cost_usd: rule?.costUsd ?? 0,
    };
    return { stdout: JSON.stringify(result), stderr: "", exitCode: 0 };
  };
}

export async function loadScriptedConciergeRunner(path: string): Promise<CommandRunner> {
  return scriptedConciergeRunner(parseScript(await readFile(path, "utf8")));
}
