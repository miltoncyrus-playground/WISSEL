// Duty switches, Shadow and the shadow report (docs/SDD-coordinator.md
// §4.13, §7; phase 3 card 20).
//
// While a team moves from an external coordinator (a person, another
// agent) to Wissel, each duty is switched over on its own:
// status, host, landing, review, channel-read, claims, ready-to-merge and
// arming. A duty the external coordinator still owns is denied by the gate
// (rule 3), so nothing is posted twice. Only the owner changes a switch,
// or Shadow for the whole instance, with a confirm step, as a policy
// change.
//
// Shadow runs everything record-only: the gate allows in shadow mode and
// the executor writes a "would" record instead of acting. The shadow
// report sets those records beside what actually happened: other people's
// channel entries, the PRs on the workstream's cards, and the PRs armed.
// That shows whether Wissel would have done the same.
import type { Database } from "bun:sqlite";
import type { Duty, GateRecord } from "./policy-gate.ts";
import type { TaskCard } from "../core/types.ts";
import type { InboxEvent } from "./inbox.ts";

export const DUTIES: readonly Duty[] = ["status", "host", "landing", "review", "channel-read", "claims", "ready-to-merge", "arming"];

export interface DutySwitch {
  workstreamId: string;
  duty: Duty;
  owner: "external" | "wissel";
  changedAt: string;
}

export class DutyStore {
  constructor(
    private readonly db: Database,
    private readonly clock: () => Date = () => new Date(),
  ) {
    db.run("CREATE TABLE IF NOT EXISTS duty_switches (workstreamId TEXT NOT NULL, duty TEXT NOT NULL, owner TEXT NOT NULL, changedAt TEXT NOT NULL, PRIMARY KEY (workstreamId, duty));");
    db.run("CREATE TABLE IF NOT EXISTS coordinator_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  }

  /** Every duty for a workstream; one never switched is Wissel's. */
  list(workstreamId: string): DutySwitch[] {
    const rows = this.db.query("SELECT * FROM duty_switches WHERE workstreamId = ?").all(workstreamId) as DutySwitch[];
    return DUTIES.map((duty) => rows.find((r) => r.duty === duty) ?? { workstreamId, duty, owner: "wissel", changedAt: "" });
  }

  /** The gate context's `duties`. */
  owners(workstreamId: string | undefined): Partial<Record<Duty, "external" | "wissel">> {
    if (!workstreamId) return {};
    return Object.fromEntries(this.list(workstreamId).map((d) => [d.duty, d.owner]));
  }

  set(workstreamId: string, duty: Duty, owner: DutySwitch["owner"]): DutySwitch {
    const changedAt = this.clock().toISOString();
    this.db.run("INSERT INTO duty_switches (workstreamId, duty, owner, changedAt) VALUES (?, ?, ?, ?) ON CONFLICT(workstreamId, duty) DO UPDATE SET owner = excluded.owner, changedAt = excluded.changedAt", [workstreamId, duty, owner, changedAt]);
    return { workstreamId, duty, owner, changedAt };
  }

  /** A coordinator setting, such as a workstream's channel cursor. */
  setting(key: string): string | undefined {
    return (this.db.query("SELECT value FROM coordinator_settings WHERE key = ?").get(key) as { value: string } | null)?.value;
  }

  setSetting(key: string, value: string): void {
    this.db.run("INSERT INTO coordinator_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
  }

  shadow(): boolean {
    return (this.db.query("SELECT value FROM coordinator_settings WHERE key = 'shadow'").get() as { value: string } | null)?.value === "on";
  }

  setShadow(on: boolean): void {
    this.db.run("INSERT INTO coordinator_settings (key, value) VALUES ('shadow', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [on ? "on" : "off"]);
  }
}

export interface ShadowReport {
  workstreamId: string;
  /** What Wissel would have done, by kind. */
  would: Record<string, number>;
  /** What actually happened over the same span. */
  actual: { channelEntries: number; prsOpened: number; prsArmed: number; prsMerged: number };
  /** Side by side, where a would-kind has a real counterpart. */
  compare: Array<{ kind: string; would: number; actual: number }>;
  since?: string;
  /** The latest would-records, newest first. */
  recent: Array<Pick<GateRecord, "at" | "rule"> & { kind: string; detail?: string }>;
}

/** The report, from the gate log's shadow records, the channel entries in
 *  the inbox and the workstream's cards. */
export function shadowReport(workstreamId: string, records: GateRecord[], channelEvents: InboxEvent[], cards: TaskCard[]): ShadowReport {
  const shadow = records.filter((r) => r.mode === "shadow");
  const would: Record<string, number> = {};
  for (const r of shadow) {
    const k = r.action.kind === "channel.post" && r.action.message ? `channel.post:${r.action.message}` : r.action.kind;
    would[k] = (would[k] ?? 0) + 1;
  }
  const since = shadow.length ? shadow[shadow.length - 1]!.at : undefined;
  const mine = cards.filter((c) => c.workstreamId === workstreamId && c.pr);
  const actual = {
    channelEntries: channelEvents.filter((e) => e.kind === "channel.entry" && (!since || e.receivedAt >= since)).length,
    prsOpened: mine.length,
    prsArmed: mine.filter((c) => c.pr?.watch?.armed).length,
    prsMerged: mine.filter((c) => c.pr?.watch?.lifecycle === "merged").length,
  };
  const sum = (prefix: string) => Object.entries(would).filter(([k]) => k === prefix || k.startsWith(`${prefix}:`)).reduce((s, [, n]) => s + n, 0);
  const compare = [
    { kind: "channel.post", would: sum("channel.post"), actual: actual.channelEntries },
    { kind: "pr.open", would: sum("pr.open") + sum("branch.push"), actual: actual.prsOpened },
    { kind: "pr.arm", would: sum("pr.arm"), actual: actual.prsArmed },
  ].filter((c) => c.would > 0 || c.actual > 0);
  return {
    workstreamId,
    would,
    actual,
    compare,
    ...(since ? { since } : {}),
    recent: shadow.slice(0, 50).map((r) => ({ at: r.at, rule: r.rule, kind: r.action.kind, ...(r.action.message ? { detail: r.action.message } : r.action.decisionKind ? { detail: r.action.decisionKind } : {}) })),
  };
}
