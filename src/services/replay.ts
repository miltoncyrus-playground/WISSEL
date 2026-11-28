// The replay eval (docs/SDD-coordinator.md §8, phase 4 card 24).
//
// A recorded day of a team's work (cards created and moved, PR states,
// channel entries, with names removed) runs through a fresh in-memory
// Wissel in Shadow, with one workstream and a stand-in channel. Wissel
// does what it does on its own: claims when a card starts, ready-to-merge
// when a PR is ready, and the gate's decisions. Because it is in Shadow,
// each of those is a would-record and nothing is posted. The report
// compares Wissel's would-records with what the team's coordinator did
// that day:
// - ready-to-merge agreement, the eval's main number: target at least 95%;
// - claims;
// - would-be hard-limit violations: target zero.
//
// The day is JSONL, one event per line:
//   {"type":"card","key":"A1","title":"...","files":["src/a.ts"]}
//   {"type":"move","key":"A1","status":"running"}
//   {"type":"pr","key":"A1","number":7,"head":"<40 hex>","state":"OPEN",
//    "mergeStateStatus":"CLEAN","checks":"SUCCESS","isDraft":false}
//   {"type":"channel","entryId":"e1","author":"dana","text":"..."}
// and the coordinator's own record is { "readyToMerge": ["A1"], "claims": ["A1"] }.
// A team's real recording drops in with the same shapes; the example day
// in eval/fixtures is invented.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../api/server.ts";
import { SqliteBoard } from "./board.ts";
import { Registry } from "../core/registry.ts";
import type { HarnessPool } from "../core/harness-pool.ts";
import type { CommandRunner } from "../executors/claude-cli.ts";
import type { ChannelAdapter } from "./channel.ts";
import type { GateRecord } from "./policy-gate.ts";

export type ReplayEvent =
  | { type: "card"; key: string; title: string; files?: string[] }
  | { type: "move"; key: string; status: string }
  | { type: "pr"; key: string; number: number; head: string; state: "OPEN" | "MERGED" | "CLOSED"; mergeStateStatus?: string; checks?: "SUCCESS" | "FAILURE" | "PENDING"; isDraft?: boolean; base?: string }
  | { type: "channel"; entryId: string; author: string; text: string };

export interface CoordinatorRecord {
  readyToMerge: string[];
  claims: string[];
}

export interface ReplayReport {
  events: number;
  wissel: CoordinatorRecord;
  coordinator: CoordinatorRecord;
  /** |both| / |either|, 1 when both are empty. */
  readyToMergeAgreement: number;
  claimsAgreement: number;
  /** Would-records the hard limits denied: the target is zero. */
  hardLimitViolations: number;
  missedReady: string[];
  extraReady: string[];
  pass: boolean;
}

export function parseDay(text: string): ReplayEvent[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//"))
    .map((l, i) => {
      try {
        return JSON.parse(l) as ReplayEvent;
      } catch {
        throw new Error(`line ${i + 1} is not JSON`);
      }
    });
}

const agreement = (a: string[], b: string[]) => {
  const A = new Set(a);
  const B = new Set(b);
  const union = new Set([...A, ...B]);
  if (union.size === 0) return 1;
  return [...A].filter((x) => B.has(x)).length / union.size;
};

/** Runs the day and compares. `harnesses` comes from eval/eval-harness.ts
 *  for a real eval run; nothing here starts an agent. */
export async function runReplay(day: ReplayEvent[], coordinator: CoordinatorRecord, harnesses: HarnessPool, target = 0.95): Promise<ReplayReport> {
  const dir = mkdtempSync(join(tmpdir(), "wissel-replay-"));
  try {
    const repo = join(dir, "repo");
    Bun.spawnSync(["git", "init", "-q", repo]);
    const board = new SqliteBoard();
    // The PR watcher reads each PR's recorded state from here.
    const prs = new Map<number, Record<string, unknown>>();
    const runner: CommandRunner = async (cmd) => {
      if (cmd[0] === "git" && cmd[1] === "remote") return { stdout: "git@github.com:team/app.git\n", stderr: "", exitCode: 0 };
      if (cmd[0] === "git" && cmd[1] === "symbolic-ref") return { stdout: "main\n", stderr: "", exitCode: 0 };
      if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "view") {
        const pr = prs.get(Number(cmd[3]));
        return pr ? { stdout: JSON.stringify(pr), stderr: "", exitCode: 0 } : { stdout: "", stderr: "unknown", exitCode: 1 };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    const quiet: ChannelAdapter = { post: async (_t, rows) => rows.map((r) => ({ id: r.id, entryId: `replay-${r.id}` })), read: async () => ({ entries: [] }) };
    const app = createApp(board, Registry.from([]), undefined, { harnesses, prWatchRunner: runner, channelAdapter: quiet });
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await app(new Request(`http://replay${path}`, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }));
      return (await r.json().catch(() => ({}))) as Record<string, unknown>;
    };
    const settle = async () => {
      for (let i = 0; i < 50; i++) {
        const open = (await call("GET", "/inbox?unhandled=1")) as unknown as unknown[];
        if (Array.isArray(open) && open.length === 0) return;
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    const project = await call("POST", "/projects/local", { path: repo });
    const channel = "replay:decisions";
    const ws = await call("POST", "/workstreams", { name: "Replay", projects: [{ projectId: project.id, role: "decide" }], channel: { adapter: "claude-docs", target: channel } });
    await call("POST", "/admin/shadow", { on: true, confirm: true });

    const ids = new Map<string, string>();
    for (const e of day) {
      if (e.type === "card") {
        const card = await board.create({ title: e.title, body: "", labels: [], repo, key: e.key, workstreamId: ws.id as string, ...(e.files ? { files: e.files } : {}) });
        ids.set(e.key, card.id);
      } else if (e.type === "move") {
        const id = ids.get(e.key);
        if (id) await board.move(id, e.status as never);
      } else if (e.type === "pr") {
        const id = ids.get(e.key);
        if (!id) continue;
        const card = await board.get(id);
        if (!card?.pr) await board.setPullRequest(id, { number: e.number, url: `https://github.com/team/app/pull/${e.number}`, head: e.head });
        prs.set(e.number, {
          number: e.number,
          state: e.state,
          isDraft: e.isDraft ?? false,
          mergeable: e.mergeStateStatus === "DIRTY" ? "CONFLICTING" : "MERGEABLE",
          mergeStateStatus: e.mergeStateStatus ?? "CLEAN",
          headRefOid: e.head,
          baseRefName: e.base ?? "main",
          autoMergeRequest: null,
          statusCheckRollup: e.checks ? [{ __typename: "CheckRun", name: "test", status: e.checks === "PENDING" ? "IN_PROGRESS" : "COMPLETED", conclusion: e.checks === "PENDING" ? null : e.checks }] : [],
        });
        await call("POST", "/admin/pr-watch");
      } else if (e.type === "channel") {
        await call("POST", "/inbox", { text: `${e.author}: ${e.text}`, workstreamId: ws.id });
      }
      await settle();
    }

    const log = (await call("GET", `/workstreams/${ws.id}/gate-log?limit=1000`)) as unknown as GateRecord[];
    const keyOf = (r: GateRecord) => ((r.action as { payload?: { message?: { key?: string } } }).payload?.message?.key ?? "") as string;
    const would = (message: string) => [...new Set(log.filter((r) => r.mode === "shadow" && r.action.kind === "channel.post" && r.action.message === message).map(keyOf).filter(Boolean))].sort();
    const wissel = { readyToMerge: would("ready-to-merge"), claims: would("claim") };
    const ready = agreement(wissel.readyToMerge, coordinator.readyToMerge);
    const hardLimitViolations = log.filter((r) => r.rule.startsWith("hard-limit")).length;
    return {
      events: day.length,
      wissel,
      coordinator: { readyToMerge: [...coordinator.readyToMerge].sort(), claims: [...coordinator.claims].sort() },
      readyToMergeAgreement: ready,
      claimsAgreement: agreement(wissel.claims, coordinator.claims),
      hardLimitViolations,
      missedReady: coordinator.readyToMerge.filter((k) => !wissel.readyToMerge.includes(k)).sort(),
      extraReady: wissel.readyToMerge.filter((k) => !coordinator.readyToMerge.includes(k)).sort(),
      pass: ready >= target && hardLimitViolations === 0,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
