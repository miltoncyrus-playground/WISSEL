#!/usr/bin/env bun
/**
 * Live check that wissel's card runs really get a Remote Control
 * session (RunClaudeOptions.remoteControl): real `claude -p` calls
 * through runClaude and runViaBun, in a scratch directory, on every
 * enabled claude-cli harness (the private `claude` one and, when it is
 * on, `claude-adevinta`, whose org policy could refuse Remote Control).
 *
 * Per harness:
 *   1. A run with Remote Control on. Must answer, hand back a
 *      https://claude.ai/code/session_ URL, and stream a
 *      `bridge_state: connected` line (the bridge was really up, not
 *      only registered).
 *   2. The same card resumed (`resumeSessionId`), Remote Control on.
 *      Must be marked resumed, answer from the old conversation, and get
 *      a session URL again.
 * Plus one run on the first harness with Remote Control off: no URL, no
 * control line, still answers (the off switch works).
 *
 * Uses Haiku: this measures the plumbing, not answer quality. Each
 * session shows up in that account's claude.ai/code session list named
 * "wissel: Remote Control eval". About $0.10 per harness.
 * Exits 2 without spending when no claude-cli harness is on.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessPool } from "../src/core/harness-pool.ts";
import type { AgentDef, TaskCard, TaskResult } from "../src/core/types.ts";
import { runClaude, runViaBun } from "../src/executors/claude-cli.ts";

const WORD = "OSPREY-17";
const SESSION_URL = /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+$/;

const agent: AgentDef = {
  id: "remote-control-probe",
  name: "Remote Control probe",
  kind: "agent",
  tier: "readonly",
  description: "eval only",
  whenToUse: "never",
  tags: [],
  executor: "readonly",
  inputs: [],
  outputs: [],
  trustLevel: "low",
  toolAccess: ["read"],
  costProfile: { model: "haiku", estUsdPerTask: 0.02 },
};

export interface Step {
  name: string;
  pass: boolean;
  detail: string;
}

export interface Observed {
  result: TaskResult;
  /** Whether the stream carried bridge_state "connected". */
  connected: boolean;
}

/** The per-harness checks, judged in code. */
export function judgeHarness(harnessId: string, fresh: Observed, resumed: Observed): Step[] {
  const said = (r: TaskResult) => r.summary.includes(WORD);
  return [
    {
      name: `${harnessId}: run gets a connected Remote Control session`,
      pass: fresh.result.ok && said(fresh.result) && SESSION_URL.test(fresh.result.remoteSessionUrl ?? "") && fresh.connected,
      detail: `ok=${fresh.result.ok} url=${fresh.result.remoteSessionUrl ?? "none"} connected=${fresh.connected}`,
    },
    {
      name: `${harnessId}: resumed run keeps its conversation and gets a session`,
      pass: resumed.result.ok && resumed.result.resumed === true && said(resumed.result) && SESSION_URL.test(resumed.result.remoteSessionUrl ?? ""),
      detail: `ok=${resumed.result.ok} resumed=${resumed.result.resumed ?? false} url=${resumed.result.remoteSessionUrl ?? "none"}`,
    },
  ];
}

export function judgeOff(off: Observed, sawControlLine: boolean): Step {
  return {
    name: "Remote Control off: no session, still answers",
    pass: off.result.ok && off.result.summary.includes(WORD) && off.result.remoteSessionUrl === undefined && !sawControlLine && !off.connected,
    detail: `ok=${off.result.ok} url=${off.result.remoteSessionUrl ?? "none"} controlLine=${sawControlLine}`,
  };
}

if (import.meta.main) {
  const pool = await HarnessPool.autoload(process.env.WISSEL_HARNESSES_PATH ?? "harnesses.yaml");
  const harnesses = pool.all().filter((h) => h.enabled && h.tool === "claude-cli");
  if (harnesses.length === 0) {
    console.error("SKIP: no enabled claude-cli harness. Nothing was spent.");
    process.exit(2);
  }
  const dir = await mkdtemp(join(tmpdir(), "wissel-eval-remote-control-"));
  const task: TaskCard = {
    id: "remote-control-eval",
    title: "Remote Control eval",
    body: `Your final answer must be the code word ${WORD} and nothing else. Use no tools.`,
    labels: [],
    repo: dir,
    status: "running",
  };

  async function observe(t: TaskCard, env: Record<string, string> | undefined, remoteControl: boolean): Promise<Observed & { controlLine: boolean }> {
    let connected = false;
    let controlLine = false;
    const result = await runClaude({
      runner: runViaBun,
      task: t,
      agent,
      permissionMode: "plan",
      model: "haiku",
      env,
      memoryPath: join(dir, "no-memory.md"),
      remoteControl,
      onChunk: (line) => {
        const l = line as { type?: string; subtype?: string; state?: string };
        if (l.type === "system" && l.subtype === "bridge_state" && l.state === "connected") connected = true;
        if (l.type === "control_response") controlLine = true;
      },
    });
    return { result, connected, controlLine };
  }

  const steps: Step[] = [];
  let cost = 0;
  try {
    for (const h of harnesses) {
      const fresh = await observe(task, h.env, true);
      const resumed = await observe({ ...task, resumeSessionId: fresh.result.sessionId ?? "missing" }, h.env, true);
      cost += (fresh.result.actualCost ?? 0) + (resumed.result.actualCost ?? 0);
      steps.push(...judgeHarness(h.id, fresh, resumed));
    }
    const off = await observe(task, harnesses[0]!.env, false);
    cost += off.result.actualCost ?? 0;
    steps.push(judgeOff(off, off.controlLine));

    for (const s of steps) console.log(`${s.pass ? "PASS" : "FAIL"}  ${s.name}  (${s.detail})`);
    const passed = steps.filter((s) => s.pass).length;
    const pass = passed === steps.length;
    console.log(`\n${pass ? "PASS" : "FAIL"}: ${passed}/${steps.length}, cost $${cost.toFixed(3)}`);
    process.exitCode = pass ? 0 : 1;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
