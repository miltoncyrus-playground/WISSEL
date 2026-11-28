import { expect, test } from "bun:test";
import { harnessLimitEvent, harnessLimitOf, harnessLimitTask, untrustedFolderOf } from "../src/core/harness-limit.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { Orchestrator } from "../src/core/orchestrator.ts";
import { Registry } from "../src/core/registry.ts";
import { Router } from "../src/core/router.ts";
import { failureText } from "../src/executors/claude-cli.ts";
import { ReadOnlyExecutor } from "../src/executors/readonly.ts";
import { SqliteBoard } from "../src/services/board.ts";
import type { AgentDef, Executor, Harness, TaskCard } from "../src/core/types.ts";

// A failed run's card says the real reason, and an account problem (out
// of usage credits, an untrusted folder) is one owner task naming the
// account, not a red card per run (2026-11-28: three decision cards
// failed at $0, each showing claude's trust warning instead of the
// credits message).

const TRUST = 'Ignoring 4 permissions.allow entries from .claude/settings.json: this workspace has not been trusted. Run Claude Code interactively here once and accept the trust dialog, or set projects["/home/m/work/WISSEL"].hasTrustDialogAccepted: true in /home/m/.claude/.claude.json.';
const CREDITS = "You're out of usage credits. Switch to another model, or manage usage credits at https://claude.ai/settings/usage?from=cc_cli_limit_message, to continue.";

test("the failure line leads with claude's own result, then its warnings", () => {
  expect(failureText(CREDITS, TRUST, "")).toBe(`${CREDITS} · ${TRUST}`);
  expect(failureText(undefined, TRUST, "")).toBe(TRUST);
  expect(failureText(undefined, "", "raw")).toBe("raw");
  expect(failureText("same", "same", "")).toBe("same");
  expect(failureText(undefined, "", "")).toBe("(no output)");
});

test("a real failed run's summary carries the credits message first", async () => {
  const agent: AgentDef = { id: "decider", name: "decider", kind: "agent", tier: "readonly", description: "d", whenToUse: "d", tags: ["decision"], executor: "readonly", inputs: [], outputs: [], trustLevel: "low", toolAccess: ["read"], costProfile: { model: "claude-fable-5-1", estUsdPerTask: 0.25 } };
  const runner = async () => ({ exitCode: 1, stdout: JSON.stringify({ type: "result", is_error: true, result: CREDITS, total_cost_usd: 0 }), stderr: TRUST });
  const task = { id: "t1", title: "Decide", body: "b", labels: [], repo: "/tmp", status: "ready", dependsOn: [] } as unknown as TaskCard;
  const r = await new ReadOnlyExecutor({ runner, remoteControl: false } as never).run(task, agent, undefined);
  expect(r.ok).toBe(false);
  expect(r.summary).toStartWith(`claude exited 1: ${CREDITS}`);
  expect(harnessLimitOf(r)).toBe("balance");
});

test("credits and an untrusted folder are account problems, with the folder named", () => {
  expect(harnessLimitOf({ ok: false, summary: `claude exited 1: ${CREDITS}` })).toBe("balance");
  expect(harnessLimitOf({ ok: false, summary: `claude exited 1: ${TRUST}` })).toBe("untrusted-workspace");
  expect(untrustedFolderOf(TRUST)).toBe("/home/m/work/WISSEL");
  const h: Harness = { id: "claude", tool: "claude-cli", label: "c", enabled: true, env: { CLAUDE_CONFIG_DIR: "/home/m/.claude" } };
  const e = harnessLimitEvent({ taskId: "t1", agentId: "decider", ok: false, summary: TRUST }, h, "owner")!;
  expect(e).toMatchObject({ kind: "untrusted-workspace", folder: "/home/m/work/WISSEL", harnessId: "claude" });
  expect(harnessLimitTask(e, "/home/m/.claude")).toEqual({
    title: "Account claude doesn't trust /home/m/work/WISSEL",
    why: "claude refuses to run in /home/m/work/WISSEL on the claude account until the folder is trusted (first seen on card t1).",
    steps: ["Run: cd /home/m/work/WISSEL && CLAUDE_CONFIG_DIR=/home/m/.claude claude, accept the trust dialog, then /exit", "Retry the cards that failed"],
  });
  expect(harnessLimitTask({ ...e, kind: "balance" })!.title).toBe("Account claude is out of usage credits");
  expect(harnessLimitTask({ ...e, kind: "session-limit" })).toBeUndefined();
});

test("the orchestrator hands each account problem to its hook, with the harness", async () => {
  const agent: AgentDef = { id: "reader", name: "reader", kind: "agent", tier: "readonly", description: "t", whenToUse: "t", tags: ["intake"], executor: "readonly", inputs: [], outputs: [], trustLevel: "low", toolAccess: ["read"], costProfile: { model: "m", estUsdPerTask: 0.01 } };
  const exec: Executor = { id: "fake", harnessTool: "claude-cli", canHandle: () => true, run: async (t, a) => ({ taskId: t.id, agentId: a.id, ok: false, summary: `claude exited 1: ${CREDITS}` }) };
  const board = new SqliteBoard();
  const registry = Registry.from([agent]);
  const seen: string[] = [];
  const orch = new Orchestrator(board, registry, new Router(registry), [exec], undefined, { harnesses: HarnessPool.from([{ id: "claude", tool: "claude-cli", label: "c", enabled: true }]), onHarnessLimit: (e, h) => void seen.push(`${e.kind}@${h.id}`) });
  await board.create({ title: "read", body: "", labels: ["intake"], repo: "r" });
  await orch.sweep();
  expect(seen).toEqual(["balance@claude"]);
});
