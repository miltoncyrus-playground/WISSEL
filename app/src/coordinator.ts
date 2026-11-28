// The coordinator window's data (docs/SDD-coordinator.md §4.14): one
// workstream's state, read from the routes the coordinator cards added,
// and the writes it makes, each through the server's own confirm step
// where the server asks for one (roles, duties, Shadow).

export type ProjectRole = "shadow" | "follow" | "decide" | "decide-over";

export interface WorkstreamProject {
  projectId: string;
  role: ProjectRole;
  decider?: string;
  decideAlone: string[];
  mustAsk: string[];
  never: string[];
}

export interface Workstream {
  id: string;
  name: string;
  ticket?: string;
  projects: WorkstreamProject[];
  channel?: { adapter: string; target: string };
  chat?: { adapter: string; channel: string };
  quietHours?: { start: string; end: string; timezone: string };
  digests?: { cron: string; timezone: string }[];
}

export interface Decision {
  id: string;
  text: string;
  alternative: string;
  lean?: string;
  by: string;
  status: "taken" | "flipped";
  at: string;
}

export interface OwnerTaskInfo {
  id: string;
  title: string;
  why: string;
  steps: string[];
  status: "open" | "done" | "dismissed";
  check?: string[];
  lastCheck?: { ok: boolean; output: string };
}

export interface InboxEventInfo {
  id: string;
  source: string;
  kind: string;
  payload: unknown;
  receivedAt: string;
  outcome?: string;
  untrusted: boolean;
}

export interface DutyInfo {
  duty: string;
  owner: "external" | "wissel";
}

export interface ChannelRow {
  id: string;
  message: { kind: string; text: string };
  status: "pending" | "posted" | "failed";
  queuedAt: string;
}

export interface GateRecordInfo {
  id: string;
  action: { kind: string; message?: string; decisionKind?: string };
  verdict: string;
  rule: string;
  mode: "live" | "shadow";
  at: string;
}

/** A card that hasn't started: it starts at `startsAt` unless held. */
export interface PlannedInfo {
  id: string;
  key?: string;
  title: string;
  startsAt?: string;
  held: boolean;
}

export interface WindowData {
  ws: Workstream;
  plans: PlannedInfo[];
  decisions: Decision[];
  ownerTasks: OwnerTaskInfo[];
  inbox: InboxEventInfo[];
  duties: DutyInfo[];
  channel: ChannelRow[];
  gateLog: GateRecordInfo[];
  shadow: boolean;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const fetchWorkstreams = () => get<Workstream[]>("/workstreams");

/** Everything the window shows for one workstream. */
export async function fetchWindow(id: string): Promise<WindowData> {
  const w = encodeURIComponent(id);
  const [ws, plans, decisions, ownerTasks, inbox, duties, channel, gateLog, shadow] = await Promise.all([
    get<Workstream>(`/workstreams/${w}`),
    get<PlannedInfo[]>(`/workstreams/${w}/plans`).catch(() => []),
    get<Decision[]>(`/workstreams/${w}/decisions`),
    get<OwnerTaskInfo[]>("/owner-tasks?status=open"),
    get<InboxEventInfo[]>(`/workstreams/${w}/inbox?limit=100`),
    get<DutyInfo[]>(`/workstreams/${w}/duties`),
    get<ChannelRow[]>(`/workstreams/${w}/channel`),
    get<GateRecordInfo[]>(`/workstreams/${w}/gate-log?limit=100`),
    get<{ on: boolean }>("/admin/shadow").then((s) => s.on, () => false),
  ]);
  return { ws, plans, decisions, ownerTasks, inbox, duties, channel, gateLog, shadow };
}

/** A write's answer: done, a confirm step the server asks for (its own
 *  words, shown before anything changes), or why it was refused. */
export type WriteResult = { kind: "done"; body: unknown } | { kind: "confirm"; message: string } | { kind: "error"; message: string };

export async function post(path: string, body?: unknown): Promise<WriteResult> {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    // no body
  }
  if (res.status === 409 && data.confirmRequired) return { kind: "confirm", message: String(data.message ?? "Confirm this change") };
  if (!res.ok) return { kind: "error", message: String(data.error ?? `HTTP ${res.status}`) };
  return { kind: "done", body: data };
}

/** A line for one inbox event, in plain words. */
export function eventLine(e: InboxEventInfo): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  if (e.kind === "owner.message") return `You: ${String(p.text ?? "")}`;
  if (e.kind === "channel.entry") return `${String(p.author ?? "Someone")} on the channel: ${String(p.text ?? "")}`;
  if (e.kind.startsWith("card.")) return `${String(p.key ?? p.title ?? "A card")} is ${e.kind.slice(5)}`;
  if (e.kind.startsWith("pr.")) return `PR #${String(p.number ?? "?")}: ${e.kind.slice(3).replace("checks-", "checks ")}`;
  if (e.kind === "host.short") return "The host is short of room; new cards wait";
  return e.kind;
}
