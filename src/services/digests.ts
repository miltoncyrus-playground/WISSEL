// Workstream digests (docs/SDD-coordinator.md §4.11, phase 3 card 19).
//
// A digest is a fixed template filled from Wissel's own data, with no
// model call: the workstream's cards live against the cap, its PRs by
// state, what waits on the decider, open owner tasks, what quiet hours
// are holding, and the host's load, memory and disk. Each workstream's
// `digests` crons say when one is due. It goes out as one gated action:
// chat.post when the workstream has a chat, else a status message on its
// channel. So quiet hours queue it like any outward line, and no chat and
// no channel means no digest.
import type { Database } from "bun:sqlite";
import { nextRunAfter } from "../core/schedule-time.ts";
import type { TaskCard } from "../core/types.ts";
import type { OwnerTask } from "./owner-tasks.ts";
import type { HostReading } from "./host-guard.ts";
import type { Workstream } from "./workstreams.ts";
import { workCards } from "./tracker-rules.ts";

export interface DigestInput {
  ws: Workstream;
  cards: TaskCard[];
  ownerTasks: OwnerTask[];
  /** Actions quiet hours are holding for this workstream. */
  queued: number;
  /** Most cards that may run at once (WISSEL_MAX_CONCURRENT_TASKS), if set. */
  cap?: number;
  host?: HostReading;
  now: Date;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The digest's text. */
export function buildDigest(i: DigestInput): string {
  const work = workCards(i.cards, i.ws.id);
  const live = work.filter((c) => c.status !== "done" && c.status !== "failed");
  const running = live.filter((c) => c.status === "running").length;
  const waiting = live.filter((c) => c.status === "review" || c.status === "escalated" || c.status === "pending-review").length;
  const lifecycle = (l: string) => work.filter((c) => c.pr && (c.pr.watch?.lifecycle ?? "landed") === l).length;
  const asks = i.ownerTasks.filter((t) => t.status === "open" && t.title.startsWith("Wissel asks "));
  const others = i.ownerTasks.filter((t) => t.status === "open" && !t.title.startsWith("Wissel asks "));
  const deciders = [...new Set(i.ws.projects.map((p) => p.decider).filter(Boolean))];
  const lines = [
    `Digest for ${i.ws.name}${i.ws.ticket ? ` (${i.ws.ticket})` : ""}, ${i.now.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    `Cards: ${plural(live.length, "live card")}${i.cap ? ` against a cap of ${i.cap}` : ""}; ${running} running, ${waiting} waiting on review or a decision.`,
    `PRs: ${lifecycle("landed")} open, ${lifecycle("ready")} ready, ${lifecycle("merged")} merged, ${lifecycle("closed")} closed.`,
    `Waiting on ${deciders.length ? deciders.join(", ") : "the decider"}: ${asks.length ? asks.map((t) => t.title.replace(/^Wissel asks [^:]+: /, "")).join("; ") : "nothing"}.`,
    `Owner tasks open: ${others.length ? others.map((t) => t.title).join("; ") : "none"}.`,
    ...(i.queued ? [`Held for quiet hours: ${plural(i.queued, "action")}.`] : []),
    ...(i.host
      ? [`Host: load ${i.host.load1.toFixed(1)} on ${i.host.cores} cores, ${i.host.memoryFreePct.toFixed(0)}% memory free${i.host.disk[0] ? `, ${i.host.disk[0].freeGb.toFixed(0)} GB free under ${i.host.disk[0].path}` : ""}.`]
      : []),
  ];
  return lines.join("\n");
}

/** Whether a digest cron came round between `last` and `now`. A digest
 *  never run before counts from `since` (when the workstream started
 *  being watched), so a restart doesn't send a backlog. */
export function digestDue(cron: string, timezone: string, last: Date | undefined, since: Date, now: Date): boolean {
  const next = nextRunAfter(cron, timezone, last ?? since);
  return next.getTime() <= now.getTime();
}

export class DigestRuns {
  constructor(private readonly db: Database) {
    db.run("CREATE TABLE IF NOT EXISTS digest_runs (key TEXT PRIMARY KEY, at TEXT NOT NULL);");
  }
  last(key: string): Date | undefined {
    const r = this.db.query("SELECT at FROM digest_runs WHERE key = ?").get(key) as { at: string } | null;
    return r ? new Date(r.at) : undefined;
  }
  mark(key: string, at: Date): void {
    this.db.run("INSERT INTO digest_runs (key, at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET at = excluded.at", [key, at.toISOString()]);
  }
}

/** The digests due now, one per workstream cron. */
export function dueDigests(workstreams: Workstream[], runs: DigestRuns, since: Date, now: Date): Array<{ ws: Workstream; key: string }> {
  const out: Array<{ ws: Workstream; key: string }> = [];
  for (const ws of workstreams) {
    for (const d of ws.digests ?? []) {
      const key = `${ws.id}:${d.cron}:${d.timezone}`;
      if (digestDue(d.cron, d.timezone, runs.last(key), since, now)) out.push({ ws, key });
    }
  }
  return out;
}
