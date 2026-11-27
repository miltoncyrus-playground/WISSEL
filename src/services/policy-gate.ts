// The policy gate (docs/SDD-coordinator.md §4.2, §4.13, §6; phase 3
// card 14).
//
// `evaluate` is a pure function and the only path to the executor (card
// 15). It answers every action the coordinator wants to take with allow,
// ask the decider, ask the owner, queue (quiet hours) or deny. Rules apply
// in this order, first match wins:
//
//   1. a hard limit matches: deny;
//   2. the project's `never` list names the action: deny;
//   3. the action's duty belongs to an external coordinator: deny;
//   4. the role is shadow, or the whole instance is: allow, shadow only
//      (the executor records and does not act);
//   5. quiet hours, and the action reaches outside: queue;
//   6. the kind is in `mustAsk`: ask the decider (follow) or the owner;
//   7. the role allows the kind (the §4.13 table) and, for a decision,
//      the decision kind is in `decideAlone`: allow;
//   8. anything else: ask the owner.
//
// Hard limits are code, extended by a file read at start
// (hard-limits.yaml), never by a channel or a card. The defaults deny:
// - a production target the owner lists;
// - pushing a card's work to the main branch itself;
// - arming a PR whose base isn't the main branch, or with a failing
//   check;
// - writing to a repo listed read-only;
// - posting anywhere but the workstream's own channel and chat.
//
// Every evaluation is written to an append-only gate log.
import type { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { randomUUID } from "node:crypto";
import type { ActionKind, DecisionKind, ProjectRole, WorkstreamProject } from "./workstreams.ts";

export type Duty = "status" | "host" | "landing" | "review" | "channel-read" | "claims" | "ready-to-merge" | "arming";
export type GateVerdict = "allow" | "ask-owner" | "ask-decider" | "deny" | "queue";

/** What the coordinator wants to do. `decision` is a decision card's
 *  outcome being acted on. */
export interface GateAction {
  kind: ActionKind | "decision";
  decisionKind?: DecisionKind;
  /** For channel.post: claim, release, ready-to-merge, question, answer,
   *  decision, status, handover. */
  message?: string;
  projectId?: string;
  workstreamId?: string;
  target?: {
    repo?: string;
    branch?: string;
    /** pr.arm: the PR's base branch and its checks. */
    base?: string;
    checks?: "passing" | "failing" | "pending" | "none";
    /** channel.post, chat.post: where it goes. */
    channel?: string;
    /** Anything that could be production: an account, cluster or host. */
    account?: string;
    cluster?: string;
    host?: string;
  };
}

export interface HardLimits {
  /** Patterns (exact, or with * wildcards) for production targets. */
  production: { accounts: string[]; clusters: string[]; hosts: string[] };
  /** Repos (checkout paths or org/repo) Wissel must never write to. */
  readOnlyRepos: string[];
}

export const DEFAULT_HARD_LIMITS: HardLimits = { production: { accounts: [], clusters: [], hosts: [] }, readOnlyRepos: [] };

export interface GateContext {
  /** The project's role and lists; undefined when it is in no workstream. */
  project?: Pick<WorkstreamProject, "role" | "decideAlone" | "mustAsk" | "never">;
  hardLimits: HardLimits;
  /** Who owns each duty; a duty not listed is Wissel's. */
  duties?: Partial<Record<Duty, "external" | "wissel">>;
  /** The instance is in Shadow. */
  shadow?: boolean;
  quietHours?: { start: string; end: string; timezone: string };
  now: Date;
  mainBranch: string;
  /** The workstream's own channel and chat targets. */
  channels: string[];
}

export interface GateDecision {
  verdict: GateVerdict;
  /** The rule that decided: "hard-limit: ...", "never", "duty", "shadow",
   *  "quiet-hours", "must-ask", "role", "default". */
  rule: string;
  mode: "live" | "shadow";
}

/** Actions that reach outside Wissel (§4.3). */
export const OUTWARD: ReadonlySet<string> = new Set(["channel.post", "branch.push", "pr.open", "pr.arm", "ticket.transition", "ticket.comment", "chat.post"]);
const LONG_LIVED = new Set(["main", "master", "develop", "trunk", "release", "production", "prod", "staging"]);

function matches(value: string | undefined, patterns: string[]): boolean {
  if (!value) return false;
  return patterns.some((p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i").test(value));
}

/** Rule 1: the first hard limit the action hits, or undefined. */
export function hardLimitHit(a: GateAction, ctx: Pick<GateContext, "hardLimits" | "mainBranch" | "channels">): string | undefined {
  const t = a.target ?? {};
  const prod = ctx.hardLimits.production;
  if (matches(t.account, prod.accounts) || matches(t.cluster, prod.clusters) || matches(t.host, prod.hosts)) return "a production target";
  if (t.repo && matches(t.repo, ctx.hardLimits.readOnlyRepos) && a.kind !== "decision") return `${t.repo} is read-only`;
  if (a.kind === "branch.push" && (!t.branch || t.branch === ctx.mainBranch || LONG_LIVED.has(t.branch))) return "pushing to the main branch or a long-lived one";
  if (a.kind === "pr.arm") {
    if (t.base !== ctx.mainBranch) return `arming a PR whose base is ${t.base ?? "unknown"}, not ${ctx.mainBranch}`;
    if (t.checks !== "passing") return `arming a PR whose checks are ${t.checks ?? "unknown"}`;
  }
  if ((a.kind === "channel.post" || a.kind === "chat.post") && (!t.channel || !ctx.channels.includes(t.channel))) return "posting outside the workstream's configured channels";
  return undefined;
}

/** The duty an action belongs to, for rule 3. */
export function dutyOf(a: GateAction): Duty | undefined {
  if (a.kind === "pr.arm") return "arming";
  if (a.kind === "branch.push" || a.kind === "pr.open" || a.kind === "pr.merge-forward") return "landing";
  if (a.kind === "host.pause" || a.kind === "host.resume" || a.kind === "host.restart-when-idle") return "host";
  if (a.kind === "channel.post") {
    if (a.message === "claim" || a.message === "release") return "claims";
    if (a.message === "ready-to-merge") return "ready-to-merge";
    if (a.message === "status") return "status";
  }
  return undefined;
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Whether `now` is inside the quiet hours, in their timezone. A window
 *  may wrap midnight (22:00 to 07:00). */
export function inQuietHours(q: GateContext["quietHours"], now: Date): boolean {
  if (!q) return false;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: q.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const local = Number(parts.find((p) => p.type === "hour")?.value ?? 0) * 60 + Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const start = minutes(q.start);
  const end = minutes(q.end);
  return start <= end ? local >= start && local < end : local >= start || local < end;
}

/** Rule 7: the §4.13 table. Kinds the table doesn't name (stopping a
 *  card, pushing, opening a PR, merge-forward, owner tasks, host) are the
 *  coordinator's ordinary work and allowed for every working role. */
function roleAllows(role: ProjectRole, a: GateAction, decideAlone: DecisionKind[]): GateVerdict | undefined {
  if (a.kind === "decision") {
    if (role === "follow") return "ask-decider";
    return a.decisionKind && decideAlone.includes(a.decisionKind) ? "allow" : undefined;
  }
  if (a.kind === "card.start") return role === "follow" ? "ask-decider" : "allow";
  if (a.kind === "pr.arm") return role === "follow" ? "ask-decider" : "allow";
  return "allow";
}

/** The gate. Pure: the same action and context always give the same
 *  answer. */
export function evaluate(a: GateAction, ctx: GateContext): GateDecision {
  const limit = hardLimitHit(a, ctx);
  if (limit) return { verdict: "deny", rule: `hard-limit: ${limit}`, mode: "live" };
  const p = ctx.project;
  if (p && p.never.includes(a.kind as ActionKind)) return { verdict: "deny", rule: "never", mode: "live" };
  const duty = dutyOf(a);
  if (duty && ctx.duties?.[duty] === "external") return { verdict: "deny", rule: `duty: ${duty} belongs to an external coordinator`, mode: "live" };
  if (ctx.shadow || p?.role === "shadow") return { verdict: "allow", rule: "shadow", mode: "shadow" };
  if (OUTWARD.has(a.kind) && inQuietHours(ctx.quietHours, ctx.now)) return { verdict: "queue", rule: "quiet-hours", mode: "live" };
  if (!p) return { verdict: "ask-owner", rule: "default: the project is in no workstream", mode: "live" };
  const asked = p.mustAsk.includes(a.kind as ActionKind) || (a.decisionKind !== undefined && p.mustAsk.includes(a.decisionKind));
  if (asked) return { verdict: p.role === "follow" ? "ask-decider" : "ask-owner", rule: "must-ask", mode: "live" };
  const byRole = roleAllows(p.role, a, p.decideAlone);
  if (byRole) return { verdict: byRole, rule: "role", mode: "live" };
  return { verdict: "ask-owner", rule: "default", mode: "live" };
}

/** Reads hard-limits.yaml; a missing file is the defaults. Anything
 *  malformed stops start-up, like integrations.yaml. */
export async function loadHardLimits(path: string): Promise<HardLimits> {
  const raw = await readFile(path, "utf8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return undefined;
    throw e;
  });
  if (raw === undefined) return DEFAULT_HARD_LIMITS;
  const doc = (parse(raw) ?? {}) as { production?: Partial<HardLimits["production"]>; readOnlyRepos?: unknown };
  const list = (v: unknown, name: string): string[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.trim())) throw new Error(`${path}: ${name} must be a list of names or patterns`);
    return v as string[];
  };
  return {
    production: { accounts: list(doc.production?.accounts, "production.accounts"), clusters: list(doc.production?.clusters, "production.clusters"), hosts: list(doc.production?.hosts, "production.hosts") },
    readOnlyRepos: list(doc.readOnlyRepos, "readOnlyRepos"),
  };
}

export interface GateRecord {
  id: string;
  workstreamId?: string;
  action: GateAction;
  verdict: GateVerdict;
  rule: string;
  mode: "live" | "shadow";
  at: string;
}

/** The append-only gate log, kept in the board's database. */
export class GateLog {
  constructor(
    private readonly db: Database,
    private readonly clock: () => Date = () => new Date(),
  ) {
    db.run("CREATE TABLE IF NOT EXISTS gate_records (id TEXT PRIMARY KEY, workstreamId TEXT, action TEXT NOT NULL, verdict TEXT NOT NULL, rule TEXT NOT NULL, mode TEXT NOT NULL, at TEXT NOT NULL);");
    db.run("CREATE TRIGGER IF NOT EXISTS gate_records_append_only_d BEFORE DELETE ON gate_records BEGIN SELECT RAISE(ABORT, 'gate_records is append-only'); END;");
    db.run("CREATE TRIGGER IF NOT EXISTS gate_records_append_only_u BEFORE UPDATE ON gate_records BEGIN SELECT RAISE(ABORT, 'gate_records is append-only'); END;");
  }

  /** Evaluates the action, writes the record, returns it. */
  decide(action: GateAction, ctx: GateContext): GateRecord {
    const d = evaluate(action, ctx);
    const rec: GateRecord = { id: randomUUID(), ...(action.workstreamId ? { workstreamId: action.workstreamId } : {}), action, ...d, at: this.clock().toISOString() };
    this.db.run("INSERT INTO gate_records (id, workstreamId, action, verdict, rule, mode, at) VALUES (?, ?, ?, ?, ?, ?, ?)", [rec.id, rec.workstreamId ?? null, JSON.stringify(action), rec.verdict, rec.rule, rec.mode, rec.at]);
    return rec;
  }

  /** Newest first. */
  list(workstreamId?: string, limit = 200): GateRecord[] {
    const n = Math.max(1, Math.min(1000, Math.floor(limit)));
    const rows = (workstreamId ? this.db.query(`SELECT * FROM gate_records WHERE workstreamId = ? ORDER BY at DESC, rowid DESC LIMIT ${n}`).all(workstreamId) : this.db.query(`SELECT * FROM gate_records ORDER BY at DESC, rowid DESC LIMIT ${n}`).all()) as Array<{
      id: string;
      workstreamId: string | null;
      action: string;
      verdict: GateVerdict;
      rule: string;
      mode: "live" | "shadow";
      at: string;
    }>;
    return rows.map((r) => ({ id: r.id, ...(r.workstreamId ? { workstreamId: r.workstreamId } : {}), action: JSON.parse(r.action) as GateAction, verdict: r.verdict, rule: r.rule, mode: r.mode, at: r.at }));
  }
}

/** The gate context for a project in a workstream: its role and lists,
 *  the workstream's quiet hours and channels, and the instance's limits.
 *  The executor (card 15) builds one per action. */
export function gateContextFor(
  ws: { projects: WorkstreamProject[]; quietHours?: GateContext["quietHours"]; channel?: { target: string }; chat?: { channel: string } } | undefined,
  projectId: string | undefined,
  base: Pick<GateContext, "hardLimits" | "now" | "mainBranch"> & Partial<Pick<GateContext, "duties" | "shadow">>,
): GateContext {
  const project = ws?.projects.find((p) => p.projectId === projectId);
  return {
    ...base,
    ...(project ? { project } : {}),
    ...(ws?.quietHours ? { quietHours: ws.quietHours } : {}),
    channels: [...(ws?.channel ? [ws.channel.target] : []), ...(ws?.chat ? [ws.chat.channel] : [])],
  };
}
