import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { formatScheduleTime } from "../core/schedule-runner.ts";
import type { TaskCard } from "../core/types.ts";
import type { HostProbes } from "./host-guard.ts";
import type { OwnerTaskStore } from "./owner-tasks.ts";
import type { GateLog } from "./policy-gate.ts";
import type { Workstream } from "./workstreams.ts";

/**
 * Digests (docs/SDD-coordinator.md §4.11): on each cron in
 * `Workstream.digests` the schedule ticker (src/core/schedule-runner.ts)
 * fills one fixed template from Wissel's own data and nothing else: no
 * model call, no chat post. The snapshot reads the board (cards live
 * against the cap, PRs by state), the gate log (what the workstream's
 * decider was asked), the owner tasks and the host probes the host
 * guard uses. Delivery is the channel log: a log line and a stored
 * record (SqliteDigestLog) a later channel adapter can forward.
 */

/** Counted as live against `maxConcurrentTasks`: cards Wissel is running or has handed off. */
const LIVE_STATUSES: ReadonlySet<TaskCard["status"]> = new Set(["running", "dispatched"]);
const PR_STATES = ["open", "armed", "merged", "closed", "unwatched"] as const;
export type DigestPrState = (typeof PR_STATES)[number];
/** Decider questions shown by name; the rest are counted. */
const MAX_DECIDER_LINES = 5;
const MAX_OWNER_TITLES = 5;
const GB = 1024 ** 3;

export interface DigestSnapshot {
  workstream: { id: string; name: string };
  /** ISO UTC: the fire time. */
  at: string;
  timezone: string;
  cards: { live: number; cap: number | null; byStatus: Partial<Record<TaskCard["status"], number>> };
  prs: Record<DigestPrState, number>;
  /** Gate records with verdict ask-decider, newest first. */
  decider: { kind: string; detail: string; at: string }[];
  ownerTasks: { open: number; titles: string[] };
  /** Undefined when no probes were given. */
  host?: { load: number; cores: number; memoryFreeFraction: number; disk: { path: string; freeBytes: number }[] };
}

export interface DigestSources {
  board: { list(): Promise<TaskCard[]> };
  ownerTasks: Pick<OwnerTaskStore, "list">;
  gateLog: Pick<GateLog, "list">;
  /** The host guard's probes; absent means the Host line reads "not probed". */
  probes?: HostProbes;
  /** The orchestrator's cap; absent means no cap. */
  maxConcurrentTasks?: number;
  /** Paths whose free space is reported (the host guard's: cwd and every project TMPDIR), read per digest. */
  diskPaths?: string[] | (() => Promise<string[]>);
}

export async function buildDigestSnapshot(ws: Workstream, now: Date, src: DigestSources): Promise<DigestSnapshot> {
  const cards = await src.board.list();
  const byStatus: Partial<Record<TaskCard["status"], number>> = {};
  const prs: Record<DigestPrState, number> = { open: 0, armed: 0, merged: 0, closed: 0, unwatched: 0 };
  let live = 0;
  for (const c of cards) {
    byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
    if (LIVE_STATUSES.has(c.status)) live++;
    if (c.pr) prs[c.pr.watch?.state ?? "unwatched"]++;
  }
  const decider = (await src.gateLog.list(ws.id))
    .filter((r) => r.verdict === "ask-decider")
    .reverse()
    .map((r) => ({ kind: r.action.kind, detail: [r.action.post, r.action.decision, r.action.repo].filter(Boolean).join(" "), at: r.at }));
  const open = (await src.ownerTasks.list()).filter((t) => t.status === "open");
  const snapshot: DigestSnapshot = {
    workstream: { id: ws.id, name: ws.name },
    at: now.toISOString(),
    timezone: ws.digests?.[0]?.timezone ?? "UTC",
    cards: { live, cap: src.maxConcurrentTasks ?? null, byStatus },
    prs,
    decider,
    ownerTasks: { open: open.length, titles: open.map((t) => t.title) },
  };
  if (src.probes) {
    const mem = src.probes.memory();
    const disk: { path: string; freeBytes: number }[] = [];
    const paths = typeof src.diskPaths === "function" ? await src.diskPaths() : (src.diskPaths ?? []);
    for (const path of new Set(paths)) {
      disk.push({ path, freeBytes: await src.probes.diskFree(path).catch(() => NaN) });
    }
    snapshot.host = { load: src.probes.load(), cores: src.probes.cores(), memoryFreeFraction: mem.totalBytes > 0 ? mem.freeBytes / mem.totalBytes : 1, disk };
  }
  return snapshot;
}

/** The fixed template: six lines, one per section, the same whatever the data. */
export function renderDigest(s: DigestSnapshot): string {
  const when = (iso: string) => formatScheduleTime(iso, s.timezone);
  const statuses = Object.entries(s.cards.byStatus)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, n]) => `${status} ${n}`);
  const shown = s.decider.slice(0, MAX_DECIDER_LINES).map((d) => `${d.kind}${d.detail ? ` (${d.detail})` : ""} since ${when(d.at)}`);
  const more = s.decider.length - shown.length;
  const titles = s.ownerTasks.titles.slice(0, MAX_OWNER_TITLES);
  const host = s.host
    ? [
        `load ${s.host.load.toFixed(1)} on ${s.host.cores} cores`,
        `memory ${Math.round(s.host.memoryFreeFraction * 100)}% free`,
        ...s.host.disk.map((d) => `disk ${d.path} ${Number.isFinite(d.freeBytes) ? `${(d.freeBytes / GB).toFixed(1)} GB free` : "not readable"}`),
      ].join(", ")
    : "not probed";
  return [
    `Digest: ${s.workstream.name}, ${when(s.at)}`,
    `Cards: ${s.cards.live} live${s.cards.cap === null ? ", no cap" : ` of cap ${s.cards.cap}`} (${statuses.length ? statuses.join(", ") : "none"})`,
    `PRs: ${PR_STATES.map((k) => `${k} ${s.prs[k]}`).join(", ")}`,
    `Waiting on the decider: ${s.decider.length ? `${s.decider.length}: ${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}` : "none"}`,
    `Owner tasks: ${s.ownerTasks.open ? `${s.ownerTasks.open} open: ${titles.join("; ")}${s.ownerTasks.open > titles.length ? "; ..." : ""}` : "none open"}`,
    `Host: ${host}`,
  ].join("\n");
}

export interface DigestRecord {
  id: string;
  workstreamId: string;
  at: string;
  text: string;
}

export interface DigestLog {
  append(record: DigestRecord): Promise<void>;
  /** Oldest first. */
  list(workstreamId: string): Promise<DigestRecord[]>;
}

/** The stored side of the channel log, kept with the board database. */
export class SqliteDigestLog implements DigestLog {
  constructor(private db: Database) {
    this.db.run(`CREATE TABLE IF NOT EXISTS digests (id TEXT PRIMARY KEY, workstreamId TEXT NOT NULL, at TEXT NOT NULL, text TEXT NOT NULL)`);
  }

  async append(r: DigestRecord): Promise<void> {
    this.db.query(`INSERT INTO digests (id, workstreamId, at, text) VALUES (?, ?, ?, ?)`).run(r.id, r.workstreamId, r.at, r.text);
  }

  async list(workstreamId: string): Promise<DigestRecord[]> {
    return this.db.query<DigestRecord, [string]>(`SELECT id, workstreamId, at, text FROM digests WHERE workstreamId = ? ORDER BY at ASC, rowid ASC`).all(workstreamId);
  }
}

/** What the ticker calls per due digest: build, render, store; returns
 *  the record so the ticker can log it. */
export type DigestRunFn = (ws: Workstream, now: Date) => Promise<DigestRecord>;

export function createDigestRun(src: DigestSources, log: DigestLog): DigestRunFn {
  return async (ws, now) => {
    const record: DigestRecord = { id: randomUUID(), workstreamId: ws.id, at: now.toISOString(), text: renderDigest(await buildDigestSnapshot(ws, now, src)) };
    await log.append(record);
    return record;
  };
}
