import { describe, expect, test } from "bun:test";
import {
  ACTION_TIERS,
  ALLOWED_ACTION_TYPES,
  BATCHABLE,
  CARD_ACTION_TYPES,
  CONFIRM_BATCH_OVER,
  CONTROL_ACTION_TYPES,
  MAX_BATCH,
  cardRefusal,
  clarifyingQuestion,
  droppedNote,
  needsConfirm,
  neverReason,
  recheckControl,
  resolveCard,
  validateActions,
  type ActionContext,
  type CardControl,
  type ControlAction,
} from "../src/services/concierge-actions.ts";
import { cardSentence, executeControl, otherSentence, pendingLines, type ControlDeps } from "../src/services/concierge-control.ts";
import type { TaskCard } from "../src/core/types.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { SqlitePipelineStore } from "../src/services/pipelines.ts";
import { SqliteProjectStore } from "../src/services/projects.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { McpServerPool } from "../src/core/mcp-server-pool.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";

// docs/SDD-wissel-app.md §3.7: Ask controls the board. The model
// proposes; this code decides which card, whether the board would allow
// it, and whether it runs now or waits for a Confirm tap.

let n = 0;
function card(title: string, over: Partial<TaskCard> = {}): TaskCard {
  n++;
  const hex = n.toString(16).padStart(8, "0");
  return { id: `${hex}-0000-4000-8000-${hex}0000`, title, body: "", labels: ["code"], status: "inbox", ...over };
}

const FEED = card("Feed and Stories", { status: "failed" });
const FLAKY = card("Fix the flaky e2e test", { status: "failed" });
const LISTEN = card("Ship the Listen tab");
const SHIPFEED = card("Ship the Feed screen", { status: "done" });
const DARK = card("Add a dark mode toggle", { status: "review" });
const ONBOARD = card("Write the onboarding doc", { status: "review" });
const SLACK = card("Post the Slack summary", { status: "review", pendingMcpApproval: { server: "slack", tool: "post", args: {}, reason: "r" } });
const MIGRATE = card("Migrate the projects table", { status: "escalated", suggestedGrants: ["Bash(npm test:*)"] });
const SCORING = card("Rewrite the router scoring", { status: "escalated" });
const ROUTER = card("Refactor the router", { status: "running" });
const OLD = card("Old podcast experiment", { status: "done" });
const WAKE = card("Spike: voice wake word", { status: "done", archivedAt: "2026-10-01T00:00:00Z" });
const README1 = card("Update the README badges");
const README2 = card("Update the README install steps");
const STEP = card("Step: gather", { status: "failed", pipelineRunId: "run-1" });
const OLDTRY = card("Feed and Stories", { status: "failed", supersededBy: FEED.id });
const INSTALL = card("Install the linter");
const TASKS = [FEED, FLAKY, LISTEN, SHIPFEED, DARK, ONBOARD, SLACK, MIGRATE, SCORING, ROUTER, OLD, WAKE, README1, README2, STEP, OLDTRY, INSTALL];

function ctx(over: Partial<ActionContext> = {}): ActionContext {
  return {
    projects: [
      { id: "p1", name: "wissel", path: "/r/wissel" },
      { id: "p2", name: "old-scratch", path: "/r/old" },
    ],
    pipelines: [
      { id: "pl-ai", name: "AI news podcast" },
      { id: "pl-retro", name: "Wissel retrospective podcast" },
    ],
    knownLabels: ["code", "docs"],
    taskIds: TASKS.map((t) => t.id),
    repoRequiredBy: () => undefined,
    pipelineNeedsRepo: () => false,
    tasks: TASKS,
    hasWorktree: (id) => id === DARK.id,
    harnesses: [
      { id: "claude", label: "Claude (Milton)", enabled: true, model: "claude-opus-5-5" },
      { id: "codex", label: "Codex", enabled: true },
      { id: "claude-team", label: "Claude (team)", enabled: false },
    ],
    mcpServers: [
      {
        id: "jira",
        label: "Jira",
        enabled: true,
        tools: [
          { name: "search", trust: "auto" },
          { name: "create_issue", trust: "approval-required" },
        ],
      },
      { id: "slack", label: "Slack", enabled: false, tools: [{ name: "post", trust: "approval-required" }] },
    ],
    availableModels: (id) => (id === "claude" ? ["claude-opus-5-5", "claude-sonnet-5-5"] : []),
    controlsEnabled: true,
    ...over,
  };
}

const one = (raw: Record<string, unknown>, c = ctx()) => validateActions([raw], c);

describe("the tier table", () => {
  test("every control action type has exactly one tier, and no other key is in it", () => {
    for (const t of CONTROL_ACTION_TYPES) expect(["A", "B"]).toContain(ACTION_TIERS[t]);
    expect(Object.keys(ACTION_TIERS).sort()).toEqual([...CONTROL_ACTION_TYPES].sort());
  });

  test("Tier B is exactly the destructive list in §3.7", () => {
    const b = CONTROL_ACTION_TYPES.filter((t) => ACTION_TIERS[t] === "B").sort();
    expect(b).toEqual(["delete_pipeline", "delete_task", "discard_task", "grant_allowed_tools", "merge_task", "remove_project", "trust_mcp_tool"]);
  });

  test("the allowed list is the three basic types plus every control type", () => {
    expect(ALLOWED_ACTION_TYPES).toEqual(["create_task", "run_pipeline", "show_task", ...CONTROL_ACTION_TYPES]);
  });

  test("needsConfirm: Tier B always; a batch only over CONFIRM_BATCH_OVER cards", () => {
    const a = (taskIds: string[], batch: boolean, type: CardControl["type"] = "archive_task"): CardControl => ({ type, tier: ACTION_TIERS[type], taskIds, batch });
    expect(needsConfirm(a(["x"], false))).toBe(false);
    expect(needsConfirm(a(["1", "2", "3"], true))).toBe(false);
    expect(needsConfirm(a(["1", "2", "3", "4"], true))).toBe(true);
    expect(needsConfirm(a(["x"], false, "delete_task"))).toBe(true);
    expect(needsConfirm({ type: "delete_pipeline", tier: "B", pipelineId: "p", name: "p" })).toBe(true);
    expect(needsConfirm({ type: "set_harness_enabled", tier: "A", harnessId: "codex", enabled: false })).toBe(false);
    expect(CONFIRM_BATCH_OVER).toBe(3);
  });
});

describe("resolveCard: targets are found in code", () => {
  test("an id prefix of 8+ characters, case-insensitive", () => {
    expect(resolveCard(FEED.id.slice(0, 8).toUpperCase(), TASKS)).toEqual({ ok: true, task: FEED });
    expect(resolveCard(FEED.id, TASKS)).toEqual({ ok: true, task: FEED });
  });

  test("an exact title wins over a longer one that contains it; quotes and case ignored", () => {
    const a = card("Fix tests");
    const b = card("Fix tests in the app");
    expect(resolveCard("'fix TESTS'", [a, b])).toEqual({ ok: true, task: a });
  });

  test("title words, as whole words only", () => {
    expect(resolveCard("dark mode", TASKS)).toEqual({ ok: true, task: DARK });
    expect(resolveCard("all", TASKS)).toMatchObject({ ok: false, reason: "none" }); // not "Install"
    expect(resolveCard("linter", TASKS)).toEqual({ ok: true, task: INSTALL });
  });

  test("ambiguous: several titles fit; none: nothing fits, or under three characters", () => {
    const amb = resolveCard("Update the README", TASKS);
    expect(amb).toMatchObject({ ok: false, reason: "ambiguous" });
    expect(!amb.ok && amb.candidates.map((t) => t.id)).toEqual([README1.id, README2.id]);
    expect(resolveCard("ship", TASKS)).toMatchObject({ ok: false, reason: "ambiguous" }); // a live inbox card and a done one
    expect(resolveCard("nothing like this", TASKS)).toEqual({ ok: false, reason: "none", candidates: [] });
    expect(resolveCard("it", TASKS)).toEqual({ ok: false, reason: "none", candidates: [] });
  });

  test("titles never name a pipeline step or a superseded card; archived only when asked", () => {
    expect(resolveCard("Step: gather", TASKS)).toMatchObject({ ok: false, reason: "none" });
    expect(resolveCard("Feed and Stories", TASKS)).toEqual({ ok: true, task: FEED }); // not OLDTRY
    expect(resolveCard("wake word", TASKS)).toMatchObject({ ok: false, reason: "none" });
    expect(resolveCard("wake word", TASKS, true)).toEqual({ ok: true, task: WAKE });
    // An id still names any card, a step included.
    expect(resolveCard(STEP.id.slice(0, 8), TASKS)).toEqual({ ok: true, task: STEP });
  });

  test("the clarifying question names the candidates", () => {
    const amb = resolveCard("Update the README", TASKS);
    if (amb.ok) throw new Error("expected ambiguous");
    expect(clarifyingQuestion("Update the README", amb, "archive")).toBe(
      `Which card should I archive: 'Update the README badges' (card ${README1.id.slice(0, 8)}) or 'Update the README install steps' (card ${README2.id.slice(0, 8)})?`,
    );
    expect(clarifyingQuestion("zzz", { ok: false, reason: "none", candidates: [] }, "retry")).toBe('Which card should I retry? No card matches "zzz".');
  });
});

describe("cardRefusal: the board's own checks, never looser", () => {
  const c = ctx();
  const cases: [CardControl["type"], TaskCard, Record<string, unknown>, string | undefined][] = [
    ["retry_task", FEED, {}, undefined],
    ["retry_task", LISTEN, {}, "it is inbox, not failed"],
    ["retry_task", OLDTRY, {}, `it was replaced by card ${FEED.id.slice(0, 8)}; retry that one`],
    ["run_task", LISTEN, {}, undefined],
    ["run_task", ROUTER, {}, "it is already running"],
    ["stop_task", ROUTER, {}, undefined],
    ["stop_task", LISTEN, {}, "it is inbox, not running"],
    ["move_task", LISTEN, { status: "ready" }, undefined],
    ["move_task", LISTEN, { status: "inbox" }, "it is already inbox"],
    ["move_task", ROUTER, { status: "failed" }, "it is running; stop it instead"],
    ["move_task", DARK, { status: "done" }, "it has a worktree; merge it instead"],
    ["move_task", ONBOARD, { status: "done" }, undefined],
    ["approve_mcp_request", SLACK, {}, undefined],
    ["deny_mcp_request", DARK, {}, "task has no pending MCP approval request"],
    ["grant_and_retry", MIGRATE, {}, undefined],
    ["grant_and_retry", SCORING, {}, "it has no suggested grants; name the tools on the board"],
    ["grant_and_retry", FEED, {}, "task is not escalated"],
    ["abandon_escalation", SCORING, {}, undefined],
    ["abandon_escalation", LISTEN, {}, "task is not escalated"],
    ["archive_task", OLD, {}, undefined],
    ["archive_task", WAKE, {}, "it is archived; unarchive it first"],
    ["unarchive_task", WAKE, {}, undefined],
    ["unarchive_task", OLD, {}, "it is not archived"],
    ["add_dependency", LISTEN, { dependsOn: FEED.id }, undefined],
    ["add_dependency", LISTEN, { dependsOn: LISTEN.id }, "a card can't wait for itself"],
    ["set_task_harness", LISTEN, { harness: "codex" }, undefined],
    ["set_task_harness", ROUTER, { harness: "codex" }, "task is running; change its harness once it stops"],
    ["set_task_harness", LISTEN, { harness: "nope" }, 'unknown harness "nope"'],
    ["merge_task", DARK, {}, undefined],
    ["merge_task", ONBOARD, {}, "task has no worktree to merge"],
    ["merge_task", LISTEN, {}, "it is inbox, not in review"],
    ["merge_task", SLACK, {}, "it is waiting on an MCP approval, not in review"],
    ["discard_task", DARK, {}, undefined],
    ["discard_task", ONBOARD, {}, "task has no worktree to discard"],
    ["delete_task", LISTEN, {}, undefined],
    ["delete_task", ROUTER, {}, "it is running; stop it first"],
    ["grant_allowed_tools", MIGRATE, { tools: ["Bash(npm test:*)"] }, undefined],
    ["grant_allowed_tools", ROUTER, { tools: ["Bash(npm test:*)"] }, "task is running; change its tools once it stops"],
  ];
  for (const [type, task, extra, want] of cases) {
    test(`${type} on '${task.title}' (${task.status}${task.archivedAt ? ", archived" : ""}): ${want ?? "allowed"}`, () => {
      expect(cardRefusal(type, task, extra, c)).toBe(want);
    });
  }

  test("add_dependency refuses a loop and a repeat", () => {
    const a = card("A", { dependsOn: [] });
    const b = card("B", { dependsOn: [a.id] });
    const loop = ctx({ tasks: [a, b] });
    expect(cardRefusal("add_dependency", a, { dependsOn: b.id }, loop)).toBe("that card already waits for it, so this would be a loop");
    expect(cardRefusal("add_dependency", b, { dependsOn: a.id }, loop)).toBe("it already waits for that card");
  });

  test("every card action type has a precondition branch", () => {
    for (const t of CARD_ACTION_TYPES) expect(() => cardRefusal(t, LISTEN, { status: "ready", dependsOn: FEED.id, harness: null, tools: [] }, c)).not.toThrow();
  });
});

describe("validateActions: control actions", () => {
  test("a Tier A card action resolves its card by title and keeps its tier", () => {
    expect(one({ type: "retry_task", card: "Feed and Stories" })).toEqual({ valid: [{ type: "retry_task", tier: "A", taskIds: [FEED.id], batch: false }], dropped: [] });
    // `id` works as an alias for `card`, the way show_task names a card.
    expect(one({ type: "archive_task", id: OLD.id.slice(0, 8) }).valid).toEqual([{ type: "archive_task", tier: "A", taskIds: [OLD.id], batch: false }]);
  });

  test("each card action's own fields are checked", () => {
    expect(one({ type: "move_task", card: "Listen tab", status: "ready" }).valid).toEqual([{ type: "move_task", tier: "A", taskIds: [LISTEN.id], batch: false, status: "ready" }]);
    expect(one({ type: "move_task", card: "Listen tab", status: "running" }).dropped[0]!.reason).toBe("a card can be moved to inbox, ready, review, done, failed");
    expect(one({ type: "add_dependency", card: "Listen tab", dependsOn: "Feed and Stories" }).valid).toEqual([
      { type: "add_dependency", tier: "A", taskIds: [LISTEN.id], batch: false, dependsOn: FEED.id },
    ]);
    expect(one({ type: "add_dependency", card: "Listen tab" }).dropped[0]!.reason).toBe("no card to wait for");
    expect(one({ type: "add_dependency", card: "Listen tab", dependsOn: "README" }).dropped[0]!.question).toContain("Which card should I make it wait for:");
    expect(one({ type: "set_task_harness", card: "Listen tab", harness: "Codex" }).valid).toEqual([{ type: "set_task_harness", tier: "A", taskIds: [LISTEN.id], batch: false, harness: "codex" }]);
    expect(one({ type: "set_task_harness", card: "Listen tab", harness: null }).valid).toEqual([{ type: "set_task_harness", tier: "A", taskIds: [LISTEN.id], batch: false, harness: null }]);
    expect(one({ type: "set_task_harness", card: "Listen tab", harness: "nope" }).dropped[0]!.reason).toBe('there is no harness called "nope"');
    expect(one({ type: "set_task_harness", card: "Listen tab" }).dropped[0]!.reason).toBe("no harness named (null clears it)");
    expect(one({ type: "grant_allowed_tools", card: "Migrate", tools: ["Bash(npm test:*)"] }).valid).toEqual([
      { type: "grant_allowed_tools", tier: "B", taskIds: [MIGRATE.id], batch: false, tools: ["Bash(npm test:*)"] },
    ]);
    expect(one({ type: "grant_allowed_tools", card: "Migrate", tools: [] }).dropped[0]!.reason).toBe("no tools named");
    expect(one({ type: "grant_allowed_tools", card: "Migrate", tools: ["Bash(*)"] }).dropped[0]!.disallowed).toBe(false);
  });

  test("no card, an ambiguous card, or none: a question, never an action", () => {
    expect(one({ type: "retry_task" }).dropped).toEqual([{ type: "retry_task", reason: "no card named; say which card to retry", disallowed: false, question: "Which card should I retry?" }]);
    const amb = one({ type: "archive_task", card: "Update the README" });
    expect(amb.valid).toEqual([]);
    expect(amb.dropped[0]!.question).toStartWith("Which card should I archive: 'Update the README badges'");
    expect(one({ type: "delete_task", card: "nothing like this" }).dropped[0]!.question).toBe('Which card should I delete? No card matches "nothing like this".');
  });

  test("a resolved card the board would refuse is dropped with a plain sentence", () => {
    const out = one({ type: "retry_task", card: "Listen tab" });
    expect(out.valid).toEqual([]);
    expect(out.dropped).toEqual([
      { type: "retry_task", reason: "it is inbox, not failed", disallowed: false, text: `Did not retry 'Ship the Listen tab' (card ${LISTEN.id.slice(0, 8)}): it is inbox, not failed.` },
    ]);
  });

  test("non-card actions resolve by id or label and refuse a no-op", () => {
    expect(one({ type: "set_harness_enabled", harness: "Codex", enabled: false }).valid).toEqual([{ type: "set_harness_enabled", tier: "A", harnessId: "codex", enabled: false }]);
    expect(one({ type: "set_harness_enabled", harness: "codex", enabled: true }).dropped[0]!.reason).toBe("harness codex is already enabled");
    expect(one({ type: "set_harness_enabled", harness: "codex" }).dropped[0]!.reason).toBe("say enabled: true or false");
    expect(one({ type: "set_harness_enabled", harness: "nope", enabled: true }).dropped[0]!.reason).toBe('there is no harness called "nope"');
    expect(one({ type: "set_harness_enabled", enabled: true }).dropped[0]!.reason).toBe("no harness named");
    expect(one({ type: "set_harness_model", harness: "claude", model: "claude-sonnet-5-5" }).valid).toEqual([{ type: "set_harness_model", tier: "A", harnessId: "claude", model: "claude-sonnet-5-5" }]);
    expect(one({ type: "set_harness_model", harness: "claude", model: "gpt-9" }).dropped[0]!.reason).toBe('model "gpt-9" is not in the known model list for harness "claude"');
    expect(one({ type: "set_harness_model", harness: "codex", model: "anything" }).valid).toHaveLength(1); // no cached list: no opinion
    expect(one({ type: "set_harness_model", harness: "claude", model: "claude-opus-5-5" }).dropped[0]!.reason).toBe("harness claude already uses claude-opus-5-5");
    expect(one({ type: "set_harness_model", harness: "claude", model: null }).valid).toEqual([{ type: "set_harness_model", tier: "A", harnessId: "claude", model: null }]);
    expect(one({ type: "set_mcp_server_enabled", server: "slack", enabled: true }).valid).toEqual([{ type: "set_mcp_server_enabled", tier: "A", serverId: "slack", enabled: true }]);
    expect(one({ type: "set_mcp_server_enabled", server: "jira", enabled: true }).dropped[0]!.reason).toBe("MCP server jira is already enabled");
    expect(one({ type: "set_mcp_server_enabled", server: "nope", enabled: true }).dropped[0]!.reason).toBe('there is no MCP server called "nope"');
    expect(one({ type: "trust_mcp_tool", server: "jira", tool: "create_issue", trust: "auto" }).valid).toEqual([{ type: "trust_mcp_tool", tier: "B", serverId: "jira", tool: "create_issue", trust: "auto" }]);
    expect(one({ type: "trust_mcp_tool", server: "jira", tool: "search", trust: "auto" }).dropped[0]!.reason).toBe("jira/search is already auto");
    expect(one({ type: "trust_mcp_tool", server: "jira", tool: "nope", trust: "auto" }).dropped[0]!.reason).toBe('MCP server jira has no tool "nope"');
    expect(one({ type: "trust_mcp_tool", server: "jira", tool: "search", trust: "yes" }).dropped[0]!.reason).toBe('trust must be "auto" or "approval-required"');
    expect(one({ type: "delete_pipeline", pipeline: "wissel retrospective podcast" }).valid).toEqual([{ type: "delete_pipeline", tier: "B", pipelineId: "pl-retro", name: "Wissel retrospective podcast" }]);
    expect(one({ type: "delete_pipeline", pipeline: "nope" }).dropped[0]!.reason).toBe('there is no pipeline called "nope"');
    expect(one({ type: "remove_project", project: "old-scratch" }).valid).toEqual([{ type: "remove_project", tier: "B", projectId: "p2", name: "old-scratch" }]);
    expect(one({ type: "remove_project", project: "/r/wissel" }).valid).toEqual([{ type: "remove_project", tier: "B", projectId: "p1", name: "wissel" }]);
    expect(one({ type: "remove_project", project: "nope" }).dropped[0]!.reason).toBe('there is no project called "nope"');
  });

  test("never-from-chat types are dropped as disallowed and marked never, with the reason", () => {
    const out = validateActions(
      [{ type: "set_api_key" }, { type: "switch_account" }, { type: "edit_manifest" }, { type: "update_agent" }, { type: "edit_pipeline" }, { type: "restart_server" }, { type: "shutdown" }, { type: "confirm" }],
      ctx(),
    );
    expect(out.valid).toEqual([]);
    expect(out.dropped.map((d) => [d.type, d.never ?? false, d.disallowed])).toEqual([
      ["set_api_key", true, true],
      ["switch_account", true, true],
      ["edit_manifest", true, true],
      ["update_agent", true, true],
      ["edit_pipeline", true, true],
      ["restart_server", true, true],
      ["shutdown", true, true],
      ["confirm", false, true],
    ]);
    expect(neverReason("set_api_key")).toBe("secrets, accounts and credentials never change from chat; do it by hand");
    expect(neverReason("edit_manifest")).toBe("agents/manifest.yaml is edited by hand, never from chat");
    expect(neverReason("edit_pipeline")).toBe("a pipeline's contents are edited in the board's pipeline editor, never from chat");
    expect(neverReason("restart_server")).toBe("the server is restarted by hand, never from chat");
    expect(neverReason("confirm")).toBeUndefined();
  });

  test("without board controls on the server, control actions are dropped with a reason", () => {
    expect(one({ type: "retry_task", card: "Feed and Stories" }, ctx({ controlsEnabled: false })).dropped[0]!.reason).toBe("board controls are not set up on this server; use the board");
  });

  test("MAX_ACTIONS still caps control actions; a repeat is dropped", () => {
    const out = validateActions(
      [
        { type: "retry_task", card: "Feed and Stories" },
        { type: "retry_task", card: "Feed and Stories" },
        { type: "retry_task", card: "flaky" },
        { type: "archive_task", card: "Old podcast" },
        { type: "run_task", card: "Listen tab" },
      ],
      ctx(),
    );
    expect(out.valid.map((a) => a.type)).toEqual(["retry_task", "retry_task", "archive_task"]);
    expect(out.dropped.map((d) => d.reason)).toEqual(["the same action twice", "over the limit of 3 actions per message"]);
  });
});

describe("batches: where {status}", () => {
  test("expands in code to the cards in that status that pass the precondition", () => {
    const out = one({ type: "retry_task", where: { status: "failed" } });
    // Not the pipeline step, not the superseded try.
    expect(out.valid).toEqual([{ type: "retry_task", tier: "A", taskIds: [FEED.id, FLAKY.id], batch: true }]);
  });

  test(`at most ${MAX_BATCH} cards; the rest are named`, () => {
    const many = Array.from({ length: 13 }, (_, i) => card(`Done thing ${i}`, { status: "done" }));
    const out = one({ type: "archive_task", where: { status: "done" } }, ctx({ tasks: many }));
    expect((out.valid[0] as CardControl).taskIds).toHaveLength(MAX_BATCH);
    expect(out.dropped).toEqual([{ type: "archive_task", reason: "3 more cards left out: at most 10 at a time; ask again for the rest", disallowed: false }]);
    expect(needsConfirm(out.valid[0] as ControlAction)).toBe(true);
  });

  test("refusals: both card and where, a type that takes one card, a bad status, nothing eligible", () => {
    expect(one({ type: "retry_task", card: "x", where: { status: "failed" } }).dropped[0]!.reason).toBe("name one card or a status, not both");
    expect(one({ type: "merge_task", where: { status: "review" } }).dropped[0]!.reason).toBe('"merge" takes one card at a time; name it');
    expect(one({ type: "retry_task", where: { status: "broken" } }).dropped[0]!.reason).toBe("where needs a card status");
    expect(one({ type: "retry_task", where: {} }).dropped[0]!.reason).toBe("where needs a card status");
    expect(one({ type: "stop_task", where: { status: "inbox" } }).dropped[0]!.reason).toBe("no inbox card can be stopped");
    for (const t of BATCHABLE) expect(ACTION_TIERS[t]).toBeDefined();
  });

  test("unarchive's batch reads archived cards", () => {
    expect(one({ type: "unarchive_task", where: { status: "done" } }).valid).toEqual([{ type: "unarchive_task", tier: "A", taskIds: [WAKE.id], batch: true }]);
  });
});

describe("recheckControl: the same checks again at Confirm time", () => {
  test("cards that no longer pass are refused by id, the rest kept", () => {
    const action: CardControl = { type: "retry_task", tier: "A", taskIds: [FEED.id, FLAKY.id], batch: true };
    const moved = ctx({ tasks: TASKS.map((t) => (t.id === FLAKY.id ? { ...t, status: "running" as const } : t)) });
    expect(recheckControl(action, moved)).toEqual({ action: { ...action, taskIds: [FEED.id] }, refused: [{ taskId: FLAKY.id, reason: "it is running, not failed" }] });
    const gone = ctx({ tasks: TASKS.filter((t) => t.id !== FEED.id && t.id !== FLAKY.id) });
    expect(recheckControl(action, gone).action).toBeNull();
  });

  test("a dependency target that's gone refuses the whole action", () => {
    const action: CardControl = { type: "add_dependency", tier: "A", taskIds: [LISTEN.id], batch: false, dependsOn: "deadbeef-0000" };
    expect(recheckControl(action, ctx()).action).toBeNull();
  });

  test("non-card actions pass or fail whole, on the state now", () => {
    const disable: ControlAction = { type: "set_harness_enabled", tier: "A", harnessId: "codex", enabled: false };
    expect(recheckControl(disable, ctx()).action).toEqual(disable);
    const already = ctx({ harnesses: [{ id: "codex", label: "Codex", enabled: false }] });
    expect(recheckControl(disable, already)).toEqual({ action: null, refused: [{ reason: "harness codex is already disabled" }] });
    const del: ControlAction = { type: "delete_pipeline", tier: "B", pipelineId: "pl-retro", name: "Wissel retrospective podcast" };
    expect(recheckControl(del, ctx()).action).toEqual(del);
    expect(recheckControl(del, ctx({ pipelines: [] })).action).toBeNull();
    for (const a of [
      { type: "set_harness_model", tier: "A", harnessId: "claude", model: null },
      { type: "set_mcp_server_enabled", tier: "A", serverId: "slack", enabled: true },
      { type: "trust_mcp_tool", tier: "B", serverId: "jira", tool: "create_issue", trust: "auto" },
      { type: "remove_project", tier: "B", projectId: "p2", name: "old-scratch" },
    ] as ControlAction[]) {
      expect(recheckControl(a, ctx()).action).toEqual(a);
    }
  });
});

describe("executeControl: the same functions the endpoints call, on the board as it is now", () => {
  const tmp = mkdtemp(join(tmpdir(), "wissel-exec-control-"));
  afterAll(async () => rm(await tmp, { recursive: true, force: true }));

  async function world() {
    const dir = await tmp;
    const board = new SqliteBoard();
    const pipelines = new SqlitePipelineStore(board.db);
    const projects = new SqliteProjectStore(board.db);
    board.db.run("INSERT INTO projects (id, name, path, source, createdAt) VALUES ('p2', 'old-scratch', '/r/old', 'local', '2026-10-01T00:00:00Z')");
    const pipeline = await pipelines.create({ name: "Retro", description: "", graph: { steps: [], edges: [] } });
    const runNow: string[] = [];
    const harnesses = HarnessPool.from([{ id: "codex", tool: "codex-cli", label: "Codex", enabled: true }]);
    const mcpServers = McpServerPool.from([{ id: "jira", label: "Jira", transport: { kind: "http", url: "http://x.invalid" }, tools: [{ name: "search", trust: "auto" }], enabled: true }]);
    const deps: ControlDeps = {
      board,
      runNow: async (id) => void runNow.push(id),
      gitRunner: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      harness: { harnesses, harnessesPath: join(dir, `h-${Math.random()}.yaml`), harnessRunner: async () => ({ stdout: '{"loggedIn":true}', stderr: "", exitCode: 0 }), modelsCachePath: join(dir, "none.json") },
      mcp: { mcpServers, mcpServersPath: join(dir, `m-${Math.random()}.yaml`), reachability: {} },
      pipelines,
      projects,
    };
    const now = async (): Promise<ActionContext> =>
      ctx({
        tasks: await board.list(),
        harnesses: harnesses.all().map((h) => ({ id: h.id, label: h.label, enabled: h.enabled })),
        mcpServers: mcpServers.all(),
        pipelines: (await pipelines.list()).map((p) => ({ id: p.id, name: p.name })),
        projects: (await projects.list()).map((p) => ({ id: p.id, name: p.name, path: p.path })),
        hasWorktree: () => false,
      });
    return { board, deps, now, runNow, harnesses, mcpServers, pipeline };
  }
  const a = (type: CardControl["type"], taskIds: string[], extra: Partial<CardControl> = {}): CardControl => ({ type, tier: ACTION_TIERS[type], taskIds, batch: false, ...extra });

  test("Tier A card actions reach the board, and move/archive come back with their inverse", async () => {
    const w = await world();
    const listen = await w.board.create({ title: "Listen", body: "", labels: ["docs"] });
    const feed = await w.board.move((await w.board.create({ title: "Feed", body: "", labels: ["docs"] })).id, "failed");
    const router = await w.board.move((await w.board.create({ title: "Router", body: "", labels: ["docs"] })).id, "running");

    const moved = await executeControl(a("move_task", [listen.id], { status: "ready" }), await w.now(), w.deps, "tier-a");
    expect(moved.executed.map((e) => e.ok)).toEqual([true]);
    expect(moved.inverse).toEqual([a("move_task", [listen.id], { status: "inbox" })]);
    expect((await w.board.get(listen.id))!.status).toBe("ready");

    await executeControl(a("retry_task", [feed.id]), await w.now(), w.deps, "tier-a");
    expect(w.runNow).toEqual([feed.id]);
    await executeControl(a("stop_task", [router.id]), await w.now(), w.deps, "tier-a");
    expect((await w.board.get(router.id))!.status).toBe("failed");
    await executeControl(a("add_dependency", [listen.id], { dependsOn: feed.id }), await w.now(), w.deps, "tier-a");
    expect((await w.board.get(listen.id))!.dependsOn).toEqual([feed.id]);
    await executeControl(a("set_task_harness", [listen.id], { harness: "codex" }), await w.now(), w.deps, "tier-a");
    expect((await w.board.get(listen.id))!.harnessOverride).toBe("codex");

    const archived = await executeControl(a("archive_task", [listen.id]), await w.now(), w.deps, "tier-a");
    expect(archived.inverse).toEqual([a("unarchive_task", [listen.id])]);
    await executeControl(archived.inverse[0]!, await w.now(), w.deps, "undo");
    expect((await w.board.get(listen.id))!.archivedAt).toBeUndefined();
    expect(archived.executed[0]!.text).toBe(`Archived 'Listen' (card ${listen.id.slice(0, 8)}).`);
  });

  test("the recheck runs on the context it is given: a card that moved is refused, not acted on", async () => {
    const w = await world();
    const router = await w.board.move((await w.board.create({ title: "Router", body: "", labels: ["docs"] })).id, "running");
    const action = a("stop_task", [router.id]);
    await w.board.move(router.id, "done"); // after validation, before running
    const out = await executeControl(action, await w.now(), w.deps, "tier-a");
    expect(out.executed).toMatchObject([{ ok: false, error: "it is done, not running", text: `Did not stop 'Router' (card ${router.id.slice(0, 8)}): it is done, not running.` }]);
    expect((await w.board.get(router.id))!.status).toBe("done");
    expect(out.inverse).toEqual([]);
  });

  test("escalation and MCP request actions use board-actions.ts and say why they failed", async () => {
    const w = await world();
    const esc = await w.board.escalate((await w.board.create({ title: "Esc", body: "", labels: ["docs"] })).id, "why");
    await executeControl(a("abandon_escalation", [esc.id]), await w.now(), w.deps, "tier-a");
    expect((await w.board.get(esc.id))!.status).toBe("failed");
    const req = await w.board.requestMcpApproval((await w.board.create({ title: "Ask", body: "", labels: ["docs"] })).id, { server: "s", tool: "t", args: {}, reason: "r" });
    await executeControl(a("deny_mcp_request", [req.id]), await w.now(), w.deps, "tier-a");
    expect((await w.board.get(req.id))!.status).toBe("failed");
    // grant_and_retry with no review in the lineage: grantAndRetry's own refusal.
    const g = await w.board.escalate((await w.board.create({ title: "G", body: "", labels: ["docs"] })).id, "why", ["Bash(npm test:*)"]);
    const out = await executeControl(a("grant_and_retry", [g.id]), await w.now(), w.deps, "tier-a");
    expect(out.executed[0]).toMatchObject({ ok: false, error: "no review of this attempt to continue from; use Retry instead" });
  });

  test("Tier B and non-card actions, confirmed", async () => {
    const w = await world();
    const t = await w.board.create({ title: "Gone soon", body: "", labels: ["docs"] });
    await executeControl(a("grant_allowed_tools", [t.id], { tools: ["Bash(npm test:*)"] }), await w.now(), w.deps, "confirm");
    expect((await w.board.get(t.id))!.extraAllowedTools).toEqual(["Bash(npm test:*)"]);
    const del = await executeControl(a("delete_task", [t.id]), await w.now(), w.deps, "confirm");
    expect(del.executed[0]).toMatchObject({ ok: true, confirmedBy: "confirm", tier: "B" });
    expect(await w.board.get(t.id)).toBeUndefined();

    await executeControl({ type: "delete_pipeline", tier: "B", pipelineId: w.pipeline.id, name: "Retro" }, await w.now(), w.deps, "confirm");
    expect(await w.deps.pipelines.get(w.pipeline.id)).toBeUndefined();
    await executeControl({ type: "remove_project", tier: "B", projectId: "p2", name: "old-scratch" }, await w.now(), w.deps, "confirm");
    expect(await w.deps.projects.list()).toEqual([]);
    await executeControl({ type: "trust_mcp_tool", tier: "B", serverId: "jira", tool: "search", trust: "approval-required" }, await w.now(), w.deps, "confirm");
    expect(w.mcpServers.get("jira")!.tools).toEqual([{ name: "search", trust: "approval-required" }]);

    const off = await executeControl({ type: "set_harness_enabled", tier: "A", harnessId: "codex", enabled: false }, await w.now(), w.deps, "tier-a");
    expect(w.harnesses.get("codex")!.enabled).toBe(false);
    expect(off.inverse).toEqual([{ type: "set_harness_enabled", tier: "A", harnessId: "codex", enabled: true }]);
    expect(off.executed[0]!.target).toEqual({ kind: "harness", id: "codex", label: "codex" });
  });
});

describe("plain words", () => {
  test("droppedNote: questions first, then refusal sentences, then the list", () => {
    expect(
      droppedNote([
        { type: "merge", reason: "not something Ask can do; use the board", disallowed: true },
        { type: "retry_task", reason: "it is inbox, not failed", disallowed: false, text: "Did not retry 'X' (card 1): it is inbox, not failed." },
        { type: "archive_task", reason: "no single card", disallowed: false, question: "Which card should I archive?" },
        { type: "delete_task", reason: "no single card", disallowed: false, question: "Which card should I archive?" },
      ]),
    ).toBe("Which card should I archive?\nDid not retry 'X' (card 1): it is inbox, not failed.\nI left out:\n- merge: not something Ask can do; use the board");
  });

  test("sentences for what was done, refused, and what waits for Confirm", () => {
    const c = ctx();
    const retry: CardControl = { type: "retry_task", tier: "A", taskIds: [FEED.id], batch: false };
    expect(cardSentence(retry, FEED, c)).toBe(`Retried 'Feed and Stories' (card ${FEED.id.slice(0, 8)}).`);
    expect(cardSentence(retry, FEED, c, "it is already running")).toBe(`Did not retry 'Feed and Stories' (card ${FEED.id.slice(0, 8)}): it is already running.`);
    expect(cardSentence({ ...retry, type: "move_task", status: "ready" }, LISTEN, c)).toBe(`Moved 'Ship the Listen tab' (card ${LISTEN.id.slice(0, 8)}) to ready.`);
    expect(cardSentence({ ...retry, type: "add_dependency", dependsOn: FEED.id }, LISTEN, c)).toBe(
      `'Ship the Listen tab' (card ${LISTEN.id.slice(0, 8)}) now waits for 'Feed and Stories' (card ${FEED.id.slice(0, 8)}).`,
    );
    expect(otherSentence({ type: "set_harness_enabled", tier: "A", harnessId: "codex", enabled: false })).toBe("Disabled harness codex.");
    expect(otherSentence({ type: "set_harness_enabled", tier: "A", harnessId: "codex", enabled: true }, "still not authenticated")).toBe("Did not enable harness codex: still not authenticated.");
    expect(pendingLines({ type: "merge_task", tier: "B", taskIds: [DARK.id], batch: false }, c)).toEqual([`Merge 'Add a dark mode toggle' (card ${DARK.id.slice(0, 8)})`]);
    expect(pendingLines({ type: "remove_project", tier: "B", projectId: "p2", name: "old-scratch" }, c)).toEqual(["Remove project 'old-scratch'"]);
  });
});
