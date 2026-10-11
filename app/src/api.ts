// The server endpoints the shell reads. Same origin: the server that
// serves /app also serves the API.

import type { AgentInfo, AskResult, Conversation, ConversationDetail, FeedPage, PipelineDef, PodcastEpisode, TaskCard, Wrapped } from "./types";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const fetchTasks = () => getJson<TaskCard[]>("/tasks");

export const fetchPipelines = () => getJson<PipelineDef[]>("/pipelines");

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

/** GET /conversations: most recently active first. */
export const fetchConversations = () => getJson<Conversation[]>("/conversations");

/** GET /conversations/:id, or null when it is gone. */
export async function fetchConversation(id: string): Promise<ConversationDetail | null> {
  const res = await fetch(`/conversations/${encodeURIComponent(id)}`, { headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await errorOf(res));
  return (await res.json()) as ConversationDetail;
}

/** The notice for a settled run, from the root card's status. */
export function runNotice(name: string, root: Pick<TaskCard, "status">): string {
  if (root.status === "done") return `${name} finished.`;
  if (root.status === "failed") return `${name} failed. Open the card on the board for details.`;
  return `${name} stopped at ${root.status}.`;
}
