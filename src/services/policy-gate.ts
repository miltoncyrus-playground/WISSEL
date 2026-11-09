import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import type { ProjectRole } from "./workstreams.ts";

/**
 * The policy gate (docs/SDD-coordinator.md §4.2, §4.13, §6): a pure
 * `evaluate(action, ctx)` that every outgoing action passes before the
 * executor, and the append-only gate_log every evaluation writes. Rules
 * run in order, first match wins; Shadow runs them all and only marks
 * the verdict. An action kind no rule knows falls through to
 * `ask-owner` (§10, gate holes), never to `allow`.
 */
export type { ProjectRole };
export const ACTION_KINDS = [
  "card.start", "card.stop", "channel.post", "branch.push", "pr.open", "pr.arm", "pr.merge-forward",
  "ticket.transition", "ticket.comment", "chat.post", "owner.task", "host.pause", "host.resume", "host.restart-when-idle",
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
/** The §4.3 kinds that leave the host; these queue in quiet hours. */
export const OUTWARD_KINDS: ReadonlySet<string> = new Set(["channel.post", "branch.push", "pr.open", "pr.arm", "ticket.transition", "ticket.comment", "chat.post"]);
export type Duty = "status" | "host" | "landing" | "review" | "channel-read" | "claims" | "ready-to-merge" | "arming";
export type Verdict = "allow" | "ask-owner" | "ask-decider" | "deny" | "queue";

export interface Action {
  kind: string; // an ActionKind, or anything a caller invents: those never reach allow
  workstreamId: string;
  projectId: string;
  /** channel.post: claim, release, ready-to-merge, question, answer, decision, status, handover. */
  post?: string;
  /** The decision kind ("naming", "schema") behind a decision post. */
  decision?: string;
  /** The branch a push or an arm lands on (the PR base). */
  base?: string;
  repo?: string;
  /** The code host's check state on the PR being armed. */
  checks?: "green" | "red" | "pending";
  /** The PR or repository belongs to another team. */
  foreign?: boolean;
  /** The channel or chat target of a post; absent means the workstream's own channel. */
  channel?: string;
  /** Hosts, account ids and clusters the action touches. */
  targets?: string[];
  /** The card or PR is this project's own (decide-over, §4.13). */
  own?: boolean;
  /** The decider answered the claim (follow starting a card, §4.13). */
  answered?: boolean;
}

/** §6: code-level limits, widened only by the file read at start. */
export interface HardLimits {
  /** Glob patterns (`*`) for production account ids, clusters and hosts. */
  production: string[];
  readOnlyRepos: string[];
}
export const DEFAULT_HARD_LIMITS: HardLimits = { production: [], readOnlyRepos: [] };

export interface GateContext {
  role: ProjectRole;
  decideAlone: string[];
  mustAsk: string[];
  never: string[];
  limits: HardLimits;
  /** The project's configured main branch; the only branch a push or an arm may land on. */
  mainBranch: string;
  /** The channel and chat targets the owner configured; the only ones a post may reach. */
  channels: string[];
  /** Missing duties belong to Wissel. */
  duties: Partial<Record<Duty, "external" | "wissel">>;
  /** The caller's clock says the workstream is in quiet hours. */
  quiet: boolean;
  /** The instance is in Shadow (role `shadow` also marks the verdict). */
  shadow: boolean;
}

export interface GateVerdict { verdict: Verdict; rule: string; mode: "live" | "shadow" }
/** §3.4: one per evaluation, append-only. */
export interface GateRecord extends GateVerdict { id: string; action: Action; at: string }

const glob = (pattern: string, s: string): boolean => new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(s);

/** §6 defaults, all deny: production targets, a branch other than main,
 *  a failing check, another team's PR or a read-only repo, a target
 *  outside the configured channels. */
function hardLimitHit(a: Action, c: GateContext): boolean {
  if ((a.targets ?? []).some((t) => c.limits.production.some((p) => glob(p, t)))) return true;
  if ((a.kind === "branch.push" || a.kind === "pr.arm") && a.base !== c.mainBranch) return true;
  if (a.kind === "pr.arm" && a.checks !== "green") return true;
  if (a.foreign === true || (a.repo !== undefined && c.limits.readOnlyRepos.includes(a.repo))) return true;
  // A post names no channel when it goes to the workstream's own (configured) one.
  if ((a.kind === "channel.post" || a.kind === "chat.post") && a.channel !== undefined && !c.channels.includes(a.channel)) return true;
  return false;
}

/** Which §4.13 duty switch an action falls under, if any. */
export function dutyFor(a: Action): Duty | undefined {
  if (a.kind.startsWith("host.")) return "host";
  if (a.kind === "branch.push" || a.kind === "pr.open" || a.kind === "pr.merge-forward") return "landing";
  if (a.kind === "pr.arm") return "arming";
  if (a.kind.startsWith("ticket.") || a.kind === "chat.post") return "status";
  if (a.kind !== "channel.post") return undefined;
  if (a.post === "claim" || a.post === "release") return "claims";
  if (a.post === "ready-to-merge") return "ready-to-merge";
  if (a.post === "status" || a.post === "handover") return "status";
  return undefined;
}

/** The §4.13 table. `shadow` runs everything, so it reads the `decide`
 *  column; the mode marks the record. Kinds the table leaves out
 *  (card.stop, pr.merge-forward, owner.task, host.*) fall to rule 7. */
function roleTable(a: Action, c: GateContext): Verdict | undefined {
  const role = c.role === "shadow" ? "decide" : c.role;
  switch (a.kind) {
    case "card.start":
      return role === "decide" || (role === "follow" ? a.answered === true : a.own !== false) ? "allow" : undefined;
    case "channel.post":
      if (a.post !== "decision") return "allow";
      if (role === "follow") return "ask-decider";
      return a.decision !== undefined && c.decideAlone.includes(a.decision) ? "allow" : undefined;
    case "pr.arm":
      return role === "follow" ? undefined : "allow";
    case "ticket.transition":
    case "ticket.comment":
    case "chat.post":
      return "allow";
    default:
      return undefined;
  }
}

export function evaluate(action: Action, ctx: GateContext): GateVerdict {
  const mode = ctx.shadow || ctx.role === "shadow" ? "shadow" : "live";
  const done = (verdict: Verdict, rule: string): GateVerdict => ({ verdict, rule, mode });
  if (hardLimitHit(action, ctx)) return done("deny", "1:hard-limit");
  if (ctx.never.includes(action.kind) || (action.decision !== undefined && ctx.never.includes(action.decision))) return done("deny", "2:never");
  const duty = dutyFor(action);
  if (duty && ctx.duties[duty] === "external") return done("deny", "3:duty-external");
  if (ctx.quiet && OUTWARD_KINDS.has(action.kind)) return done("queue", "4:quiet-hours");
  if (ctx.mustAsk.includes(action.kind) || (action.decision !== undefined && ctx.mustAsk.includes(action.decision))) {
    return done(ctx.role === "follow" ? "ask-decider" : "ask-owner", "5:must-ask");
  }
  const allowed = (ACTION_KINDS as readonly string[]).includes(action.kind) ? roleTable(action, ctx) : undefined;
  if (allowed) return done(allowed, "6:role-table");
  return done("ask-owner", "7:default");
}

/** Reads hard-limits.yaml (`production`, `readOnlyRepos`: string lists). A missing
 *  file means the code defaults; a malformed one is a startup error, on purpose. */
export async function loadHardLimits(path: string): Promise<HardLimits> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_HARD_LIMITS };
    throw e;
  }
  const doc = (parse(raw) ?? {}) as Record<string, unknown>;
  const limits: HardLimits = { ...DEFAULT_HARD_LIMITS };
  for (const key of ["production", "readOnlyRepos"] as const) {
    const v = doc[key] ?? [];
    if (!Array.isArray(v) || !v.every((s) => typeof s === "string" && s.trim() !== "")) throw new Error(`${path}: ${key} must be a list of non-empty strings`);
    limits[key] = v as string[];
  }
  return limits;
}

export interface GateLog {
  append(record: GateRecord): Promise<void>;
  list(workstreamId: string): Promise<GateRecord[]>; // in evaluation order
}

type Row = { id: string; action: string; verdict: Verdict; rule: string; mode: GateRecord["mode"]; at: string };

/** Append-only, kept with the board database (§6): triggers refuse UPDATE and DELETE. */
export class SqliteGateLog implements GateLog {
  constructor(private db: Database) {
    this.db.run(`CREATE TABLE IF NOT EXISTS gate_log (id TEXT PRIMARY KEY, workstreamId TEXT NOT NULL, action TEXT NOT NULL, verdict TEXT NOT NULL, rule TEXT NOT NULL, mode TEXT NOT NULL, at TEXT NOT NULL)`);
    for (const op of ["UPDATE", "DELETE"]) {
      this.db.run(`CREATE TRIGGER IF NOT EXISTS gate_log_no_${op.toLowerCase()} BEFORE ${op} ON gate_log BEGIN SELECT RAISE(ABORT, 'gate_log is append-only'); END`);
    }
  }

  async append(r: GateRecord): Promise<void> {
    this.db.query(`INSERT INTO gate_log (id, workstreamId, action, verdict, rule, mode, at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(r.id, r.action.workstreamId, JSON.stringify(r.action), r.verdict, r.rule, r.mode, r.at);
  }

  async list(workstreamId: string): Promise<GateRecord[]> {
    return this.db.query<Row, [string]>(`SELECT id, action, verdict, rule, mode, at FROM gate_log WHERE workstreamId = ? ORDER BY at ASC, rowid ASC`).all(workstreamId)
      .map((row) => ({ ...row, action: JSON.parse(row.action) as Action }));
  }
}

/** The gate the executor (a later card) calls: evaluates and logs. */
export class PolicyGate {
  constructor(private log: GateLog, private now: () => Date = () => new Date()) {}

  async evaluate(action: Action, ctx: GateContext): Promise<GateVerdict> {
    const verdict = evaluate(action, ctx);
    await this.log.append({ id: randomUUID(), action, ...verdict, at: this.now().toISOString() });
    return verdict;
  }
}
