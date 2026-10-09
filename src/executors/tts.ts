import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentDef, Executor, TaskCard, TaskResult } from "../core/types.ts";

/**
 * The "Make audio" step of the AI news podcast pipeline
 * (docs/SDD-ai-news-podcast.md §3.7): reads the script the scriptwriter
 * step handed off, has the local Kokoro-FastAPI service speak it, and
 * saves the MP3 as `<audioDir>/<pipelineRunId>.mp3`, which
 * `GET /pipeline-runs/:id/audio` (src/api/server.ts) serves to the run
 * drawer.
 *
 * Deterministic code, not an agent: no LLM, no prompt, no harness
 * (`harnessTool` is undefined, so the pipeline runner acquires none).
 * Kokoro is a local model behind an OpenAI-compatible HTTP endpoint,
 * not a hosted API. Every failure (service down, unhealthy, HTTP error,
 * timeout, a body that isn't audio) fails the step with the reason and
 * leaves no file behind.
 */

export const DEFAULT_TTS_URL = "http://127.0.0.1:8880";
export const DEFAULT_TTS_VOICE = "af_heart";
/** About 1.2x real time on this machine's 2-core CPU (§3.7): a 5 minute
 *  script takes 4 to 5 minutes. 20 minutes leaves room for longer ones. */
export const DEFAULT_TTS_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 10_000;

export function defaultAudioDir(home = homedir()): string {
  return join(home, ".wissel", "audio");
}

/** Where a run's audio lives. The one place the file name is decided:
 *  the executor writes it, the server reads it. */
export function audioFilePath(audioDir: string, runId: string): string {
  return join(audioDir, `${runId}.mp3`);
}

/** What GET /pipeline-runs/:id/audio may serve. A run id is a board task
 *  id (a UUID), checked against the board too; this shape check is the
 *  first gate, so nothing with a slash or a dot ever reaches a path. */
export function isSafeRunId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

export interface TtsExecutorOptions {
  /** Kokoro-FastAPI base URL (`WISSEL_TTS_URL`). */
  baseUrl?: string;
  /** Kokoro voice id (`WISSEL_TTS_VOICE`). */
  voice?: string;
  /** Where MP3s are written (`WISSEL_AUDIO_DIR`); tests pass a temp dir. */
  audioDir?: string;
  /** Whole synthesis request, body included. Tests shorten it. */
  timeoutMs?: number;
  healthTimeoutMs?: number;
}

export interface TtsAudio {
  file: string;
  voice: string;
  bytes: number;
  synthesisSeconds: number;
}

/**
 * The scriptwriter's `data.script` out of this step's body. The pipeline
 * runner hands the previous step's handoff over as JSON in a block
 * fenced ```untrusted-<first 8 chars of the run id> (buildNextStepBody,
 * src/core/pipeline-runner.ts), and puts it last in the body. The block
 * is found by that exact fence and runs to the body's last ``` line, so
 * a script that itself contains backticks still parses.
 */
export function extractScript(body: string, runId: string | undefined): { script: string } | { error: string } {
  if (!runId) return { error: "this task isn't part of a pipeline run, so there is no handed-off script" };
  const fence = "```untrusted-" + runId.slice(0, 8) + "\n";
  const start = body.lastIndexOf(fence);
  if (start === -1) return { error: "no data was handed off from the previous step (expected the scriptwriter's script)" };
  const end = body.lastIndexOf("\n```");
  if (end < start + fence.length) return { error: "the handed-off data block isn't closed" };
  let payload: unknown;
  try {
    payload = JSON.parse(body.slice(start + fence.length, end));
  } catch (e) {
    return { error: `the handed-off data isn't valid JSON: ${(e as Error).message}` };
  }
  const data = (payload as { data?: unknown } | null)?.data;
  const script = data && typeof data === "object" ? (data as { script?: unknown }).script : undefined;
  if (typeof script !== "string" || script.trim() === "") {
    return { error: "the handed-off data has no `script` text (is the previous step the podcast scriptwriter?)" };
  }
  return { script: script.trim() };
}

function formatSeconds(ms: number): string {
  return ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 100) / 10} s`;
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 300 ? flat.slice(0, 300) + "..." : flat;
}

export class TtsExecutor implements Executor {
  readonly id = "tts";
  private baseUrl: string;
  private voice: string;
  private audioDir: string;
  private timeoutMs: number;
  private healthTimeoutMs: number;

  constructor(opts: TtsExecutorOptions = {}) {
    this.baseUrl = (opts.baseUrl || DEFAULT_TTS_URL).replace(/\/+$/, "");
    this.voice = opts.voice || DEFAULT_TTS_VOICE;
    this.audioDir = opts.audioDir || defaultAudioDir();
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TTS_TIMEOUT_MS;
    this.healthTimeoutMs = opts.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  }

  canHandle(agent: AgentDef): boolean {
    return agent.executor === "tts";
  }

  async run(task: TaskCard, agent: AgentDef): Promise<TaskResult> {
    const fail = (reason: string): TaskResult => ({ taskId: task.id, agentId: agent.id, ok: false, summary: `Audio not made: ${reason}` });

    const runId = task.pipelineRunId;
    const extracted = extractScript(task.body, runId);
    if ("error" in extracted) return fail(extracted.error);
    if (!isSafeRunId(runId!)) return fail(`run id "${runId}" can't be used as a file name`);

    const health = await this.checkHealth();
    if (health) return fail(health);

    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let audio: Uint8Array;
    try {
      const res = await fetch(`${this.baseUrl}/v1/audio/speech`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "kokoro", voice: this.voice, input: extracted.script, response_format: "mp3" }),
        signal: controller.signal,
      });
      if (!res.ok) return fail(`Kokoro TTS at ${this.baseUrl} returned HTTP ${res.status}: ${snippet(await res.text())}`);
      const type = res.headers.get("content-type") ?? "";
      if (!/^audio\//i.test(type)) {
        return fail(`Kokoro TTS at ${this.baseUrl} returned ${type || "no content type"}, not audio: ${snippet(await res.text())}`);
      }
      audio = new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      if (controller.signal.aborted) return fail(`Kokoro TTS at ${this.baseUrl} timed out after ${formatSeconds(this.timeoutMs)}`);
      return fail(`Kokoro TTS at ${this.baseUrl} failed mid-request: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    if (audio.byteLength === 0) return fail(`Kokoro TTS at ${this.baseUrl} returned an empty audio body`);
    const synthesisSeconds = Math.round((performance.now() - started) / 100) / 10;

    // Written next to the target and renamed into place, so a crash or a
    // full disk mid-write never leaves a truncated MP3 the drawer would
    // offer as finished.
    const file = audioFilePath(this.audioDir, runId!);
    const part = `${file}.part`;
    try {
      await mkdir(this.audioDir, { recursive: true });
      await writeFile(part, audio);
      await rename(part, file);
    } catch (e) {
      await rm(part, { force: true }).catch(() => {});
      return fail(`couldn't save the audio to ${file}: ${(e as Error).message}`);
    }

    const result: TtsAudio = { file, voice: this.voice, bytes: audio.byteLength, synthesisSeconds };
    console.log(`tts: run ${runId} audio ${result.bytes} bytes in ${synthesisSeconds}s (voice ${this.voice}) -> ${file}`);
    const data = { audio: result };
    return {
      taskId: task.id,
      agentId: agent.id,
      ok: true,
      summary: [
        `Audio made with Kokoro (voice ${this.voice}): ${(result.bytes / 1_000_000).toFixed(1)} MB in ${synthesisSeconds} s, saved to ${file}.`,
        "",
        "```pipeline-handoff",
        JSON.stringify({ data }),
        "```",
      ].join("\n"),
      actualCost: 0,
      pipelineHandoff: { data },
    };
  }

  /** null when Kokoro says it's healthy, else why not. */
  private async checkHealth(): Promise<string | null> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(this.healthTimeoutMs) });
    } catch (e) {
      const err = e as Error;
      const why = err.name === "TimeoutError" ? `no answer within ${formatSeconds(this.healthTimeoutMs)}` : err.message;
      return `Kokoro TTS isn't reachable at ${this.baseUrl} (${why}). Is the kokoro-tts container running?`;
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) return `Kokoro TTS health check at ${this.baseUrl}/health returned HTTP ${res.status}: ${snippet(text)}`;
    let status: unknown;
    try {
      status = (JSON.parse(text) as { status?: unknown }).status;
    } catch {
      status = undefined;
    }
    if (status !== "healthy") return `Kokoro TTS at ${this.baseUrl} isn't healthy: /health said ${snippet(text) || "nothing"}`;
    return null;
  }
}
