import type { AgentDef, PipelineDef, PipelineGraph, TaskCard } from "./types";

// Same-origin fetches — this app is served by the same Bun process as
// the /agents and /pipelines API (src/api/server.ts), whether that's the
// real production server or `vite`'s dev proxy (see vite.config.ts).

async function unwrap<T>(res: Response, notFoundMessage: string): Promise<T> {
  if (res.status === 404) throw new Error(notFoundMessage);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export async function listAgents(): Promise<AgentDef[]> {
  const res = await fetch("/agents");
  return unwrap<AgentDef[]>(res, "could not load agents");
}

export async function listPipelines(): Promise<PipelineDef[]> {
  const res = await fetch("/pipelines");
  return unwrap<PipelineDef[]>(res, "could not load pipelines");
}

export async function getPipeline(id: string): Promise<PipelineDef> {
  const res = await fetch(`/pipelines/${encodeURIComponent(id)}`);
  return unwrap<PipelineDef>(res, `pipeline ${id} not found`);
}

export async function createPipeline(input: { name: string; description: string; graph: PipelineGraph }): Promise<PipelineDef> {
  const res = await fetch("/pipelines", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return unwrap<PipelineDef>(res, "could not create pipeline");
}

export async function updatePipeline(id: string, input: { name: string; description: string; graph: PipelineGraph }): Promise<PipelineDef> {
  const res = await fetch(`/pipelines/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return unwrap<PipelineDef>(res, `pipeline ${id} not found`);
}

export async function runPipeline(id: string, input: { repo: string; input: string }): Promise<TaskCard> {
  const res = await fetch(`/pipelines/${encodeURIComponent(id)}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return unwrap<TaskCard>(res, `pipeline ${id} not found`);
}
