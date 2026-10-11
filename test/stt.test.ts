import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_STT_MODEL,
  DEFAULT_STT_TIMEOUT_MS,
  DEFAULT_STT_URL,
  MAX_VOICE_BYTES,
  MAX_VOICE_SECONDS,
  SttClient,
  SttError,
  clock,
  isAudioType,
  noteFileName,
  readCapped,
  transcribeVoiceRequest,
} from "../src/services/stt.ts";
import { startFakeSpeaches } from "./fixtures/fake-speaches.ts";

// docs/SDD-wissel-app.md §3.5: the speech-to-text client, against a fake
// speaches (Bun.serve on port 0). Never the real model.

const fake = startFakeSpeaches();
afterAll(() => fake.stop());
beforeEach(() => {
  fake.mode = "ok";
  fake.requests = [];
  fake.healthChecks = 0;
});

const note = (bytes = 2048, type = "audio/webm;codecs=opus") => new Blob([new Uint8Array(bytes).fill(7)], { type });

async function sttError(p: Promise<unknown>): Promise<SttError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(SttError);
    return e as SttError;
  }
  throw new Error("expected an SttError");
}

describe("SttClient", () => {
  test("defaults: speaches on 127.0.0.1:8000, faster-whisper small, 10 minute timeout, 10 MB and 5 min caps", () => {
    const c = new SttClient();
    expect(c.baseUrl).toBe(DEFAULT_STT_URL);
    expect(DEFAULT_STT_URL).toBe("http://127.0.0.1:8000");
    expect(c.model).toBe(DEFAULT_STT_MODEL);
    expect(DEFAULT_STT_MODEL).toBe("Systran/faster-whisper-small");
    expect(DEFAULT_STT_TIMEOUT_MS).toBe(600_000);
    expect(MAX_VOICE_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_VOICE_SECONDS).toBe(300);
    expect(new SttClient({ baseUrl: "http://x:1///" }).baseUrl).toBe("http://x:1");
  });

  test("success: checks health, posts the note as multipart with model and verbose_json, and returns the trimmed text", async () => {
    const c = new SttClient({ baseUrl: fake.url, language: "en" });
    const t = await c.transcribe(note(4096), "note.webm");
    expect(t.text).toBe("Create a card to check the README.");
    expect(t.durationSeconds).toBe(3.2);
    expect(t.language).toBe("en");
    expect(t.model).toBe("Systran/faster-whisper-small");
    expect(t.transcribeSeconds).toBeGreaterThanOrEqual(0);
    expect(fake.healthChecks).toBe(1);
    expect(fake.requests).toEqual([
      // Bun types a multipart part by its file name on the way through.
      { model: "Systran/faster-whisper-small", responseFormat: "verbose_json", language: "en", filename: "note.webm", type: "video/webm", bytes: 4096 },
    ]);
  });

  test("a note with no file name goes as voice-note.<ext from its type>", async () => {
    await new SttClient({ baseUrl: fake.url }).transcribe(note(64, "audio/ogg;codecs=opus"));
    expect(fake.requests[0]!.filename).toBe("voice-note.ogg");
  });

  test("no language set: none is sent, so Whisper detects it", async () => {
    await new SttClient({ baseUrl: fake.url }).transcribe(note());
    expect(fake.requests[0]!.language).toBeNull();
  });

  const failures: { name: string; mode?: typeof fake.mode; url?: string; status: number; message: RegExp }[] = [
    { name: "service down", url: "http://127.0.0.1:9", status: 503, message: /Speech to text isn't reachable at http:\/\/127\.0\.0\.1:9 .*Is the speaches container running\?/ },
    { name: "health 500", mode: "health500", status: 503, message: /health check at .*\/health returned HTTP 500: boom/ },
    { name: "HTTP 500", mode: "http500", status: 502, message: /returned HTTP 500: Internal Server Error/ },
    { name: "not JSON", mode: "not-json", status: 502, message: /isn't JSON: <html>proxy error<\/html>/ },
    { name: "no text field", mode: "no-text", status: 502, message: /without a text field/ },
    { name: "model not downloaded", mode: "no-model", status: 502, message: /doesn't have model Systran\/faster-whisper-small.*curl -X POST http:\/\/127\.0\.0\.1:\d+\/v1\/models\/Systran\/faster-whisper-small/ },
    { name: "longer than 5 minutes", mode: "long", status: 413, message: /The voice note is 6:40 long; the limit is 5:00\./ },
    { name: "no speech", mode: "silent", status: 422, message: /No speech was heard/ },
  ];
  for (const f of failures) {
    test(`fails with a clear error: ${f.name}`, async () => {
      if (f.mode) fake.mode = f.mode;
      const e = await sttError(new SttClient({ baseUrl: f.url ?? fake.url, healthTimeoutMs: 2000 }).transcribe(note()));
      expect(e.status).toBe(f.status as SttError["status"]);
      expect(e.message).toMatch(f.message);
    });
  }

  test("an unreachable service is found by the health check: the note is never sent", async () => {
    fake.mode = "health500";
    await sttError(new SttClient({ baseUrl: fake.url }).transcribe(note()));
    expect(fake.requests).toHaveLength(0);
  });

  test("a slow answer times out with a 504 naming the limit", async () => {
    fake.mode = "slow";
    fake.slowMs = 600;
    const e = await sttError(new SttClient({ baseUrl: fake.url, timeoutMs: 150 }).transcribe(note()));
    expect(e.status).toBe(504);
    expect(e.message).toBe(`Speech to text at ${fake.url} timed out after 0.2 s.`);
  });

  test("refused before any request: empty, over 10 MB, not audio", async () => {
    const c = new SttClient({ baseUrl: fake.url });
    expect((await sttError(c.transcribe(note(0)))).status).toBe(400);
    const big = await sttError(c.transcribe(note(MAX_VOICE_BYTES + 1)));
    expect(big.status).toBe(413);
    expect(big.message).toBe("The voice note is 10.0 MB; the limit is 10 MB.");
    const text = await sttError(c.transcribe(note(10, "text/plain")));
    expect(text.status).toBe(415);
    expect(text.message).toBe("That file is text/plain, not audio.");
    expect(fake.healthChecks).toBe(0);
  });

  test("a note of exactly 5 minutes (and a recorder's few seconds over) is fine", async () => {
    fake.durationSeconds = 304;
    const t = await new SttClient({ baseUrl: fake.url }).transcribe(note());
    expect(t.durationSeconds).toBe(304);
    fake.durationSeconds = 3.2;
  });
});

describe("isAudioType", () => {
  test("audio of any kind, the video containers phones label voice memos with, and no type at all", () => {
    for (const t of ["audio/webm;codecs=opus", "audio/ogg", "audio/mp4", "audio/x-m4a", "audio/3gpp", "audio/mpeg", "video/webm", "video/mp4", "video/3gpp", "", "application/octet-stream"]) {
      expect(isAudioType(t)).toBe(true);
    }
    for (const t of ["text/plain", "image/png", "application/json", "application/pdf", "video/quicktime"]) expect(isAudioType(t)).toBe(false);
  });
});

describe("noteFileName", () => {
  test("keeps a name with an extension, adds one from the type, and never passes a path through", () => {
    expect(noteFileName("memo.m4a", "audio/mp4")).toBe("memo.m4a");
    expect(noteFileName("voice-note", "audio/webm;codecs=opus")).toBe("voice-note.webm");
    expect(noteFileName("", "audio/mp4")).toBe("voice-note.m4a");
    expect(noteFileName("blob", "")).toBe("blob");
    expect(noteFileName("../../etc/passwd", "audio/ogg")).toBe("passwd.ogg");
    expect(noteFileName("C:\\Users\\me\\Recording 12.3gp", "")).toBe("Recording_12.3gp");
  });
});

describe("clock", () => {
  test("m:ss", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(65)).toBe("1:05");
    expect(clock(300)).toBe("5:00");
    expect(clock(-3)).toBe("0:00");
  });
});

describe("readCapped", () => {
  test("reads a body up to the limit, and stops (null) the moment it is passed, even with no Content-Length", async () => {
    const ok = await readCapped(new Request("http://x/", { method: "POST", body: new Uint8Array(100) }), 100);
    expect(ok?.byteLength).toBe(100);
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(64));
      },
    });
    const req = new Request("http://x/", { method: "POST", body: endless, duplex: "half" } as RequestInit);
    expect(await readCapped(req, 1000)).toBeNull();
    expect(pulled).toBeLessThan(20);
  });

  test("a declared Content-Length over the limit is refused without reading", async () => {
    const req = new Request("http://x/", { method: "POST", body: "x", headers: { "content-length": "5000" } });
    expect(await readCapped(req, 100)).toBeNull();
  });
});

describe("transcribeVoiceRequest", () => {
  const stt = () => new SttClient({ baseUrl: fake.url });
  const upload = (form: FormData) => new Request("http://x/voice", { method: "POST", body: form });

  test("takes the note from the `file` field, keeping its name and type", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array(512)], "memo.m4a", { type: "audio/mp4" }));
    const t = await transcribeVoiceRequest(upload(form), stt());
    expect(t.text).toBe("Create a card to check the README.");
    expect(fake.requests[0]).toMatchObject({ filename: "memo.m4a", bytes: 512 });
  });

  test("400 for a JSON body, a missing file field, or a text field", async () => {
    const json = new Request("http://x/voice", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect((await sttError(transcribeVoiceRequest(json, stt()))).status).toBe(400);
    const empty = new FormData();
    empty.append("other", new File([new Uint8Array(4)], "a.webm", { type: "audio/webm" }));
    expect((await sttError(transcribeVoiceRequest(upload(empty), stt()))).message).toMatch(/field named file/);
    const asText = new FormData();
    asText.append("file", "not a file");
    expect((await sttError(transcribeVoiceRequest(upload(asText), stt()))).status).toBe(400);
  });

  test("413 for an upload over 10 MB, before speaches is asked", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array(MAX_VOICE_BYTES + 200 * 1024)], "big.webm", { type: "audio/webm" }));
    const e = await sttError(transcribeVoiceRequest(upload(form), stt()));
    expect(e.status).toBe(413);
    expect(fake.healthChecks).toBe(0);
  });
});
