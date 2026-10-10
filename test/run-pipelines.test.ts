import { expect, test } from "bun:test";
import { runPipelineByName, runPipelines, waitForServer } from "../scripts/run-pipelines.ts";

// The 06:00 timer's runner (ops/systemd/wissel-morning-podcasts.*).

type Call = { url: string; method: string; init?: BunFetchRequestInit };

function fakeServer(pipelines: { id: string; name: string }[], runStatus: Record<string, number | string> = {}) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init?: BunFetchRequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", init });
    if (url.endsWith("/pipelines")) return Response.json(pipelines);
    const m = url.match(/\/pipelines\/([^/]+)\/run$/);
    if (m) {
      const s = runStatus[m[1]!] ?? "done";
      if (typeof s === "number") return Response.json({ error: "boom" }, { status: s });
      return Response.json({ id: `run-${m[1]}`, status: s });
    }
    return new Response("nope", { status: 404 });
  };
  return { calls, fetchImpl };
}

const P = [
  { id: "a1", name: "AI news podcast" },
  { id: "w1", name: "World news podcast" },
];

test("runs each named pipeline by its id with POST and reports the run", async () => {
  const { calls, fetchImpl } = fakeServer(P);
  const out = await runPipelines("http://x", ["AI news podcast", "World news podcast"], fetchImpl);
  expect(out.map((o) => [o.name, o.ok, o.runId, o.status])).toEqual([
    ["AI news podcast", true, "run-a1", "done"],
    ["World news podcast", true, "run-w1", "done"],
  ]);
  expect(calls.filter((c) => c.method === "POST").map((c) => c.url).sort()).toEqual(["http://x/pipelines/a1/run", "http://x/pipelines/w1/run"]);
});

test("a missing name, a duplicate name, a failed run and an HTTP error each report not ok, without stopping the others", async () => {
  const { fetchImpl } = fakeServer([...P, { id: "d1", name: "Dup" }, { id: "d2", name: "Dup" }], { a1: "failed", w1: 500 });
  const out = await runPipelines("http://x", ["AI news podcast", "World news podcast", "Nope", "Dup"], fetchImpl);
  expect(out.map((o) => o.ok)).toEqual([false, false, false, false]);
  expect(out[0]!.status).toBe("failed");
  expect(out[1]!.error).toBe("boom");
  expect(out[2]!.error).toBe('no stored pipeline named "Nope"');
  expect(out[3]!.error).toContain("2 stored pipelines are named");
});

test("a network error is reported, not thrown", async () => {
  const out = await runPipelineByName("http://x", "AI news podcast", async () => {
    throw new Error("ECONNREFUSED");
  });
  expect(out).toMatchObject({ ok: false, error: "ECONNREFUSED" });
});

test("waitForServer: true once /version answers, false after the deadline", async () => {
  let n = 0;
  const upOnThird = async () => (++n >= 3 ? new Response("{}") : Promise.reject(new Error("down")));
  expect(await waitForServer("http://x", 60, upOnThird, async () => {})).toBe(true);
  expect(n).toBe(3);
  expect(await waitForServer("http://x", 0, async () => new Response("", { status: 503 }), async () => {})).toBe(false);
});

test("the run request disables Bun's 5 minute idle timeout and carries its own 90 minute deadline", async () => {
  const { calls, fetchImpl } = fakeServer(P);
  await runPipelineByName("http://x", "AI news podcast", fetchImpl);
  const post = calls.find((c) => c.method === "POST")!;
  expect(post.init!.timeout).toBe(false);
  expect(post.init!.signal).toBeInstanceOf(AbortSignal);
  expect(post.init!.signal!.aborted).toBe(false);
});
