import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendTaskOutput, getBufferedOutput, getTaskOutput, RING_BUFFER_CAP_BYTES, TASK_OUTPUT_EVENTS } from "../src/services/task-output.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wissel-task-output-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("append then read-back round-trip — every appended line comes back, in order, from the durable file", async () => {
  const taskId = "t-roundtrip";
  await appendTaskOutput(taskId, { type: "system", subtype: "init" }, dir);
  await appendTaskOutput(taskId, { type: "stream_event", event: { type: "message_start" } }, dir);
  await appendTaskOutput(taskId, { type: "result", subtype: "success", is_error: false, result: "done" }, dir);

  const lines = await getTaskOutput(taskId, dir);
  expect(lines).toEqual([
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "stream_event", event: { type: "message_start" } }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }),
  ]);
  // Every line is valid, independently parseable JSON — the actual
  // JSONL contract the SSE/snapshot endpoints and the UI render
  // function depend on.
  lines.forEach((l) => expect(() => JSON.parse(l)).not.toThrow());
});

test("getTaskOutput returns an empty array, never an error, for a taskId with nothing recorded yet", async () => {
  expect(await getTaskOutput("never-ran", dir)).toEqual([]);
});

test("ring buffer eviction at the byte cap — oldest lines are dropped first, most recent always survive", async () => {
  const taskId = "t-ring";
  // Each line padded well past what a handful of them need to blow the
  // 256KB cap. Ring buffer eviction happens synchronously inside
  // appendTaskOutput itself (before the durable write is even queued),
  // so awaiting each call only ensures the durable write finishes
  // before the test's own tmpdir cleanup runs — it doesn't change what
  // this test is actually asserting on.
  const bigLine = "x".repeat(50_000);
  for (let i = 0; i < 10; i++) {
    await appendTaskOutput(taskId, { i, pad: bigLine }, dir);
  }
  const buffered = getBufferedOutput(taskId);
  const totalBytes = buffered.reduce((sum, l) => sum + Buffer.byteLength(l, "utf8") + 1, 0);
  expect(totalBytes).toBeLessThanOrEqual(RING_BUFFER_CAP_BYTES);
  // The oldest entries (low `i`) were evicted; the most recent one
  // (i === 9) must always survive.
  expect(buffered.length).toBeLessThan(10);
  const lastParsed = JSON.parse(buffered[buffered.length - 1]!);
  expect(lastParsed.i).toBe(9);
  const firstParsed = JSON.parse(buffered[0]!);
  expect(firstParsed.i).toBeGreaterThan(0);
});

test("a single line larger than the cap is still kept, never truncated to nothing", async () => {
  const taskId = "t-ring-oversized";
  const hugeLine = "x".repeat(RING_BUFFER_CAP_BYTES + 1000);
  await appendTaskOutput(taskId, { pad: hugeLine }, dir);
  const buffered = getBufferedOutput(taskId);
  expect(buffered.length).toBe(1);
});

test("getBufferedOutput returns an empty array for a taskId with nothing buffered", () => {
  expect(getBufferedOutput("nothing-buffered-yet")).toEqual([]);
});

test("concurrent appends from two different taskIds never cross-contaminate — each file and each ring buffer stays scoped to its own taskId", async () => {
  const a = "t-a";
  const b = "t-b";
  await Promise.all([
    appendTaskOutput(a, { from: "a", n: 1 }, dir),
    appendTaskOutput(b, { from: "b", n: 1 }, dir),
    appendTaskOutput(a, { from: "a", n: 2 }, dir),
    appendTaskOutput(b, { from: "b", n: 2 }, dir),
    appendTaskOutput(a, { from: "a", n: 3 }, dir),
  ]);

  const aLines = (await getTaskOutput(a, dir)).map((l) => JSON.parse(l));
  const bLines = (await getTaskOutput(b, dir)).map((l) => JSON.parse(l));

  expect(aLines).toEqual([
    { from: "a", n: 1 },
    { from: "a", n: 2 },
    { from: "a", n: 3 },
  ]);
  expect(bLines).toEqual([
    { from: "b", n: 1 },
    { from: "b", n: 2 },
  ]);
  aLines.forEach((l) => expect(l.from).toBe("a"));
  bLines.forEach((l) => expect(l.from).toBe("b"));

  expect(getBufferedOutput(a).map((l) => JSON.parse(l).from)).toEqual(["a", "a", "a"]);
  expect(getBufferedOutput(b).map((l) => JSON.parse(l).from)).toEqual(["b", "b"]);
});

test("writes for the same taskId are serialized in append order, even when fired synchronously back-to-back without awaiting each one", async () => {
  const taskId = "t-order";
  const writes: Promise<void>[] = [];
  for (let i = 0; i < 20; i++) {
    writes.push(appendTaskOutput(taskId, { i }, dir));
  }
  await Promise.all(writes);
  const lines = (await getTaskOutput(taskId, dir)).map((l) => JSON.parse(l).i);
  expect(lines).toEqual(Array.from({ length: 20 }, (_, i) => i));
});

test("file persists and is readable after the emitter has no more listeners — durability isn't tied to a live viewer", async () => {
  const taskId = "t-durable";
  const listener = () => {};
  TASK_OUTPUT_EVENTS.on(`chunk:${taskId}`, listener);
  await appendTaskOutput(taskId, { type: "result", result: "ok" }, dir);
  TASK_OUTPUT_EVENTS.off(`chunk:${taskId}`, listener);
  expect(TASK_OUTPUT_EVENTS.listenerCount(`chunk:${taskId}`)).toBe(0);

  // Written after the listener is gone — proves the file write isn't
  // conditioned on anyone actively watching.
  await appendTaskOutput(taskId, { type: "result", result: "still recorded" }, dir);

  const lines = (await getTaskOutput(taskId, dir)).map((l) => JSON.parse(l));
  expect(lines).toEqual([
    { type: "result", result: "ok" },
    { type: "result", result: "still recorded" },
  ]);
});

test("appendTaskOutput emits chunk:<taskId> with the raw JSONL line text for a live listener", async () => {
  const taskId = "t-emit";
  const received: string[] = [];
  const listener = (line: string) => received.push(line);
  TASK_OUTPUT_EVENTS.on(`chunk:${taskId}`, listener);
  try {
    await appendTaskOutput(taskId, { type: "result", result: "hi" }, dir);
  } finally {
    TASK_OUTPUT_EVENTS.off(`chunk:${taskId}`, listener);
  }
  expect(received).toEqual([JSON.stringify({ type: "result", result: "hi" })]);
});

test("a durable write failure is caught, not thrown — never crashes the caller", async () => {
  // Directing the store at a path that collides with a real file (not a
  // directory) makes mkdir/appendFile fail — appendTaskOutput must
  // resolve, not reject.
  const notADir = join(dir, "im-a-file");
  await Bun.write(notADir, "occupied");
  await expect(appendTaskOutput("t-fail", { x: 1 }, notADir)).resolves.toBeUndefined();
});
