import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteBoard } from "../src/services/board.ts";
import { conversationTitle, SqliteConversationStore, TITLE_LENGTH } from "../src/services/conversations.ts";

// docs/SDD-wissel-app.md §3.4: Ask's `conversations` and `messages`
// tables in board.sqlite.

describe("conversationTitle", () => {
  test("the first message on one line, cut to the title length", () => {
    expect(conversationTitle("  create a card\n to check   the README ")).toBe("create a card to check the README");
    const long = conversationTitle("x".repeat(100));
    expect(long).toHaveLength(TITLE_LENGTH);
    expect(long.endsWith("…")).toBe(true);
    expect(conversationTitle("  \n ")).toBe("New chat");
  });
});

describe("SqliteConversationStore", () => {
  test("messages come back in order with actions, dropped and cost; updatedAt follows the last message", () => {
    const store = new SqliteConversationStore(new SqliteBoard().db);
    const c = store.create("hello", "2026-10-11T10:00:00.000Z");
    store.add({ conversationId: c.id, role: "user", text: "hello", actions: [], dropped: [], at: "2026-10-11T10:00:01.000Z" });
    const a = store.add({
      conversationId: c.id,
      role: "assistant",
      text: "Made it.",
      actions: [{ type: "create_task", ok: true, taskId: "t1", title: "Check" }],
      dropped: [{ type: "merge", reason: "not something Ask can do; use the board", disallowed: true }],
      costUsd: 0.05,
      at: "2026-10-11T10:00:05.000Z",
    });
    const msgs = store.messages(c.id);
    expect(msgs.map((m) => [m.role, m.text])).toEqual([
      ["user", "hello"],
      ["assistant", "Made it."],
    ]);
    expect(msgs[0]).not.toHaveProperty("costUsd");
    expect(msgs[0]!.actions).toEqual([]);
    expect(msgs[1]).toEqual(a);
    expect(store.get(c.id)!.updatedAt).toBe("2026-10-11T10:00:05.000Z");
  });

  test("list is most recently active first, limited", () => {
    const store = new SqliteConversationStore(new SqliteBoard().db);
    const older = store.create("older", "2026-10-11T09:00:00.000Z");
    const newer = store.create("newer", "2026-10-11T09:30:00.000Z");
    expect(store.list().map((c) => c.id)).toEqual([newer.id, older.id]);
    store.add({ conversationId: older.id, role: "user", text: "back again", actions: [], dropped: [], at: "2026-10-11T11:00:00.000Z" });
    expect(store.list().map((c) => c.id)).toEqual([older.id, newer.id]);
    expect(store.list(1).map((c) => c.id)).toEqual([older.id]);
  });

  test("adding to an unknown conversation throws; get of one is undefined", () => {
    const store = new SqliteConversationStore(new SqliteBoard().db);
    expect(store.get("nope")).toBeUndefined();
    expect(() => store.add({ conversationId: "nope", role: "user", text: "x", actions: [], dropped: [] })).toThrow("conversation not found: nope");
  });

  test("lives in board.sqlite and survives a reopen; opening twice is safe", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wissel-conv-"));
    try {
      const path = join(dir, "board.sqlite");
      const first = new SqliteBoard(path);
      const c = new SqliteConversationStore(first.db).create("kept");
      new SqliteConversationStore(first.db); // CREATE IF NOT EXISTS twice
      first.db.close();
      const again = new SqliteConversationStore(new SqliteBoard(path).db);
      expect(again.get(c.id)!.title).toBe("kept");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
