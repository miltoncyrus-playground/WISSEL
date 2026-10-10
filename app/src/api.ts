// The server endpoints the shell reads. Same origin: the server that
// serves /app also serves the API.

import type { PipelineDef, TaskCard } from "./types";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const fetchTasks = () => getJson<TaskCard[]>("/tasks");

export const fetchPipelines = () => getJson<PipelineDef[]>("/pipelines");

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

/** The notice for a settled run, from the root card's status. */
export function runNotice(name: string, root: Pick<TaskCard, "status">): string {
  if (root.status === "done") return `${name} finished.`;
  if (root.status === "failed") return `${name} failed. Open the card on the board for details.`;
  return `${name} stopped at ${root.status}.`;
}
