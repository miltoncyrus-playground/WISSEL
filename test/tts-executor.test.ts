import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNextStepBody } from "../src/core/pipeline-runner.ts";
import { Registry } from "../src/core/registry.ts";
import type { AgentDef, Executor, TaskCard } from "../src/core/types.ts";
import { parsePipelineHandoff } from "../src/executors/parse-pipeline-handoff.ts";
import {
  DEFAULT_TTS_TIMEOUT_MS,
  DEFAULT_TTS_URL,
  DEFAULT_TTS_VOICE,
  TtsExecutor,
  audioFilePath,
  defaultAudioDir,
  extractScript,
  isSafeRunId,
} from "../src/executors/tts.ts";
import { SILENT_MP3_PATH, silentMp3 } from "./fixtures/ai-news/make-silent-mp3.ts";

// docs/SDD-ai-news-podcast.md §3.7: the "Make audio" step. Every test
// talks to a fake Kokoro (Bun.serve on port 0), never the real one.

const FIXTURES = join(import.meta.dir, "fixtures", "ai-news");
const SCRIPT_SUMMARY = readFileSync(join(FIXTURES, "script-summary.md"), "utf8");
const SCRIPT_DATA = parsePipelineHandoff(SCRIPT_SUMMARY)!.data as { script: string };
const MP3 = new Uint8Array(readFileSync(SILENT_MP3_PATH));
const RUN_ID = "3f2a9c1e-7b4d-4e8a-9c0f-1a2b3c4d5e6f";

/** The audio step's body exactly as a real run builds it: the run input
 *  plus the scriptwriter's handoff, fenced by buildNextStepBody. */
function audioTask(overrides: Partial<TaskCard> = {}): TaskCard {
  const handoff = parsePipelineHandoff(SCRIPT_SUMMARY)!;
  return {
    id: "step-audio",
    title: "AI news podcast: Make audio",
    body: buildNextStepBody("focus on open models", handoff, (overrides.pipelineRunId ?? RUN_ID).slice(0, 8)),
    labels: [],
    status: "running",
    pipelineId: "p",
    pipelineRunId: RUN_ID,
    pipelineStepId: "audio",
    ...overrides,
  };
}

let audioAgent: AgentDef;

type Mode = "ok" | "http500" | "html" | "slow" | "unhealthy" | "health500" | "empty";

interface FakeKokoro {
  url: string;
  mode: Mode;
  requests: { path: string; body: unknown }[];
  /** /health answers 503 this many more times before behaving per mode
   *  (Kokoro busy with another synthesis, or still starting). */
  healthBusy: number;
  /** Speech requests in flight now, and the most seen at once. */
  inFlight: number;
  maxInFlight: number;
  stop(): void;
}

function startFakeKokoro(): FakeKokoro {
  const state: FakeKokoro = { url: "", mode: "ok", requests: [], healthBusy: 0, inFlight: 0, maxInFlight: 0, stop: () => {} };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/health") {
        state.requests.push({ path, body: null });
        if (state.healthBusy > 0) {
          state.healthBusy--;
          return new Response("busy", { status: 503 });
        }
        if (state.mode === "health500") return new Response("boom", { status: 500 });
        return Response.json({ status: state.mode === "unhealthy" ? "loading" : "healthy" });
      }
      if (path === "/v1/audio/speech" && req.method === "POST") {
        state.requests.push({ path, body: await req.json() });
        if (state.mode === "http500") return new Response('{"detail":"voice not found"}', { status: 500, headers: { "content-type": "application/json" } });
        if (state.mode === "html") return new Response("<html>proxy error</html>", { headers: { "content-type": "text/html" } });
        if (state.mode === "empty") return new Response(new Uint8Array(0), { headers: { "content-type": "audio/mpeg" } });
        state.inFlight++;
        state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
        try {
          if (state.mode === "slow") await Bun.sleep(400);
        } finally {
          state.inFlight--;
        }
        return new Response(MP3, { headers: { "content-type": "audio/mpeg" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  state.url = `http://127.0.0.1:${server.port}`;
  state.stop = () => server.stop(true);
  return state;
}

let kokoro: FakeKokoro;
let audioDir: string;

beforeAll(async () => {
  audioAgent = (await Registry.load()).get("podcast-audio")!;
  kokoro = startFakeKokoro();
});
afterAll(() => kokoro.stop());

async function freshDir(): Promise<string> {
  audioDir = await mkdtemp(join(tmpdir(), "wissel-tts-"));
  return audioDir;
}

async function filesIn(dir: string): Promise<string[]> {
  return existsSync(dir) ? (await readdir(dir)).sort() : [];
}

describe("TtsExecutor", () => {
  test("success: the scriptwriter's script goes to Kokoro, the MP3 lands at <audioDir>/<runId>.mp3, and the result is a pipeline-handoff with data.audio", async () => {
    kokoro.mode = "ok";
    kokoro.requests = [];
    const dir = await freshDir();
    try {
      const result = await new TtsExecutor({ baseUrl: kokoro.url, voice: "bf_emma", audioDir: dir }).run(audioTask(), audioAgent);

      expect(result.ok).toBe(true);
      expect(result.taskId).toBe("step-audio");
      expect(result.agentId).toBe("podcast-audio");
      expect(result.actualCost).toBe(0);
      const file = join(dir, `${RUN_ID}.mp3`);
      expect(new Uint8Array(readFileSync(file))).toEqual(MP3);
      expect(await filesIn(dir)).toEqual([`${RUN_ID}.mp3`]); // no .part left behind

      const audio = (result.pipelineHandoff!.data as { audio: Record<string, unknown> }).audio;
      expect(audio).toEqual({ file, voice: "bf_emma", bytes: MP3.byteLength, synthesisSeconds: expect.any(Number) });
      expect(audio.synthesisSeconds as number).toBeGreaterThanOrEqual(0);
      // The summary carries the same block, so the drawer and the eval can
      // parse it back out of task_results like every other step.
      expect(parsePipelineHandoff(result.summary)).toEqual(result.pipelineHandoff!);

      // Health first, then one speech request with the exact §3.7 body.
      expect(kokoro.requests.map((r) => r.path)).toEqual(["/health", "/v1/audio/speech"]);
      expect(kokoro.requests[1]!.body).toEqual({ model: "kokoro", voice: "bf_emma", input: SCRIPT_DATA.script, response_format: "mp3" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("defaults: voice af_heart, Kokoro on 127.0.0.1:8880, ~/.wissel/audio, 20 minute timeout", async () => {
    expect(DEFAULT_TTS_VOICE).toBe("af_heart");
    expect(DEFAULT_TTS_URL).toBe("http://127.0.0.1:8880");
    expect(DEFAULT_TTS_TIMEOUT_MS).toBe(20 * 60 * 1000);
    expect(defaultAudioDir("/home/x")).toBe("/home/x/.wissel/audio");
    kokoro.mode = "ok";
    kokoro.requests = [];
    const dir = await freshDir();
    try {
      // A trailing slash on the URL is tolerated.
      const result = await new TtsExecutor({ baseUrl: kokoro.url + "/", audioDir: dir }).run(audioTask(), audioAgent);
      expect(result.ok).toBe(true);
      expect((kokoro.requests[1]!.body as { voice: string }).voice).toBe("af_heart");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  const failures: { name: string; setup: () => { baseUrl: string; timeoutMs?: number }; reason: RegExp }[] = [
    {
      name: "service down",
      // A port nothing listens on: a stopped server's.
      setup: () => {
        const dead = Bun.serve({ port: 0, fetch: () => new Response() });
        const url = `http://127.0.0.1:${dead.port}`;
        dead.stop(true);
        return { baseUrl: url };
      },
      reason: /^Audio not made: Kokoro TTS isn't reachable at http:\/\/127\.0\.0\.1:\d+ \(.+\)\. Is the kokoro-tts container running\?$/,
    },
    { name: "unhealthy", setup: () => ((kokoro.mode = "unhealthy"), { baseUrl: kokoro.url }), reason: /isn't healthy: \/health said \{"status":"loading"\}$/ },
    { name: "health HTTP 500", setup: () => ((kokoro.mode = "health500"), { baseUrl: kokoro.url }), reason: /health check at .*\/health returned HTTP 500: boom$/ },
    { name: "speech HTTP 500", setup: () => ((kokoro.mode = "http500"), { baseUrl: kokoro.url }), reason: /returned HTTP 500: \{"detail":"voice not found"\}$/ },
    { name: "non-audio content type", setup: () => ((kokoro.mode = "html"), { baseUrl: kokoro.url }), reason: /returned text\/html, not audio: <html>proxy error<\/html>$/ },
    { name: "empty audio body", setup: () => ((kokoro.mode = "empty"), { baseUrl: kokoro.url }), reason: /returned an empty audio body$/ },
    { name: "timeout", setup: () => ((kokoro.mode = "slow"), { baseUrl: kokoro.url, timeoutMs: 100 }), reason: /timed out after 0\.1 s$/ },
  ];

  for (const f of failures) {
    test(`fails loud with the reason, and writes no file: ${f.name}`, async () => {
      const dir = await freshDir();
      try {
        const opts = f.setup();
        const result = await new TtsExecutor({ healthWaitMs: 0, ...opts, audioDir: dir }).run(audioTask(), audioAgent);
        expect(result.ok).toBe(false);
        expect(result.summary).toMatch(f.reason);
        expect(result.pipelineHandoff).toBeUndefined();
        expect(await filesIn(dir)).toEqual([]);
      } finally {
        kokoro.mode = "ok";
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  // Regression, 2026-10-10 06:00: both news pipelines reached "Make
  // audio" together; the second step's /health got no answer within 10 s
  // while Kokoro synthesized the first, and the step failed.
  test("two audio steps at once are queued: Kokoro never gets two syntheses at the same time, and both succeed", async () => {
    const dirA = await freshDir();
    const dirB = await freshDir();
    try {
      // An earlier test's aborted request may still be sleeping in the
      // fake server; start from an idle server.
      while (kokoro.inFlight > 0) await Bun.sleep(20);
      kokoro.mode = "slow";
      kokoro.maxInFlight = 0;
      const a = new TtsExecutor({ baseUrl: kokoro.url, audioDir: dirA });
      const b = new TtsExecutor({ baseUrl: kokoro.url, audioDir: dirB });
      const [ra, rb] = await Promise.all([a.run(audioTask(), audioAgent), b.run(audioTask({ pipelineRunId: "9b8c7d6e-0000-4000-8000-000000000002", id: "step-b" }), audioAgent)]);
      expect([ra.ok, rb.ok]).toEqual([true, true]);
      expect(kokoro.maxInFlight).toBe(1);
      expect(await filesIn(dirA)).toEqual([`${RUN_ID}.mp3`]);
      expect(await filesIn(dirB)).toEqual(["9b8c7d6e-0000-4000-8000-000000000002.mp3"]);
    } finally {
      kokoro.mode = "ok";
      await rm(dirA, { recursive: true, force: true });
      await rm(dirB, { recursive: true, force: true });
    }
  });

  test("a busy /health is retried until Kokoro answers, then the audio is made", async () => {
    const dir = await freshDir();
    try {
      kokoro.healthBusy = 2;
      const result = await new TtsExecutor({ baseUrl: kokoro.url, audioDir: dir, healthWaitMs: 5000, healthRetryMs: 20 }).run(audioTask(), audioAgent);
      expect(result.ok).toBe(true);
      expect(kokoro.healthBusy).toBe(0);
    } finally {
      kokoro.healthBusy = 0;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a /health that stays busy past the wait fails loud, naming the wait, and writes nothing", async () => {
    const dir = await freshDir();
    try {
      kokoro.healthBusy = 1000;
      const result = await new TtsExecutor({ baseUrl: kokoro.url, audioDir: dir, healthWaitMs: 150, healthRetryMs: 40 }).run(audioTask(), audioAgent);
      expect(result.ok).toBe(false);
      expect(result.summary).toMatch(/returned HTTP 503: busy \(still not ready after waiting [0-9.]+ s\)$/);
      expect(await filesIn(dir)).toEqual([]);
    } finally {
      kokoro.healthBusy = 0;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the synthesis request turns off Bun's 5 minute idle timeout (syntheses take 4 to 5 minutes here)", async () => {
    const dir = await freshDir();
    const spy = spyOn(globalThis, "fetch");
    try {
      await new TtsExecutor({ baseUrl: kokoro.url, audioDir: dir }).run(audioTask(), audioAgent);
      const speech = spy.mock.calls.find((c) => String(c[0]).endsWith("/v1/audio/speech"));
      expect(speech).toBeDefined();
      expect((speech![1] as BunFetchRequestInit).timeout).toBe(false);
    } finally {
      spy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a body with no handed-off script fails before calling Kokoro", async () => {
    kokoro.requests = [];
    const dir = await freshDir();
    try {
      const exec = new TtsExecutor({ baseUrl: kokoro.url, audioDir: dir });
      const noData = await exec.run(audioTask({ body: "focus on open models" }), audioAgent);
      expect(noData.summary).toBe("Audio not made: no data was handed off from the previous step (expected the scriptwriter's script)");
      const noRun = await exec.run(audioTask({ pipelineRunId: undefined }), audioAgent);
      expect(noRun.ok).toBe(false);
      expect(kokoro.requests).toEqual([]);
      expect(await filesIn(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("extractScript", () => {
  test("reads the script out of a real recorded scriptwriter handoff, fenced the way the runner fences it", () => {
    expect(extractScript(audioTask().body, RUN_ID)).toEqual({ script: SCRIPT_DATA.script });
    expect(SCRIPT_DATA.script).toContain("\n\n"); // paragraphs reach Kokoro intact
  });

  test("only the fence for this run counts; backticks inside the script don't cut it short", () => {
    const tricky = { data: { script: "Say ``` out loud.\n\nThen stop." } };
    expect(extractScript(buildNextStepBody("in", tricky, RUN_ID.slice(0, 8)), RUN_ID)).toEqual({ script: "Say ``` out loud.\n\nThen stop." });
    expect(extractScript(buildNextStepBody("in", tricky, "deadbeef"), RUN_ID)).toMatchObject({ error: expect.stringContaining("no data was handed off") });
  });

  test("bad shapes are errors, never a guess", () => {
    const body = (data: unknown) => buildNextStepBody("in", { data: data as Record<string, unknown> }, RUN_ID.slice(0, 8));
    expect(extractScript(body({ quickRead: [] }), RUN_ID)).toMatchObject({ error: expect.stringContaining("no `script` text") });
    expect(extractScript(body({ script: "   " }), RUN_ID)).toMatchObject({ error: expect.stringContaining("no `script` text") });
    expect(extractScript(body({ script: 7 }), RUN_ID)).toMatchObject({ error: expect.stringContaining("no `script` text") });
    const broken = "in\n\n```untrusted-" + RUN_ID.slice(0, 8) + "\n{not json\n```";
    expect(extractScript(broken, RUN_ID)).toMatchObject({ error: expect.stringContaining("isn't valid JSON") });
    expect(extractScript("in", undefined)).toMatchObject({ error: expect.stringContaining("isn't part of a pipeline run") });
  });
});

describe("audio file naming", () => {
  test("isSafeRunId accepts task ids and rejects anything that could leave the audio dir", () => {
    expect(isSafeRunId(RUN_ID)).toBe(true);
    for (const bad of ["", "..", "../x", "a/b", "a\\b", "%2e%2e", "x.mp3", "a b", "x".repeat(129)]) expect(isSafeRunId(bad), bad).toBe(false);
    expect(audioFilePath("/a", RUN_ID)).toBe(`/a/${RUN_ID}.mp3`);
  });

  test("the checked-in silent MP3 fixture is exactly what make-silent-mp3.ts generates, and stays small", () => {
    expect(MP3).toEqual(silentMp3());
    expect(MP3.byteLength).toBeLessThan(20_000);
  });
});

describe("executor routing", () => {
  test("podcast-audio loads with executor tts, one unique tag, no tools, kokoro at $0, and repo-less", async () => {
    const registry = await Registry.load();
    const a = registry.get("podcast-audio")!;
    expect(a).toMatchObject({ tier: "readonly", executor: "tts", toolAccess: [], costProfile: { model: "kokoro", estUsdPerTask: 0 } });
    expect(a.tags).toEqual(["ai-news-audio-step"]);
    expect(registry.all().filter((o) => o.id !== a.id && o.tags.includes(a.tags[0]!))).toEqual([]);
    expect(a.outputContract).toBeUndefined();
  });

  test("TtsExecutor has no harness tool and handles executor tts only", async () => {
    const exec: Executor = new TtsExecutor();
    expect(exec.harnessTool).toBeUndefined();
    const registry = await Registry.load();
    expect(registry.all().filter((a) => exec.canHandle(a)).map((a) => a.id)).toEqual(["podcast-audio"]);
  });
});
