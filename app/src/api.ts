// The server endpoints the shell reads. Same origin: the server that
// serves /app also serves the API.

import type { AgentInfo, AskResult, Conversation, ConversationDetail, CoordinatorAsk, Decision, FeedPage, PendingResult, PipelineDef, PodcastEpisode, ProjectGit, ProjectInfo, ProjectRole, QuickAction, Schedule, TaskCard, WindowDocument, WindowMessageResult, Workstream, Wrapped } from "./types";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const fetchTasks = () => getJson<TaskCard[]>("/tasks");

export const fetchPipelines = () => getJson<PipelineDef[]>("/pipelines");

/** GET /projects: the registered projects. */
export const fetchProjects = () => getJson<ProjectInfo[]>("/projects");

/** GET /projects/:id/git: branches, worktrees and cards by ticket. */
export const fetchProjectGit = (id: string) => getJson<ProjectGit>(`/projects/${encodeURIComponent(id)}/git`);

/** GET /agents: the manifest, for names and personas. */
export const fetchAgents = () => getJson<AgentInfo[]>("/agents");

/** GET /wrapped: Wissel Wrapped for a period (`last 7 days`...). */
export const fetchWrapped = (period: string) => getJson<Wrapped>(`/wrapped?${new URLSearchParams({ period })}`);

/** GET /feed: newest first. `before` is a previous page's `next`. */
export function fetchFeed(limit: number, before?: string): Promise<FeedPage> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (before) q.set("before", before);
  return getJson<FeedPage>(`/feed?${q}`);
}

/** GET /podcasts: every podcast pipeline's episodes, newest first, at
 *  most `perPipeline` each. */
export const fetchPodcasts = (perPipeline: number) => getJson<PodcastEpisode[]>(`/podcasts?limit=${perPipeline}`);

/** A feed item's POST action (approve, retry): the endpoint the board
 *  calls for the same button. Throws the server's error message. */
export async function postAction(href: string): Promise<void> {
  const res = await fetch(href, { method: "POST" });
  if (res.ok) return;
  let message = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) message = body.error;
  } catch {
    // Not JSON: keep the status.
  }
  throw new Error(message);
}

/** POST /pipelines/:id/run with no repo or input, which suits the
 *  repo-less pipelines (the podcasts). The server answers when the run
 *  settles, so this can take minutes; a pipeline that needs a repo
 *  fails fast with the server's own message. Resolves to the settled
 *  root card, which can be "failed" even on a 201. */
export async function runPipeline(id: string): Promise<TaskCard> {
  const res = await fetch(`/pipelines/${encodeURIComponent(id)}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Not JSON: keep the status.
    }
    throw new Error(message);
  }
  return (await res.json()) as TaskCard;
}

/** The server's `{error}` message for a failed response, else the status. */
async function errorOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    // Not JSON: keep the status.
  }
  return `HTTP ${res.status}`;
}

/** POST /ask (docs/SDD-wissel-app.md §3.4): answers when the concierge
 *  has replied and its actions ran. No conversationId starts a chat. */
export async function postAsk(text: string, conversationId?: string): Promise<AskResult> {
  const res = await fetch("/ask", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(conversationId ? { conversationId, text } : { text }),
  });
  if (!res.ok) throw new Error(await errorOf(res));
  return (await res.json()) as AskResult;
}

/** POST /ask/actions/:id/confirm or /cancel (docs/SDD-wissel-app.md
 *  §3.7): a Confirm, Undo or Cancel tap. Throws the server's message
 *  (expired, already used, another chat's). */
export async function resolveAskAction(id: string, conversationId: string, verb: "confirm" | "cancel"): Promise<PendingResult> {
  const res = await fetch(`/ask/actions/${encodeURIComponent(id)}/${verb}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ conversationId }),
  });
  if (!res.ok) throw new Error(await errorOf(res));
  return (await res.json()) as PendingResult;
}

/** POST /voice (docs/SDD-wissel-app.md §3.5): a voice note in, its text
 *  out. Takes as long as speaches does. Throws the server's message. */
export async function postVoice(note: Blob, name: string): Promise<{ text: string }> {
  const form = new FormData();
  form.append("file", note, name);
  const res = await fetch("/voice", { method: "POST", body: form, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(await errorOf(res));
  return (await res.json()) as { text: string };
}

/** POST /ask/:messageId/audio: has Kokoro read a reply (or finds it
 *  cached) and answers with where the MP3 is. */
export async function postReplyAudio(messageId: string): Promise<{ audioUrl: string }> {
  const res = await fetch(`/ask/${encodeURIComponent(messageId)}/audio`, { method: "POST", headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(await errorOf(res));
  return (await res.json()) as { audioUrl: string };
}

/** GET /schedules (docs/SDD-schedules.md §3.5): every schedule, with its
 *  cadence in words. */
export const fetchSchedules = () => getJson<Schedule[]>("/schedules");

/** PATCH /schedules/:id with `enabled`: the Scheduled section's toggle.
 *  Resolves to the schedule as stored (its new `nextRunAt`). */
export async function setScheduleEnabled(id: string, enabled: boolean): Promise<Schedule> {
  const res = await fetch(`/schedules/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) throw new Error(await errorOf(res));
  return (await res.json()) as Schedule;
}

/** POST /schedules/:id/run-now: one run now, the next run left as it
 *  was. Throws the server's message (409 while the last run is going). */
export async function runScheduleNow(id: string): Promise<{ runId: string }> {
  const res = await fetch(`/schedules/${encodeURIComponent(id)}/run-now`, { method: "POST", headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(await errorOf(res));
  return (await res.json()) as { runId: string };
}

/** GET /conversations: most recently active first. */
export const fetchConversations = () => getJson<Conversation[]>("/conversations");

/** GET /conversations/:id, or null when it is gone. */
export async function fetchConversation(id: string): Promise<ConversationDetail | null> {
  const res = await fetch(`/conversations/${encodeURIComponent(id)}`, { headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await errorOf(res));
  return (await res.json()) as ConversationDetail;
}

/** POST with a JSON body (or none); throws the server's message. */
async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!res.ok) throw new Error(await errorOf(res));
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

/** The coordinator window (docs/SDD-coordinator.md §4.14, §5). */
export const fetchWorkstreams = () => getJson<Workstream[]>("/workstreams");
/** POST /workstreams: the server's message on a refusal (unknown project, empty name). */
export const createWorkstream = (input: { name: string; ticket?: string; projects: { projectId: string; role: ProjectRole }[] }) => postJson<Workstream>("/workstreams", input);
export const fetchWindow = (workstreamId: string) => getJson<WindowDocument>(`/workstreams/${enc(workstreamId)}/window`);
/** A quick action or free text; `log` writes the answer to the channel. */
export const postWindowMessage = (workstreamId: string, input: { action?: QuickAction; text?: string; log: boolean }) => postJson<WindowMessageResult>(`/workstreams/${enc(workstreamId)}/window/messages`, input);
/** The window's own Confirm or Cancel of a policy change. */
export const resolveWindowAction = (workstreamId: string, pendingId: string, verb: "confirm" | "cancel") => postJson<PendingResult>(`/workstreams/${enc(workstreamId)}/window/actions/${enc(pendingId)}/${verb}`);
/** POST /decisions/:id/flip: takes the alternative. */
export const flipDecision = (id: string) => postJson<Decision>(`/decisions/${enc(id)}/flip`);
/** The owner's answer to an ask (src/services/asks.ts): approve re-checks the hard limits and runs the action once; reject
 *  runs nothing. A 409 (a hard limit trips now, already resolved, the project is in Shadow) throws the server's words. */
export type AskOutcome = { ok: true; ask: CoordinatorAsk; result?: unknown; error?: string };
export const approveAsk = (workstreamId: string, askId: string) => postJson<AskOutcome>(`/workstreams/${enc(workstreamId)}/asks/${enc(askId)}/approve`);
export const rejectAsk = (workstreamId: string, askId: string) => postJson<AskOutcome>(`/workstreams/${enc(workstreamId)}/asks/${enc(askId)}/reject`);
/** A role change is the owner's and goes with confirm: true, after the window's confirm click. */
export const setProjectRole = (workstreamId: string, projectId: string, role: ProjectRole) => postJson<Workstream>(`/workstreams/${enc(workstreamId)}/projects/${enc(projectId)}/role`, { confirm: true, role });

/** POST /owner-tasks/:id/done runs the task's check; a failing check
 *  answers 409 with the check's output, and the task stays open. */
export async function ownerTaskDone(id: string): Promise<{ ok: true } | { ok: false; error: string; output?: string }> {
  const res = await fetch(`/owner-tasks/${enc(id)}/done`, { method: "POST", headers: { accept: "application/json" } });
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => ({}))) as { error?: string; output?: string };
  return { ok: false, error: body.error ?? `HTTP ${res.status}`, ...(body.output ? { output: body.output } : {}) };
}

/** The notice for a settled run, from the root card's status. */
export function runNotice(name: string, root: Pick<TaskCard, "status">): string {
  if (root.status === "done") return `${name} finished.`;
  if (root.status === "failed") return `${name} failed. Open the card on the board for details.`;
  return `${name} stopped at ${root.status}.`;
}
