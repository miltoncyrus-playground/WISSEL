import { expect, test } from "bun:test";
import { lastFencedBlock } from "../src/executors/fenced-block.ts";

const F = "```";

test("returns the body of a single block", () => {
  expect(lastFencedBlock(`prose\n${F}tag\n{"a":1}\n${F}`, "tag")).toBe('{"a":1}\n');
});

test("returns null with no block, or an opening fence that never closes", () => {
  expect(lastFencedBlock("no block here", "tag")).toBeNull();
  expect(lastFencedBlock(`${F}tag\n{"a":1}`, "tag")).toBeNull();
  expect(lastFencedBlock(`${F}tag`, "tag")).toBeNull();
});

test("a fence inside the JSON does not end the block (the 2026-10-20 reviewer failure)", () => {
  const json = JSON.stringify({ verdict: "approve", feedback: `a title with ${F} still leaves one closing fence` });
  expect(lastFencedBlock(`I recommend approving.\n\n${F}tag\n${json}\n${F}`, "tag")!.trim()).toBe(json);
});

test("a fenced code sample inside a multi-line JSON string does not end the block", () => {
  const json = JSON.stringify({ body: `use this:\n${F}ts\nconst x = 1;\n${F}\ndone` }, null, 2);
  expect(JSON.parse(lastFencedBlock(`${F}tag\n${json}\n${F}\n`, "tag")!)).toEqual({ body: `use this:\n${F}ts\nconst x = 1;\n${F}\ndone` });
});

test("the last block wins over an earlier example block", () => {
  expect(lastFencedBlock(`e.g.\n${F}tag\n{"n":1}\n${F}\nreal:\n${F}tag\n{"n":2}\n${F}`, "tag")!.trim()).toBe('{"n":2}');
});

test("a longer tag on the opening line is not this block", () => {
  expect(lastFencedBlock(`${F}tag\n{"n":1}\n${F}\n${F}tags\n{"n":2}\n${F}`, "tag")).toContain('{"n":1}');
  expect(lastFencedBlock(`${F}tags\n{"n":2}\n${F}`, "tag")).toBeNull();
  expect(lastFencedBlock(`${F}tag extra\n{"n":2}\n${F}`, "tag")).toBeNull();
});

test("trailing spaces after the tag and CRLF line endings are accepted", () => {
  expect(lastFencedBlock(`${F}tag   \r\n{"n":1}\r\n${F}`, "tag")!.trim()).toBe('{"n":1}');
});

test("a fence in prose after the block runs the body past the block (callers fail closed)", () => {
  const body = lastFencedBlock(`${F}tag\n{"n":1}\n${F}\nafterwards: ${F}x${F}`, "tag")!;
  expect(() => JSON.parse(body.trim())).toThrow();
});
