import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type CreateAppOptions } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { ReadOnlyExecutor } from "../src/executors/readonly.ts";
import { TtsExecutor } from "../src/executors/tts.ts";
import { replyAudioDir, spokenText } from "../src/services/reply-audio.ts";
import type { CommandRunner } from "../src/executors/claude-cli.ts";
import type { ChatMessage } from "../src/services/conversations.ts";
import { startFakeSpeaches } from "./fixtures/fake-speaches.ts";
import { SILENT_MP3_PATH } from "./fixtures/ai-news/make-silent-mp3.ts";

// docs/SDD-wissel-app.md §3.5 through the real server: POST /voice
// against a fake speaches, POST/GET /ask/:messageId/audio against a fake
// Kokoro. No model, no Docker.

const MP3 = new Uint8Array(readFileSync(SILENT_MP3_PATH));
const home = await mkdtemp(join(tmpdir(), "wissel-voice-test-"));
afterAll(() => rm(home, { recursive: true, force: true }));

const speaches = startFakeSpeaches();
afterAll(() => speaches.stop());

/** A fake Kokoro: /health and /v1/audio/speech, recording what it was asked to say. */
const kokoro = (() => {
  const state = { url: "", inputs: [] as string[], slowMs: 0, down: false, stop: () => {} };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/health") return state.down ? new Response("down", { status: 500 }) : Response.json({ status: "healthy" });
      if (path === "/v1/audio/speech") {
        const body = (await req.json()) as { input: string };
        state.inputs.push(body.input);
        if (state.slowMs) await Bun.sleep(state.slowMs);
        return new Response(MP3, { headers: { "content-type": "audio/mpeg" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  state.url = `http://127.0.0.1:${server.port}`;
  state.stop = () => server.stop(true);
  return state;
})();
afterAll(() => kokoro.stop());

beforeEach(() => {
  speaches.mode = "ok";
  speaches.requests = [];
  speaches.healthChecks = 0;
  kokoro.inputs = [];
  kokoro.slowMs = 0;
  kokoro.down = false;
});

const REPLY = "Made a card to **check the README**. See [the board](http://localhost:8787/board).";

/** A fake `claude -p` answering every call with REPLY, after `delayMs`. */
function concierge(delayMs = 0): CommandRunner {
  return async () => {
    if (delayMs) await Bun.sleep(delayMs);
    const result = "```wissel-actions\n" + JSON.stringify({ reply: REPLY, actions: [] }) + "\n```";
    return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result, total_cost_usd: 0.01 }), stderr: "", exitCode: 0 };
  };
}

let dirCount = 0;
async function setup(opts: CreateAppOptions & { delayMs?: number } = {}) {
  const audioDir = join(home, `audio-${++dirCount}`);
  const app = createApp(new SqliteBoard(), await Registry.load(), undefined, {
    conciergeExecutor: new ReadOnlyExecutor({ runner: concierge(opts.delayMs) }),
    conciergeHarnesses: HarnessPool.from([{ id: "claude", tool: "claude-cli", label: "Claude", enabled: true }]),
    conciergeHomeDir: home,
    audioDir,
    stt: { url: speaches.url },
    tts: { url: kokoro.url },
    replyAudio: { healthWaitMs: 0, timeoutMs: 5_000 },
    ...opts,
  });
  return { app, audioDir };
}

const voiceForm = (bytes = 1024, name = "note.webm", type = "audio/webm") => {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(bytes)], name, { type }));
  return form;
};
const postVoice = (form: FormData) => new Request("http://localhost/voice", { method: "POST", body: form });

async function askOnce(app: Awaited<ReturnType<typeof setup>>["app"]): Promise<{ user: ChatMessage; assistant: ChatMessage }> {
  const res = await app(new Request("http://localhost/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "check the readme" }) }));
  expect(res.status).toBe(200);
  return (await res.json()) as { user: ChatMessage; assistant: ChatMessage };
}

describe("POST /voice", () => {
  test("a voice note comes back as text, with its length and language", async () => {
    const { app } = await setup();
    const res = await app(postVoice(voiceForm(2048, "memo.m4a", "audio/mp4")));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "Create a card to check the README.", durationSeconds: 3.2, language: "en" });
    expect(speaches.requests).toHaveLength(1);
    expect(speaches.requests[0]).toMatchObject({ filename: "memo.m4a", bytes: 2048, model: "Systran/faster-whisper-small" });
  });

  test("errors keep their status and a message the app can show", async () => {
    const { app } = await setup();
    speaches.mode = "no-model";
    const noModel = await app(postVoice(voiceForm()));
    expect(noModel.status).toBe(502);
    expect(((await noModel.json()) as { error: string }).error).toMatch(/doesn't have model .*curl -X POST/);

    speaches.mode = "long";
    expect((await app(postVoice(voiceForm()))).status).toBe(413);

    const json = await app(new Request("http://localhost/voice", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    expect(json.status).toBe(400);

    const big = await app(postVoice(voiceForm(10 * 1024 * 1024 + 100 * 1024)));
    expect(big.status).toBe(413);
    expect(((await big.json()) as { error: string }).error).toBe("The voice note is over the 10 MB limit.");
  });

  test("speaches not running: 503 naming the URL and the container", async () => {
    const { app } = await setup({ stt: { url: "http://127.0.0.1:9" } });
    const res = await app(postVoice(voiceForm()));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/isn't reachable at http:\/\/127\.0\.0\.1:9 .*speaches container/);
  });

  test("GET /voice is not a route", async () => {
    const { app } = await setup();
    expect((await app(new Request("http://localhost/voice"))).status).toBe(404);
  });
});

// Bun drops a request that has no response after its idleTimeout (10 s
// by default): a real model answer, a 5 minute note or a long reply all
// take longer. Served over a real socket with a 1 s idleTimeout, each
// slow route must still answer. Bun checks idle sockets in ticks of
// about 4 s (measured on 1.3.14: with idleTimeout 1 a 3 s handler is
// answered, a 4.5 s one is dropped at 4 s), so SLOW_MS is past that and
// a control handler proves the cut really happens.
const SLOW_MS = 4600;

describe("slow routes outlive Bun's idle timeout", () => {
  async function overSocket(opts: CreateAppOptions & { delayMs?: number }, run: (base: string) => Promise<Response>) {
    const { app } = await setup(opts);
    const server = Bun.serve({ port: 0, idleTimeout: 1, fetch: app });
    try {
      return await run(`http://127.0.0.1:${server.port}`);
    } finally {
      server.stop(true);
    }
  }

  test("POST /voice, POST /ask and POST /ask/:id/audio each taking 4.6 s still answer; a plain slow handler is dropped", async () => {
    speaches.mode = "slow";
    speaches.slowMs = SLOW_MS;
    kokoro.slowMs = SLOW_MS;
    const askJson = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) };

    // The control: without lifting the timeout, Bun cuts the request.
    const control = Bun.serve({
      port: 0,
      idleTimeout: 1,
      async fetch() {
        await Bun.sleep(SLOW_MS);
        return new Response("late");
      },
    });
    const dropped = fetch(`http://127.0.0.1:${control.port}/`).then(
      () => "answered",
      () => "dropped",
    );

    const [voice, ask, audio] = await Promise.all([
      overSocket({}, (base) => fetch(`${base}/voice`, { method: "POST", body: voiceForm() })),
      overSocket({ delayMs: SLOW_MS }, (base) => fetch(`${base}/ask`, askJson)),
      overSocket({}, async (base) => {
        const asked = (await (await fetch(`${base}/ask`, askJson)).json()) as { assistant: ChatMessage };
        return fetch(`${base}/ask/${asked.assistant.id}/audio`, { method: "POST" });
      }),
    ]);
    expect(await dropped).toBe("dropped");
    control.stop(true);
    expect([voice.status, ask.status, audio.status]).toEqual([200, 200, 200]);
    expect(((await voice.json()) as { text: string }).text).toBe("Create a card to check the README.");
  }, 10_000);
});

describe("POST /ask/:messageId/audio", () => {
  test("Kokoro reads the reply (Markdown and links spoken plainly), the MP3 is cached per message, and GET serves it with Range", async () => {
    const { app, audioDir } = await setup();
    const { assistant } = await askOnce(app);

    const res = await app(new Request(`http://localhost/ask/${assistant.id}/audio`, { method: "POST" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ audioUrl: `/ask/${assistant.id}/audio`, bytes: MP3.byteLength, cached: false });
    expect(kokoro.inputs).toEqual([spokenText(REPLY)]);
    expect(kokoro.inputs[0]).toBe("Made a card to check the README. See the board.");
    expect(existsSync(join(replyAudioDir(audioDir), `${assistant.id}.mp3`))).toBe(true);

    // Second time: from the cache, Kokoro not asked again.
    const again = await app(new Request(`http://localhost/ask/${assistant.id}/audio`, { method: "POST" }));
    expect(((await again.json()) as { cached: boolean }).cached).toBe(true);
    expect(kokoro.inputs).toHaveLength(1);

    const get = await app(new Request(`http://localhost/ask/${assistant.id}/audio`));
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("audio/mpeg");
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(MP3);
    const ranged = await app(new Request(`http://localhost/ask/${assistant.id}/audio`, { headers: { range: "bytes=0-1" } }));
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe(`bytes 0-1/${MP3.byteLength}`);
    const head = await app(new Request(`http://localhost/ask/${assistant.id}/audio`, { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(MP3.byteLength));
  });

  test("two taps at once make one synthesis", async () => {
    const { app } = await setup();
    const { assistant } = await askOnce(app);
    kokoro.slowMs = 150;
    const [a, b] = await Promise.all([
      app(new Request(`http://localhost/ask/${assistant.id}/audio`, { method: "POST" })),
      app(new Request(`http://localhost/ask/${assistant.id}/audio`, { method: "POST" })),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(kokoro.inputs).toHaveLength(1);
  });

  test("Milton's own message, an unknown id and a path-like id are refused; GET before it is made is a 404", async () => {
    const { app } = await setup();
    const { user, assistant } = await askOnce(app);
    const mine = await app(new Request(`http://localhost/ask/${user.id}/audio`, { method: "POST" }));
    expect(mine.status).toBe(400);
    expect(((await mine.json()) as { error: string }).error).toBe("Only wissel's replies can be played.");
    expect((await app(new Request("http://localhost/ask/nope/audio", { method: "POST" }))).status).toBe(404);
    expect((await app(new Request("http://localhost/ask/..%2F..%2Fx/audio", { method: "POST" }))).status).toBe(404);
    expect((await app(new Request(`http://localhost/ask/${assistant.id}/audio`))).status).toBe(404);
    expect(kokoro.inputs).toHaveLength(0);
  });

  test("Kokoro down: 503 with TtsExecutor's reason, and nothing cached", async () => {
    const { app, audioDir } = await setup();
    const { assistant } = await askOnce(app);
    kokoro.down = true;
    const res = await app(new Request(`http://localhost/ask/${assistant.id}/audio`, { method: "POST" }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/Kokoro TTS health check at .* returned HTTP 500/);
    expect(existsSync(join(replyAudioDir(audioDir), `${assistant.id}.mp3`))).toBe(false);
  });

  test("a reply waits behind a podcast only so long, then says Kokoro is busy; the podcast is untouched", async () => {
    const { app } = await setup({ replyAudio: { healthWaitMs: 0, queueWaitMs: 100 } });
    const { assistant } = await askOnce(app);
    kokoro.slowMs = 500;
    // A podcast synthesis on the same Kokoro URL holds the queue.
    const podcast = new TtsExecutor({ baseUrl: kokoro.url, healthWaitMs: 0 }).speak("the podcast script", join(home, "podcast.mp3"));
    await Bun.sleep(20);
    const res = await app(new Request(`http://localhost/ask/${assistant.id}/audio`, { method: "POST" }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("Kokoro is busy with other audio (waited 0.1 s). Try again in a few minutes.");
    expect((await podcast).ok).toBe(true);
    await Bun.sleep(50);
    // The reply that gave up never reached Kokoro.
    expect(kokoro.inputs).toEqual(["the podcast script"]);
  });
});
