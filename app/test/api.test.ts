import { afterEach, describe, expect, test, vi } from "vitest";
import { runNotice, runPipeline } from "../src/api";

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
