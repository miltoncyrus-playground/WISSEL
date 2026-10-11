import { describe, expect, test } from "vitest";
import {
  chipsOf,
  confirmCardsOf,
  controlChipsOf,
  costText,
  isPodcastPipeline,
  PENDING_STATE_WORDS,
  pendingStateNow,
  isSendKey,
  loadConversationId,
  MAX_MESSAGE_LENGTH,
  pendingMessage,
  quickReplies,
  saveConversationId,
  sendable,
  settle,
  statusTextOf,
} from "../src/ask";
import type { AskResult, ChatMessage, ControlExecuted, ExecutedAction, PendingView, PipelineDef, PodcastEpisode, TaskCard } from "../src/types";

const card = (id: string, over: Partial<TaskCard> = {}): TaskCard => ({ id, title: `Card ${id}`, body: "", labels: [], status: "inbox", ...over });
const reply = (actions: ExecutedAction[]): Pick<ChatMessage, "actions"> => ({ actions });

describe("chipsOf", () => {
  test("one chip per action that worked, in order, with the board's live status", () => {
    const tasks = [card("aaaaaaaa-1", { title: "Check the README", status: "running" }), card("bbbbbbbb-2", { title: "Old one", status: "done" })];
    const chips = chipsOf(
      reply([
        { type: "create_task", ok: true, taskId: "aaaaaaaa-1", title: "Check the README" },
        { type: "create_task", ok: false, error: "nope", title: "Broken" },
        { type: "show_task", ok: true, taskId: "bbbbbbbb-2" },
      ]),
      tasks,
    );
    expect(chips.map((c) => [c.taskId, c.kind, c.label, c.statusText, c.tone])).toEqual([
      ["aaaaaaaa-1", "card", "Check the README", "Running", "running"],
      ["bbbbbbbb-2", "card", "Old one", "Done", "done-today"],
    ]);
  });

  test("the status follows the board: the same message reads differently after a move", () => {
    const msg = reply([{ type: "create_task", ok: true, taskId: "t1", title: "T" }]);
    expect(chipsOf(msg, [card("t1", { status: "inbox" })])[0]!.statusText).toBe("Queued");
    expect(chipsOf(msg, [card("t1", { status: "running" })])[0]!.statusText).toBe("Running");
    expect(chipsOf(msg, [card("t1", { status: "failed" })])[0]).toMatchObject({ statusText: "Needs you: Failed", tone: "needs-you" });
    expect(chipsOf(msg, [card("t1", { status: "pending-review" })])[0]).toMatchObject({ statusText: "In review", tone: "review" });
  });

  test("a card no longer on the board is Gone, labelled by what the action knew", () => {
    const chips = chipsOf(
      reply([
        { type: "create_task", ok: true, taskId: "gone-1", title: "Was here" },
        { type: "show_task", ok: true, taskId: "abcdef0123456" },
      ]),
      [],
    );
    expect(chips.map((c) => [c.label, c.statusText, c.tone])).toEqual([
      ["Was here", "Gone", "gone"],
      ["abcdef01", "Gone", "gone"],
    ]);
  });

  test("before /tasks has answered, an unknown card is Loading, not Gone", () => {
    const chips = chipsOf(reply([{ type: "create_task", ok: true, taskId: "new-1", title: "Fresh" }]), [], [], false);
    expect(chips.map((c) => [c.statusText, c.tone])).toEqual([["Loading", "queued"]]);
  });

  test("the same card twice is one chip", () => {
    const chips = chipsOf(
      reply([
        { type: "create_task", ok: true, taskId: "t1", title: "T" },
        { type: "show_task", ok: true, taskId: "t1" },
      ]),
      [card("t1")],
    );
    expect(chips).toHaveLength(1);
  });

  test("a pipeline run is a run chip named after the pipeline; Play once its episode exists", () => {
    const msg = reply([{ type: "run_pipeline", ok: true, runId: "r1", name: "AI news podcast", pipelineId: "p1" }]);
    const tasks = [card("r1", { title: "Pipeline: AI news podcast", status: "running" })];
    expect(chipsOf(msg, tasks)[0]).toMatchObject({ kind: "run", label: "AI news podcast", statusText: "Running" });
    expect(chipsOf(msg, tasks)[0]!.track).toBeUndefined();

    const episode: PodcastEpisode = {
      runId: "r1",
      pipelineId: "p1",
      pipelineName: "AI news podcast",
      show: "ai",
      at: "2026-10-11T06:00:00Z",
      title: "Models got cheaper",
      durationSeconds: 300,
      audioUrl: "/pipeline-runs/r1/audio",
      quickRead: null,
    };
    expect(chipsOf(msg, tasks, [episode])[0]!.track).toEqual({
      runId: "r1",
      title: "Models got cheaper",
      pipelineName: "AI news podcast",
      audioUrl: "/pipeline-runs/r1/audio",
      durationSeconds: 300,
    });
  });

  test("statusTextOf names an MCP approval", () => {
    expect(statusTextOf(card("t", { status: "review", pendingMcpApproval: { server: "gh", tool: "merge" } }))).toBe("Needs you: Approve gh · merge");
  });
});

describe("quickReplies", () => {
  const podcast = (id: string, name: string): PipelineDef => ({ id, name, description: "", graph: { steps: [{ agentId: "news-gather" }, { agentId: "podcast-audio" }] } });
  const plain: PipelineDef = { id: "x", name: "Review flow", description: "", graph: { steps: [{ agentId: "implementer" }] } };

  test("podcasts by their real name (at most two), the board-control three, two questions, and Show board as a link", () => {
    const replies = quickReplies([plain, podcast("a", "AI news"), podcast("w", "World news"), podcast("r", "Retro")]);
    expect(replies).toEqual([
      { label: "Run AI news", text: "Run the AI news pipeline" },
      { label: "Run World news", text: "Run the World news pipeline" },
      { label: "What needs me?", text: "What needs me?" },
      { label: "Retry failed", text: "Retry every failed card" },
      { label: "Show harnesses", text: "Show me the harnesses" },
      { label: "What did I do this week?", text: "What did I do this week?" },
      { label: "What is running?", text: "What is running?" },
      { label: "Show board", href: "#/board" },
    ]);
  });

  test("no podcasts, no Run reply; a pipeline without a graph is not a podcast", () => {
    expect(isPodcastPipeline({ id: "n", name: "n", description: "" })).toBe(false);
    expect(quickReplies([plain]).map((r) => r.label)).toEqual(["What needs me?", "Retry failed", "Show harnesses", "What did I do this week?", "What is running?", "Show board"]);
  });
});

describe("board controls (§3.7)", () => {
  const NOW = Date.parse("2026-10-11T10:00:00Z");
  const control = (over: Partial<ControlExecuted> = {}): ControlExecuted => ({
    type: "archive_task",
    control: true,
    ok: true,
    tier: "A",
    confirmedBy: "tier-a",
    target: { kind: "card", id: "t1", label: "Old" },
    text: "Archived 'Old' (card t1).",
    ...over,
  });
  const pend = (over: Partial<PendingView> = {}): PendingView => ({ id: "p1", kind: "confirm", lines: ["Merge 'X' (card t2)"], state: "open", expiresAt: "2026-10-11T10:10:00Z", ...over });

  test("controlChipsOf: done green, refused orange, Undo with its state, and refusals found before running", () => {
    const msg: Pick<ChatMessage, "actions" | "dropped" | "pending"> = {
      actions: [
        { type: "create_task", ok: true, taskId: "c1", title: "New" },
        control({ undoId: "u1" }),
        control({ ok: false, error: "it is running", text: "Did not stop 'R' (card t3): it is running.", type: "stop_task", target: { kind: "card", id: "t3", label: "R" } }),
        control({ type: "set_harness_enabled", target: { kind: "harness", id: "codex", label: "codex" }, text: "Disabled harness codex." }),
      ],
      dropped: [
        { type: "retry_task", reason: "it is inbox, not failed", disallowed: false, text: "Did not retry 'L' (card t4): it is inbox, not failed." },
        { type: "archive_task", reason: "no single card", disallowed: false, question: "Which card should I archive?" },
        { type: "merge", reason: "not something Ask can do; use the board", disallowed: true },
      ],
      pending: [pend({ id: "u1", kind: "undo", lines: ["Unarchive 'Old' (card t1)"] })],
    };
    expect(controlChipsOf(msg, NOW)).toEqual([
      { key: "control:1", text: "Archived 'Old' (card t1).", tone: "done", taskId: "t1", undo: { id: "u1", state: "open" } },
      { key: "control:2", text: "Did not stop 'R' (card t3): it is running.", tone: "refused", taskId: "t3" },
      { key: "control:3", text: "Disabled harness codex.", tone: "done" },
      { key: "refused:0", text: "Did not retry 'L' (card t4): it is inbox, not failed.", tone: "refused" },
    ]);
    // An Undo past its time is not offered.
    expect(controlChipsOf(msg, Date.parse("2026-10-11T10:10:00Z"))[0]!.undo).toEqual({ id: "u1", state: "expired" });
  });

  test("chipsOf leaves board controls to controlChipsOf", () => {
    expect(chipsOf(reply([control()]), [card("t1")])).toEqual([]);
  });

  test("confirmCardsOf: only kind confirm, and open turns expired on the client's clock too", () => {
    const msg = { pending: [pend(), pend({ id: "u1", kind: "undo" }), pend({ id: "p2", state: "cancelled" })] };
    expect(confirmCardsOf(msg, NOW).map((p) => [p.id, p.state])).toEqual([
      ["p1", "open"],
      ["p2", "cancelled"],
    ]);
    expect(confirmCardsOf(msg, Date.parse("2026-10-11T10:10:00Z"))[0]!.state).toBe("expired");
    expect(confirmCardsOf({})).toEqual([]);
    expect(pendingStateNow(pend({ state: "confirmed", expiresAt: "2000-01-01T00:00:00Z" }), NOW)).toBe("confirmed");
  });

  test("every pending state has short plain words, no em dashes", () => {
    for (const s of ["open", "confirmed", "cancelled", "expired"] as const) {
      expect(PENDING_STATE_WORDS[s].length).toBeGreaterThan(0);
      expect(PENDING_STATE_WORDS[s]).not.toContain("—");
    }
  });
});

describe("composer", () => {
  test("Enter sends; Shift, Alt, Ctrl or Cmd with Enter, or an IME composing, does not", () => {
    const k = { key: "Enter", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false };
    expect(isSendKey(k)).toBe(true);
    expect(isSendKey({ ...k, shiftKey: true })).toBe(false);
    expect(isSendKey({ ...k, altKey: true })).toBe(false);
    expect(isSendKey({ ...k, ctrlKey: true })).toBe(false);
    expect(isSendKey({ ...k, metaKey: true })).toBe(false);
    expect(isSendKey({ ...k, isComposing: true })).toBe(false);
    expect(isSendKey({ ...k, key: "a" })).toBe(false);
  });

  test("sendable trims, refuses empty and over-long text", () => {
    expect(sendable("  hi \n")).toBe("hi");
    expect(sendable("   ")).toBeNull();
    expect(sendable("x".repeat(MAX_MESSAGE_LENGTH))).toHaveLength(MAX_MESSAGE_LENGTH);
    expect(sendable("x".repeat(MAX_MESSAGE_LENGTH + 1))).toBeNull();
  });

  test("costText: three decimals under a dollar, two above, nothing when unknown", () => {
    expect(costText(0.0123)).toBe("$0.012");
    expect(costText(0)).toBe("$0.000");
    expect(costText(1.234)).toBe("$1.23");
    expect(costText(undefined)).toBe("");
    expect(costText(Number.NaN)).toBe("");
  });
});

describe("settle", () => {
  const msg = (id: string, role: "user" | "assistant", text: string): ChatMessage => ({ id, conversationId: "c", role, text, actions: [], dropped: [], at: "2026-10-11T10:00:00Z" });
  const result = (u: ChatMessage, a: ChatMessage): AskResult => ({ conversation: { id: "c", title: "t", createdAt: "", updatedAt: "" }, user: u, assistant: a });

  test("the pending bubble is replaced by the server's pair", () => {
    const pending = pendingMessage("hello", "c", "2026-10-11T10:00:00Z");
    expect(pending.id.startsWith("pending-")).toBe(true);
    const out = settle([msg("m0", "assistant", "earlier"), pending], pending.id, result(msg("u1", "user", "hello"), msg("a1", "assistant", "Hi.")));
    expect(out.map((m) => m.id)).toEqual(["m0", "u1", "a1"]);
  });

  test("a refetch that already brought the pair in does not double it", () => {
    const pending = pendingMessage("hello", "c", "2026-10-11T10:00:00Z");
    const u = msg("u1", "user", "hello");
    const a = msg("a1", "assistant", "Hi.");
    expect(settle([u, a, pending], pending.id, result(u, a)).map((m) => m.id)).toEqual(["u1", "a1"]);
  });
});

describe("the open chat in localStorage", () => {
  function memory() {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    };
  }

  test("saved, read back, cleared", () => {
    const s = memory();
    expect(loadConversationId(s)).toBeNull();
    saveConversationId("6f1c-uuid", s);
    expect(loadConversationId(s)).toBe("6f1c-uuid");
    saveConversationId(null, s);
    expect(loadConversationId(s)).toBeNull();
  });

  test("junk is ignored and storage that throws is survived", () => {
    const s = memory();
    s.setItem("wissel.app.askConversation", "../../etc");
    expect(loadConversationId(s)).toBeNull();
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadConversationId(broken)).toBeNull();
    expect(() => saveConversationId("x", broken)).not.toThrow();
  });
});
