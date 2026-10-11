import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchConversation, postAsk, postReplyAudio, postVoice, runNotice, runPipeline } from "../src/api";

// POST /pipelines/:id/run answers 201 with the settled root card, which
// can be "failed" (src/api/server.ts). The palette's notice must say so
// instead of "finished".

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("runPipeline", () => {
  test("posts to the run endpoint and returns the settled root card", async () => {
    const fetchMock = stubFetch(201, { id: "t1", title: "AI news", status: "failed" });
    const root = await runPipeline("ai news");
    expect(root.status).toBe("failed");
    expect(fetchMock).toHaveBeenCalledWith("/pipelines/ai%20news/run", expect.objectContaining({ method: "POST", body: "{}" }));
  });

  test("throws the server's error message on a non-2xx answer", async () => {
    stubFetch(400, { error: "repo and input are required" });
    await expect(runPipeline("p1")).rejects.toThrow("repo and input are required");
  });
});

describe("Ask's endpoints (SDD §3.4)", () => {
  test("postAsk sends only the text for a new chat, and the conversationId after", async () => {
    const fetchMock = stubFetch(200, { conversation: { id: "c1" } });
    await postAsk("hello");
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({ text: "hello" });
    await postAsk("and now?", "c1");
    expect(fetchMock.mock.calls[1]![0]).toBe("/ask");
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)).toEqual({ conversationId: "c1", text: "and now?" });
  });

  test("postAsk throws the server's error", async () => {
    stubFetch(400, { error: "text is required" });
    await expect(postAsk(" ")).rejects.toThrow("text is required");
  });

  test("fetchConversation: null for a 404, the detail otherwise, an error for anything else", async () => {
    stubFetch(404, { error: "not found" });
    expect(await fetchConversation("gone")).toBeNull();
    const fetchMock = stubFetch(200, { conversation: { id: "c/1" }, messages: [] });
    expect(await fetchConversation("c/1")).toEqual({ conversation: { id: "c/1" }, messages: [] });
    expect(fetchMock.mock.calls[0]![0]).toBe("/conversations/c%2F1");
    stubFetch(500, {});
    await expect(fetchConversation("c1")).rejects.toThrow("HTTP 500");
  });
});

describe("Voice endpoints (SDD §3.5)", () => {
  test("postVoice sends the note as multipart in `file`, under its name", async () => {
    const fetchMock = stubFetch(200, { text: "Run the AI news podcast" });
    const res = await postVoice(new Blob(["abc"], { type: "audio/webm" }), "voice-note.webm");
    expect(res.text).toBe("Run the AI news podcast");
    expect(fetchMock.mock.calls[0]![0]).toBe("/voice");
    const body = fetchMock.mock.calls[0]![1]!.body as FormData;
    const file = body.get("file") as File;
    expect(file.name).toBe("voice-note.webm");
    expect(await file.text()).toBe("abc");
  });

  test("postVoice and postReplyAudio throw the server's error", async () => {
    stubFetch(503, { error: "Speech to text isn't reachable" });
    await expect(postVoice(new Blob(["a"]), "n.webm")).rejects.toThrow("Speech to text isn't reachable");
    stubFetch(503, { error: "Kokoro is busy" });
    await expect(postReplyAudio("m1")).rejects.toThrow("Kokoro is busy");
  });

  test("postReplyAudio posts to the message's audio route", async () => {
    const fetchMock = stubFetch(200, { audioUrl: "/ask/m%2F1/audio" });
    expect(await postReplyAudio("m/1")).toEqual({ audioUrl: "/ask/m%2F1/audio" });
    expect(fetchMock).toHaveBeenCalledWith("/ask/m%2F1/audio", expect.objectContaining({ method: "POST" }));
  });
});

describe("runNotice", () => {
  test("done reads as finished", () => {
    expect(runNotice("AI news", { status: "done" })).toBe("AI news finished.");
  });

  test("failed reads as a failure, not finished", () => {
    const text = runNotice("AI news", { status: "failed" });
    expect(text).toMatch(/^AI news failed\./);
    expect(text).not.toMatch(/finished/);
  });

  test("any other settled status is named", () => {
    expect(runNotice("AI news", { status: "escalated" })).toBe("AI news stopped at escalated.");
  });

  test("no em dashes in the copy", () => {
    for (const status of ["done", "failed", "review"] as const) {
      expect(runNotice("x", { status })).not.toContain("—");
    }
  });
});
