import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { ChannelOutbox, channelMessageError, docScribeAdapter, flushChannel, renderMessage, SCRIBE_TOOLS, type ChannelAdapter } from "../src/services/channel.ts";
import type { CommandRunner } from "../src/executors/claude-cli.ts";

// docs/SDD-coordinator.md §4.9, phase 3 card 17, and the phase 0 S1
// result: Wissel's outbox is authoritative; a claude-docs scribe copies
// each batch out, allowed only the Claude Docs tools.

const SHA = "a".repeat(40);

describe("the message protocol", () => {
  test("each kind's rules: ready-to-merge needs the full head, a question needs options and a lean", () => {
    expect(channelMessageError({ kind: "claim", text: "Taking A4", key: "A4" })).toBeUndefined();
    expect(channelMessageError({ kind: "ready-to-merge", text: "A4 is green", headSha: SHA })).toBeUndefined();
    expect(channelMessageError({ kind: "ready-to-merge", text: "A4 is green", headSha: "abc1234" })).toContain("full 40-character");
    expect(channelMessageError({ kind: "question", text: "UTC or local?", options: ["UTC", "local"], lean: "UTC: logs compare" })).toBeUndefined();
    expect(channelMessageError({ kind: "question", text: "UTC or local?", options: ["UTC"] })).toContain("two options and a lean");
    expect(channelMessageError({ kind: "gossip", text: "x" })).toContain("message.kind");
    expect(channelMessageError({ kind: "status", text: "" })).toContain("1 to 2000");
  });

  test("a line names its kind and links what it is about", () => {
    expect(renderMessage({ kind: "ready-to-merge", text: "A4 is green", key: "A4", pr: { number: 9, url: "https://github.com/o/r/pull/9" }, headSha: SHA }, "2026-11-28 08:00")).toBe(`[2026-11-28 08:00] READY-TO-MERGE: A4 is green (A4 · PR #9 https://github.com/o/r/pull/9 · head ${SHA})`);
    expect(renderMessage({ kind: "question", text: "UTC or local?", options: ["UTC", "local"], lean: "UTC" }, "t")).toBe("[t] QUESTION: UTC or local? Options: (1) UTC (2) local. Lean: UTC");
  });
});

describe("the claude-docs scribe", () => {
  function scribe(answer: (prompt: string) => string, exitCode = 0) {
    const calls: string[][] = [];
    const runner: CommandRunner = async (cmd) => (calls.push(cmd), { stdout: JSON.stringify({ result: answer(cmd[2] ?? "") }), stderr: "", exitCode });
    return { adapter: docScribeAdapter(runner, { cwd: "/tmp", env: { CLAUDE_CONFIG_DIR: "/h" }, now: () => new Date("2026-11-28T08:00:00Z") }), calls };
  }

  test("one claude -p run per batch, allowed only the Claude Docs tools; each line confirmed by the receipt", async () => {
    const box = new ChannelOutbox(new SqliteBoard().db);
    const a = box.add("ws1", { kind: "claim", text: "Taking A4" });
    const b = box.add("ws1", { kind: "status", text: "A4 in review" });
    const { adapter, calls } = scribe((p) => {
      expect(p).toContain("Append the lines below");
      expect(p).toContain(`${a.id}\t[2026-11-28 08:00] CLAIM: Taking A4`);
      return "Done.\n```channel-receipt\n" + JSON.stringify({ entries: [{ id: a.id, entryId: "blk-1" }] }) + "\n```";
    });
    const out = await adapter.post("https://claude.ai/artifact/doc", [a, b]);
    expect(out).toEqual([
      { id: a.id, entryId: "blk-1" },
      { id: b.id, error: "the scribe did not confirm this line" },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 2)).toEqual(["claude", "-p"]);
    expect(calls[0]!.slice(3)).toEqual(["--allowedTools", SCRIBE_TOOLS.join(","), "--output-format", "json"]);
    expect(SCRIBE_TOOLS.every((t) => t === "ToolSearch" || t.startsWith("mcp__claude_ai_Claude_Docs__"))).toBe(true);
  });

  test("a missing receipt or a failed run throws, so the batch stays pending", async () => {
    const box = new ChannelOutbox(new SqliteBoard().db);
    const row = box.add("ws1", { kind: "claim", text: "x" });
    await expect(scribe(() => "I wrote it, trust me").adapter.post("doc", [row])).rejects.toThrow("no ```channel-receipt block");
    await expect(scribe(() => "", 1).adapter.post("doc", [row])).rejects.toThrow("scribe run failed");
  });

  test("reading returns other people's entries and a cursor", async () => {
    const { adapter } = scribe(() => "```channel-entries\n" + JSON.stringify({ entries: [{ entryId: "blk-7", author: "Dana", text: "Go with UTC." }, { text: "no id" }], cursor: "blk-7" }) + "\n```");
    expect(await adapter.read("doc", "blk-3")).toEqual({ entries: [{ entryId: "blk-7", author: "Dana", text: "Go with UTC." }], cursor: "blk-7" });
  });
});

describe("flushing", () => {
  test("one post per workstream with pending lines; an empty outbox calls nothing; a throw keeps the batch", async () => {
    const box = new ChannelOutbox(new SqliteBoard().db);
    let calls = 0;
    let fail = true;
    const adapter: ChannelAdapter = {
      post: async (_t, rows) => {
        calls++;
        if (fail) throw new Error("offline");
        return rows.map((r) => ({ id: r.id, entryId: `e-${r.message.text}` }));
      },
      read: async () => ({ entries: [] }),
    };
    expect(await flushChannel(box, () => ({ adapter, target: "doc" }))).toBe(0);
    expect(calls).toBe(0);
    box.add("ws1", { kind: "claim", text: "one" });
    box.add("ws1", { kind: "status", text: "two" });
    expect(await flushChannel(box, () => ({ adapter, target: "doc" }))).toBe(0);
    expect(box.list("ws1", true)).toHaveLength(2);
    fail = false;
    expect(await flushChannel(box, () => ({ adapter, target: "doc" }))).toBe(2);
    expect(box.list("ws1").map((r) => [r.status, r.entryId])).toEqual([
      ["posted", "e-two"],
      ["posted", "e-one"],
    ]);
    expect(calls).toBe(2);
  });
});

describe("through the gate and executor", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wissel-channel-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("an allowed channel.post joins the outbox, and flush posts it through the workstream's adapter", async () => {
    const posted: string[] = [];
    const channelAdapter: ChannelAdapter = { post: async (_t, rows) => rows.map((r) => (posted.push(r.message.text), { id: r.id, entryId: "blk" })), read: async () => ({ entries: [] }) };
    const app = createApp(new SqliteBoard(), Registry.from([]), undefined, { harnesses: HarnessPool.from([]), channelAdapter });
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await app(new Request(`http://x${path}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }));
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    const repo = join(dir, "shop");
    mkdirSync(repo);
    Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
    const projectId = (await call("POST", "/projects/local", { path: repo })).body.id as string;
    const doc = "https://claude.ai/artifact/decisions";
    const ws = (await call("POST", "/workstreams", { name: "Checkout", projects: [{ projectId, role: "decide" }], channel: { adapter: "claude-docs", target: doc } })).body.id as string;
    const act = (target: string, message: object) => call("POST", `/workstreams/${ws}/actions`, { action: { kind: "channel.post", projectId, target: { channel: target }, payload: { message } } });
    expect((await act(doc, { kind: "claim", text: "Taking A4" })).body).toMatchObject({ status: "done", detail: expect.stringContaining("queued for the claude-docs channel") });
    expect((await act("slack:#random", { kind: "claim", text: "x" })).status).toBe(403);
    expect((await act(doc, { kind: "ready-to-merge", text: "green", headSha: "short" })).body).toMatchObject({ status: "failed", error: expect.stringContaining("full 40-character") });
    const flushed = await call("POST", `/workstreams/${ws}/channel/flush`);
    expect(flushed.body.posted).toBe(1);
    expect(posted).toEqual(["Taking A4"]);
    expect(((await call("GET", `/workstreams/${ws}/channel`)).body as unknown as Array<{ status: string }>).map((r) => r.status)).toEqual(["posted"]);
  });
});
