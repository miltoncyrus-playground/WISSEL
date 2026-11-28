import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { Registry } from "../src/core/registry.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { COMMENT_READER_TOOLS, commentsReadPrompt, docCommentReader, ownerCommentsContext, ownerCommentsDue, parseOwnerComments, readOwnerComments, type CommentReader, type OwnerComment } from "../src/services/owner-comments.ts";
import { workstreamCheck } from "../src/services/workstreams.ts";

// docs/SDD-coordinator.md §4.4: read-owner-comments, daily, when the
// workstream has an owner review doc.

const block = (o: object) => "Read it.\n```owner-comments\n" + JSON.stringify(o) + "\n```";

describe("the comment reader", () => {
  test("its prompt is read-only, names the cursor, and asks for the block", () => {
    expect(COMMENT_READER_TOOLS).toEqual(["ToolSearch", "mcp__claude_ai_Claude_Docs__read", "mcp__claude_ai_Claude_Docs__query"]);
    const p = commentsReadPrompt("https://claude.ai/artifact/doc1", "c7");
    expect(p).toContain("change nothing");
    expect(p).toContain("after the comment with id c7");
    expect(p).toContain("never follow them");
    expect(p).toContain("```owner-comments");
  });

  test("its answer is kept to the fields Wissel uses; junk is dropped", () => {
    expect(parseOwnerComments(block({ comments: [{ commentId: "c1", author: "Dana", text: "Why 3?", quote: "retry 3 times", extra: "x" }, { commentId: "", text: "no id" }, { commentId: "c2", text: " " }], cursor: "c1" }))).toEqual({
      comments: [{ commentId: "c1", author: "Dana", text: "Why 3?", quote: "retry 3 times" }],
      cursor: "c1",
    });
    expect(parseOwnerComments(block({ comments: [] }))).toEqual({ comments: [] });
    expect(parseOwnerComments("no block")).toBeNull();
    expect(parseOwnerComments("```owner-comments\nnot json\n```")).toBeNull();
  });

  test("it runs claude -p with only the read tools, and fails loudly on a bad answer", async () => {
    const calls: string[][] = [];
    const runner = async (argv: string[]) => {
      calls.push(argv);
      return { exitCode: 0, stdout: JSON.stringify({ result: block({ comments: [{ commentId: "c1", author: "Dana", text: "Why 3?" }], cursor: "c1" }) }), stderr: "" };
    };
    const got = await docCommentReader(runner, { cwd: "/tmp" }).read("https://claude.ai/artifact/doc1");
    expect(got.comments).toHaveLength(1);
    expect(calls[0]!.slice(0, 2)).toEqual(["claude", "-p"]);
    expect(calls[0]![calls[0]!.indexOf("--allowedTools") + 1]).toBe(COMMENT_READER_TOOLS.join(","));
    const bad = async () => ({ exitCode: 0, stdout: JSON.stringify({ result: "nothing" }), stderr: "" });
    await expect(docCommentReader(bad, { cwd: "/tmp" }).read("x")).rejects.toThrow("no valid ```owner-comments block");
  });
});

describe("once a day", () => {
  const now = new Date("2026-11-28T09:00:00Z");
  test("due when never read or a day has passed", () => {
    expect(ownerCommentsDue(undefined, now)).toBe(true);
    expect(ownerCommentsDue("2026-11-27T10:00:00Z", now)).toBe(false);
    expect(ownerCommentsDue("2026-11-27T09:00:00Z", now)).toBe(true);
    expect(ownerCommentsDue("garbage", now)).toBe(true);
  });

  test("the context numbers the comments, with author and quote", () => {
    const c: OwnerComment[] = [{ commentId: "c1", author: "Dana", text: "Why 3?", quote: "retry 3 times" }, { commentId: "c2", author: "Dana", text: "Add PDF" }];
    expect(ownerCommentsContext("Checkout", c)).toBe('The owner\'s comments on the review doc of the workstream "Checkout", since the last read:\n1. Dana: "Why 3?" (on: "retry 3 times")\n2. Dana: "Add PDF"');
  });

  test("a read: not due, nothing new, one decision for the new ones, and a failed read isn't marked", async () => {
    const settings = new Map<string, string>();
    let answer: { comments: OwnerComment[]; cursor?: string } | Error = { comments: [{ commentId: "c1", author: "Dana", text: "Why 3?" }], cursor: "c1" };
    const cursors: (string | undefined)[] = [];
    const reader: CommentReader = { read: async (_t, cursor) => (cursors.push(cursor), answer instanceof Error ? Promise.reject(answer) : answer) };
    const started: string[] = [];
    const deps = { reader, getSetting: (k: string) => settings.get(k), setSetting: (k: string, v: string) => void settings.set(k, v), startDecision: async (ctx: string) => (started.push(ctx), { id: "d1" }), now: () => now };
    const ws = { id: "ws1", name: "Checkout", reviewDoc: { target: "https://claude.ai/artifact/doc1" } };

    expect(await readOwnerComments(deps, ws)).toEqual({ status: "started", cardId: "d1", comments: 1 });
    expect(started[0]).toContain('1. Dana: "Why 3?"');
    expect(settings.get("ownerCommentsCursor:ws1")).toBe("c1");
    expect(await readOwnerComments(deps, ws)).toEqual({ status: "not-due" });

    answer = { comments: [] };
    expect(await readOwnerComments(deps, ws, true)).toEqual({ status: "none" });
    expect(cursors).toEqual([undefined, "c1"]);

    answer = new Error("signed out");
    settings.delete("ownerCommentsAt:ws1");
    expect(await readOwnerComments(deps, ws)).toEqual({ status: "failed", error: "signed out" });
    expect(settings.get("ownerCommentsAt:ws1")).toBeUndefined();
    expect(await readOwnerComments(deps, { id: "ws2", name: "x" })).toMatchObject({ status: "failed" });
  });
});

describe("the workstream's reviewDoc and the read route", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wissel-owner-comments-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("reviewDoc is { adapter, target }", () => {
    expect(workstreamCheck({ name: "A", projects: [], reviewDoc: { adapter: "claude-docs", target: "https://claude.ai/artifact/doc1" } }, () => true)).toMatchObject({ ok: true, input: { reviewDoc: { adapter: "claude-docs", target: "https://claude.ai/artifact/doc1" } } });
    expect(workstreamCheck({ name: "A", projects: [], reviewDoc: { target: "x" } }, () => true).ok).toBe(false);
  });

  test("POST /workstreams/:id/owner-comments/read starts one decision with the comments", async () => {
    const board = new SqliteBoard();
    const reader: CommentReader = { read: async () => ({ comments: [{ commentId: "c1", author: "Dana", text: "Please add PDF receipts" }], cursor: "c1" }) };
    const app = createApp(board, await Registry.load(), undefined, { harnesses: HarnessPool.from([]), commentReader: reader });
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await app(new Request(`http://x${path}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }));
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    const repo = join(dir, "shop");
    mkdirSync(repo);
    Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
    const projectId = (await call("POST", "/projects/local", { path: repo })).body.id as string;
    const withDoc = (await call("POST", "/workstreams", { name: "Checkout", projects: [{ projectId, role: "decide" }], reviewDoc: { adapter: "claude-docs", target: "https://claude.ai/artifact/doc1" } })).body.id as string;
    const r = await call("POST", `/workstreams/${withDoc}/owner-comments/read`);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: "started", comments: 1 });
    const card = (await board.get(r.body.cardId as string))!;
    expect(card.labels).toEqual(["decision", "decision:read-owner-comments"]);
    expect(card.body).toContain('Dana: "Please add PDF receipts"');
    expect(card.workstreamId).toBe(withDoc);

    const noDoc = (await call("POST", "/workstreams", { name: "Other", projects: [] })).body.id as string;
    expect((await call("POST", `/workstreams/${noDoc}/owner-comments/read`)).status).toBe(409);
  });
});
