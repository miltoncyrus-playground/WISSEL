// Tracker rules and the chat adapter (docs/SDD-coordinator.md §4.10,
// phase 3 card 18).
//
// Tracker: a workstream's ticket follows its cards.
// - "in progress" once its first card has started;
// - "in review" once every card's work is an open PR;
// - "done" once all of them are merged.
// Each move is one gated ticket.transition action plus one ticket.comment
// naming the merged PRs, through the executor. Its performers refuse
// unless the tracker's writeBack is on, and HANDOVER-PACK.md keeps
// writeBack off, so until the owner turns it on the moves are decided and
// logged but nothing is written. The last state applied is kept per
// workstream, so a move happens once.
//
// Chat: a Slack adapter for chat.post. Its bot token is read when it posts,
// from an environment variable whose name integrations.yaml gives (never
// stored), and it posts only to the channel it is handed: the gate already
// limits that to the workstream's own chat.
import type { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import type { TaskCard } from "../core/types.ts";
import type { TicketProvider } from "./ticket-provider.ts";
import { DECISION_LABEL } from "./decisions.ts";
import { MERGE_FORWARD_LABEL } from "./merge-forward.ts";

export type TicketStage = "in progress" | "in review" | "done";
const ORDER: TicketStage[] = ["in progress", "in review", "done"];

/** The workstream's own work: not decision, merge-forward, review or
 *  conflict cards, not archived, not replaced. */
export function workCards(cards: TaskCard[], workstreamId: string): TaskCard[] {
  return cards.filter(
    (c) => c.workstreamId === workstreamId && !c.archivedAt && !c.supersededBy && !c.labels.some((l) => l === DECISION_LABEL || l === MERGE_FORWARD_LABEL || l === "review" || l === "conflict"),
  );
}

/** Where the ticket should be now, from the cards, or undefined before
 *  any card has started. */
export function ticketStage(cards: TaskCard[]): TicketStage | undefined {
  if (cards.length === 0) return undefined;
  const started = cards.some((c) => c.status !== "inbox" && c.status !== "ready");
  if (!started) return undefined;
  const merged = (c: TaskCard) => c.pr?.watch?.lifecycle === "merged";
  const open = (c: TaskCard) => c.pr !== undefined && c.pr.watch?.lifecycle !== "closed";
  if (cards.every(merged)) return "done";
  if (cards.every(open)) return "in review";
  return "in progress";
}

/** The comment for a move: what moved it, naming the merged PRs. */
export function moveComment(stage: TicketStage, cards: TaskCard[]): string {
  const merged = cards.filter((c) => c.pr?.watch?.lifecycle === "merged").map((c) => `#${c.pr!.number} ${c.pr!.url}`);
  const open = cards.filter((c) => c.pr && c.pr.watch?.lifecycle !== "merged").map((c) => `#${c.pr!.number} ${c.pr!.url}`);
  const why = stage === "in progress" ? `Work started: ${cards.filter((c) => c.status !== "inbox" && c.status !== "ready").length} card(s) under way.` : stage === "in review" ? `Every card is a PR: ${open.join(", ")}.` : "Every card's PR is merged.";
  return `Wissel moved this to "${stage}". ${why}${merged.length ? ` Merged: ${merged.join(", ")}.` : ""}`;
}

/** Whether `next` is a move forward from `last` (the ticket never goes
 *  back on its own). */
export function isForward(last: TicketStage | undefined, next: TicketStage): boolean {
  return last === undefined || ORDER.indexOf(next) > ORDER.indexOf(last);
}

export class TrackerState {
  constructor(private readonly db: Database) {
    db.run("CREATE TABLE IF NOT EXISTS tracker_state (workstreamId TEXT PRIMARY KEY, stage TEXT NOT NULL, at TEXT NOT NULL);");
  }
  get(workstreamId: string): TicketStage | undefined {
    return (this.db.query("SELECT stage FROM tracker_state WHERE workstreamId = ?").get(workstreamId) as { stage: TicketStage } | null)?.stage;
  }
  set(workstreamId: string, stage: TicketStage): void {
    this.db.run("INSERT INTO tracker_state (workstreamId, stage, at) VALUES (?, ?, ?) ON CONFLICT(workstreamId) DO UPDATE SET stage = excluded.stage, at = excluded.at", [workstreamId, stage, new Date().toISOString()]);
  }
}

/** The transition whose name matches the stage (case and spacing
 *  ignored), for ticket.transition's performer. */
export async function transitionFor(provider: TicketProvider, key: string, stage: TicketStage): Promise<string | undefined> {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  const want = norm(stage);
  return (await provider.transitions(key)).find((t) => norm(t.name) === want || norm(t.to ?? "") === want)?.id;
}

// ---------- chat ----------

export interface ChatAdapter {
  post(channel: string, text: string): Promise<{ ts: string }>;
}

export interface ChatConfig {
  kind: "slack";
  tokenEnv: string;
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The `chat:` entry of integrations.yaml, if any; malformed is a reason. */
export async function loadChatConfig(path: string): Promise<{ config?: ChatConfig; reason?: string }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { reason: `no ${path}` };
  }
  let doc: { chat?: unknown } | null;
  try {
    doc = parse(raw) as { chat?: unknown } | null;
  } catch (e) {
    return { reason: `${path} is not valid YAML: ${(e as Error).message}` };
  }
  const c = doc?.chat as Record<string, unknown> | undefined;
  if (!c) return { reason: `${path} has no chat entry` };
  if (c.kind !== "slack") return { reason: `chat.kind must be "slack"` };
  if (typeof c.tokenEnv !== "string" || !ENV_NAME_RE.test(c.tokenEnv)) return { reason: "chat.tokenEnv must be the NAME of an environment variable (the value is never stored here)" };
  return { config: { kind: "slack", tokenEnv: c.tokenEnv } };
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Slack's chat.postMessage, the token read from the environment at each
 *  post. A channel must look like a Slack channel (#name, or an id). */
export function slackAdapter(config: ChatConfig, env: Record<string, string | undefined>, fetchFn: FetchLike = fetch as unknown as FetchLike): ChatAdapter {
  return {
    async post(channel, text) {
      const token = env[config.tokenEnv];
      if (!token) throw new Error(`${config.tokenEnv} is not set in the server's environment`);
      const target = channel.replace(/^slack:/, "");
      if (!/^(#[a-z0-9._-]{1,80}|[CDG][A-Z0-9]{6,})$/.test(target)) throw new Error(`"${channel}" is not a Slack channel`);
      const r = await fetchFn("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ channel: target, text: text.slice(0, 3000), unfurl_links: false }),
      });
      const body = (await r.json().catch(() => ({}))) as { ok?: boolean; ts?: string; error?: string };
      if (!r.ok || !body.ok || !body.ts) throw new Error(`slack: ${body.error ?? `HTTP ${r.status}`}`);
      return { ts: body.ts };
    },
  };
}
