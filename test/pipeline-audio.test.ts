import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { Registry } from "../src/core/registry.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { parseRange } from "../src/services/pipeline-audio.ts";
import { SILENT_MP3_PATH } from "./fixtures/ai-news/make-silent-mp3.ts";

// docs/SDD-ai-news-podcast.md §3.7, serving: GET /pipeline-runs/:id/audio
// streams a run's MP3 with Range support, and GET /pipeline-runs/:id says
// whether there is one.

const MP3 = new Uint8Array(readFileSync(SILENT_MP3_PATH));

let audioDir: string;
let board: SqliteBoard;
let app: (req: Request) => Promise<Response>;
let withAudio: string;
let withoutAudio: string;
let stepId: string;

beforeAll(async () => {
  audioDir = await mkdtemp(join(tmpdir(), "wissel-audio-api-"));
  board = new SqliteBoard();
  app = createApp(board, await Registry.load(), undefined, { audioDir, manualExecutors: [] });
  withAudio = (await board.create({ title: "Pipeline: AI news podcast", body: "", labels: [], pipelineId: "p-news" })).id;
  withoutAudio = (await board.create({ title: "Pipeline: AI news podcast", body: "", labels: [], pipelineId: "p-news" })).id;
  stepId = (await board.create({ title: "AI news podcast: Make audio", body: "", labels: [], pipelineId: "p-news", pipelineRunId: withAudio, parentTaskId: withAudio, pipelineStepId: "audio" })).id;
  writeFileSync(join(audioDir, `${withAudio}.mp3`), MP3);
  // A step card's id with a file next to it must still not be served: it isn't a run.
  writeFileSync(join(audioDir, `${stepId}.mp3`), MP3);
  // Something outside any run that a traversal would be after.
  writeFileSync(join(audioDir, "secret.mp3"), "not yours");
});

afterAll(async () => {
  await rm(audioDir, { recursive: true, force: true });
});

function get(path: string, headers: Record<string, string> = {}, method = "GET"): Promise<Response> {
  return app(new Request(`http://localhost${path}`, { method, headers }));
}

describe("GET /pipeline-runs/:id/audio", () => {
  test("200 with the whole MP3 as audio/mpeg, advertising byte ranges", async () => {
    const res = await get(`/pipeline-runs/${withAudio}/audio`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe(String(MP3.byteLength));
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(MP3);
  });

  test("a Range request is a 206 with exactly those bytes and a Content-Range", async () => {
    const res = await get(`/pipeline-runs/${withAudio}/audio`, { range: "bytes=100-299" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("content-range")).toBe(`bytes 100-299/${MP3.byteLength}`);
    expect(res.headers.get("content-length")).toBe("200");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(MP3.slice(100, 300));

    // Open-ended (a phone seeking) and suffix ranges.
    const tail = await get(`/pipeline-runs/${withAudio}/audio`, { range: "bytes=6000-" });
    expect(tail.status).toBe(206);
    expect(tail.headers.get("content-range")).toBe(`bytes 6000-${MP3.byteLength - 1}/${MP3.byteLength}`);
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(MP3.slice(6000));
    const suffix = await get(`/pipeline-runs/${withAudio}/audio`, { range: "bytes=-4" });
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(MP3.slice(-4));
  });

  test("a range past the end is a 416 naming the size", async () => {
    const res = await get(`/pipeline-runs/${withAudio}/audio`, { range: `bytes=${MP3.byteLength}-` });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe(`bytes */${MP3.byteLength}`);
  });

  test("HEAD answers with the headers and no body", async () => {
    const res = await get(`/pipeline-runs/${withAudio}/audio`, {}, "HEAD");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  test("404 for an unknown run, a run without audio, and a step card's id", async () => {
    expect((await get(`/pipeline-runs/00000000-0000-0000-0000-000000000000/audio`)).status).toBe(404);
    expect((await get(`/pipeline-runs/${withoutAudio}/audio`)).status).toBe(404);
    expect((await get(`/pipeline-runs/${stepId}/audio`)).status).toBe(404);
  });

  test("traversal-looking ids are rejected before any file is touched", async () => {
    for (const id of ["secret", "..%2Fsecret", "%2e%2e%2fsecret", "secret.mp3", "..", "a%00b"]) {
      const res = await get(`/pipeline-runs/${id}/audio`);
      expect(res.status, id).toBe(404);
      expect(await res.text(), id).not.toContain("not yours");
    }
    // A real "../" never reaches the route as a path segment (URL
    // normalizes it), so this lands on some other route, not the file.
    const dotted = await get(`/pipeline-runs/../${withAudio}/audio`);
    expect(await dotted.text()).not.toContain("not yours");
  });
});

describe("GET /pipeline-runs/:id reports the audio", () => {
  test("audio is { url, bytes } when the MP3 exists, null when it doesn't", async () => {
    const yes = (await (await get(`/pipeline-runs/${withAudio}`)).json()) as { audio: unknown };
    expect(yes.audio).toEqual({ url: `/pipeline-runs/${withAudio}/audio`, bytes: MP3.byteLength });
    const no = (await (await get(`/pipeline-runs/${withoutAudio}`)).json()) as { audio: unknown };
    expect(no.audio).toBeNull();
  });
});

describe("parseRange", () => {
  test("single ranges, clamped; malformed or multiple ranges send the whole file", () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange("bytes=0-1", 100)).toEqual({ start: 0, end: 1 });
    expect(parseRange("bytes=10-", 100)).toEqual({ start: 10, end: 99 });
    expect(parseRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-500", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=5-2", 100)).toBeNull();
    expect(parseRange("bytes=0-1,5-6", 100)).toBeNull();
    expect(parseRange("items=0-1", 100)).toBeNull();
    expect(parseRange("bytes=-", 100)).toBeNull();
  });
});
