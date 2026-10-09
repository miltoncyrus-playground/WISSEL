#!/usr/bin/env bun
/**
 * Runs stored pipelines by name through the live server's
 * `POST /pipelines/:id/run`, all at once, and waits for every run to
 * settle. Used by the systemd timer in ops/systemd/ (the 06:00 news
 * podcasts); works the same from a shell.
 *
 *   bun run scripts/run-pipelines.ts "AI news podcast" "World news podcast"
 *
 * Looks pipelines up by name on every run (ids differ per machine and a
 * reseed keeps them, but a name is what a human types). Waits for the
 * server to answer `GET /version` first (up to WISSEL_RUN_WAIT_SECONDS,
 * default 600), so a timer that fires right after a boot doesn't fail
 * before wissel is up. Exits 1 if any pipeline is missing or any run
 * doesn't end "done", so systemd records the failure.
 *
 * WISSEL_URL: server base URL, default http://127.0.0.1:8787.
 */

export interface RunOutcome {
  name: string;
  ok: boolean;
  /** The run root's id when a run started. */
  runId?: string;
  status?: string;
  error?: string;
  seconds: number;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export async function waitForServer(base: string, waitSeconds: number, fetchImpl: Fetch = fetch, sleep = (ms: number) => Bun.sleep(ms)): Promise<boolean> {
  const deadline = Date.now() + waitSeconds * 1000;
  for (;;) {
    try {
      const r = await fetchImpl(`${base}/version`);
      if (r.ok) return true;
    } catch {
      // not up yet
    }
    if (Date.now() >= deadline) return false;
    await sleep(5000);
  }
}

export async function runPipelineByName(base: string, name: string, fetchImpl: Fetch = fetch): Promise<RunOutcome> {
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 1000);
  try {
    const list = (await (await fetchImpl(`${base}/pipelines`)).json()) as { id: string; name: string }[];
    const matches = list.filter((p) => p.name === name);
    if (matches.length === 0) return { name, ok: false, error: `no stored pipeline named "${name}"`, seconds: seconds() };
    if (matches.length > 1) return { name, ok: false, error: `${matches.length} stored pipelines are named "${name}"; rename one`, seconds: seconds() };
    const res = await fetchImpl(`${base}/pipelines/${matches[0]!.id}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; status?: string; error?: string };
    if (!res.ok) return { name, ok: false, error: body.error ?? `HTTP ${res.status}`, seconds: seconds() };
    return { name, ok: body.status === "done", runId: body.id, status: body.status, seconds: seconds() };
  } catch (e) {
    return { name, ok: false, error: (e as Error).message, seconds: seconds() };
  }
}

export async function runPipelines(base: string, names: string[], fetchImpl: Fetch = fetch): Promise<RunOutcome[]> {
  return Promise.all(names.map((n) => runPipelineByName(base, n, fetchImpl)));
}

if (import.meta.main) {
  const names = process.argv.slice(2);
  if (names.length === 0) {
    console.error('usage: bun run scripts/run-pipelines.ts "<pipeline name>" [...]');
    process.exit(2);
  }
  const base = (process.env.WISSEL_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
  const wait = Number(process.env.WISSEL_RUN_WAIT_SECONDS ?? 600);
  if (!(await waitForServer(base, wait))) {
    console.error(`run-pipelines: wissel at ${base} did not answer within ${wait}s; nothing run`);
    process.exit(1);
  }
  console.log(`run-pipelines: starting ${names.map((n) => `"${n}"`).join(", ")} at ${new Date().toISOString()}`);
  const outcomes = await runPipelines(base, names);
  for (const o of outcomes) console.log(`run-pipelines: ${JSON.stringify(o)}`);
  process.exit(outcomes.every((o) => o.ok) ? 0 : 1);
}
