import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { findInternalVocabulary } from "../../src/core/user-vocabulary.ts";
import { quickReplies } from "../src/ask";
import { LivePanel } from "../src/components/LivePanel";
import { Rail, TabBar, TopBar } from "../src/components/Nav";
import { Palette } from "../src/components/Palette";
import { partitionLanes, needsYouView } from "../src/lanes";
import { AskScreen } from "../src/screens/AskScreen";
import { BoardScreen, CardDetail } from "../src/screens/BoardScreen";
import { FeedScreen } from "../src/screens/FeedScreen";
import { ListenScreen } from "../src/screens/ListenScreen";
import { YouScreen } from "../src/screens/YouScreen";
import type { TaskCard } from "../src/types";
import { statusText, UiModeContext, type UiMode } from "../src/uiMode";
import type { AskState } from "../src/useAsk";

// docs/cards/ui-vocabulary-pass.md card 4: no member of
// FORBIDDEN_IN_USER_MODE in a user-mode render of each screen, and
// operator mode saying exactly what it said before.

const NOW = Date.parse("2026-11-26T12:00:00Z");
const id = (n: number) => `${String(n).repeat(8)}-0000-4000-8000-000000000000`;

function card(n: number, over: Partial<TaskCard>): TaskCard {
  return { id: id(n), title: `Fix login ${n}`, body: "", labels: [], status: "inbox", repo: "/home/me/billing", ...over } as TaskCard;
}

const tasks: TaskCard[] = [
  card(1, { status: "running", routedTo: "implementer", harness: "claude-work" }),
  card(2, {
    status: "escalated",
    pushbackCount: 1,
    needsYou: { kind: "grant-tools", value: "grant-tools", line: "Needs Bash(psql:*) to continue (round 2)", reason: "The worktree needed psql.", reasonSource: "escalation", rounds: 2, grants: ["Bash(psql:*)"], action: { label: "Grant and retry", href: `/tasks/${id(2)}/escalation/grant-and-retry`, method: "POST" } },
  }),
  card(3, {
    status: "escalated",
    pushbackCount: 4,
    needsYou: { kind: "escalated", value: "escalated", line: "Escalated after 5 rounds: pushback loop", reason: "Attempt 5: the harness timed out", reasonSource: "escalation", rounds: 5, action: { label: "Retry", href: `/tasks/${id(3)}/escalation/retry`, method: "POST" } },
  }),
  card(4, { status: "no-match", needsYou: { kind: "no-match", value: "no-match", line: "No agent matched", action: { label: "Open", href: `/app#/board/${id(4)}`, method: "GET" } } }),
  card(5, { status: "failed", needsYou: { kind: "failed", value: "failed", line: "Failed: worktree missing", action: { label: "Retry", href: `/tasks/${id(5)}/run`, method: "POST" } } }),
  card(6, {
    status: "inbox",
    needsYou: { kind: "blocked-on", value: `blocked-on:${id(3).slice(0, 8)} escalated`, line: "Waiting on Fix login 3, which is escalated", blocker: { id: id(3), id8: id(3).slice(0, 8), status: "escalated" }, action: { label: "Open", href: `/app#/board/${id(3)}`, method: "GET" } },
  }),
  card(7, { status: "pending-review" }),
];

const ask: AskState = {
  conversationId: null,
  messages: [],
  loaded: true,
  thinking: false,
  error: null,
  chats: null,
  send: () => {},
  newChat: () => {},
  openChat: () => {},
  listChats: () => {},
  resolvePending: async () => {},
};

function render(mode: UiMode, el: ReactElement): string {
  return renderToStaticMarkup(<UiModeContext.Provider value={mode}>{el}</UiModeContext.Provider>);
}

/** What a person reads, minus their own words (card titles) and the
 *  agent's raw output, which user mode keeps behind a toggle. */
function readable(html: string): string {
  return html.replace(/Fix login \d/g, " ").replace(/<[^>]+data-user-content[^>]*>[\s\S]*?<\/[^>]+>/g, " ");
}

const lanes = partitionLanes(tasks, NOW);
const screens: Array<[string, ReactElement]> = [
  ["Board", <BoardScreen lanes={lanes} loaded error={null} />],
  ...tasks.map((t): [string, ReactElement] => [`Card detail (${t.status})`, <CardDetail taskId={t.id} tasks={tasks} loaded />]),
  ["Card detail (missing)", <CardDetail taskId="nope" tasks={tasks} loaded />],
  ["Ask", <AskScreen ask={ask} tasks={tasks} tasksLoaded pipelines={[]} now={NOW} />],
  ["Feed", <FeedScreen now={NOW} />],
  ["Listen", <ListenScreen now={NOW} />],
  ["You", <YouScreen running={lanes.running} />],
  ["Live panel", <LivePanel lanes={lanes} connection="open" />],
  ["Rail", <Rail current="board" onOpenPalette={() => {}} />],
  ["Top bar", <TopBar title="Board" onOpenPalette={() => {}} />],
  ["Tab bar", <TabBar current="board" />],
  ["Palette", <Palette open commands={[]} onClose={() => {}} onRun={() => {}} />],
];

describe("user mode", () => {
  test.each(screens)("%s shows no internal vocabulary", (_name, el) => {
    expect(findInternalVocabulary(readable(render("user", el)))).toEqual([]);
  });

  test("the same screens in operator mode still show the internal terms (the fixture is not trivially clean)", () => {
    const all = screens.map(([, el]) => readable(render("operator", el))).join(" ");
    expect(findInternalVocabulary(all).length).toBeGreaterThan(0);
  });

  test("a failure in Needs you is the presented sentence and its action", () => {
    const grant = needsYouView(tasks[1]!, "user");
    expect(grant.line).toContain("`Bash(psql:*)`");
    expect(grant.action?.label).toBe("Allow and retry");
    expect(grant.outputHidden).toBe(true);
    const cap = needsYouView(tasks[2]!, "user");
    expect(cap.line).toContain("5 review rounds");
    const none = needsYouView(tasks[3]!, "user");
    expect(none.line).toContain("Nothing in billing can do this");
  });

  test("the agent's raw output is behind a control, not on the row", () => {
    const html = render("user", <BoardScreen lanes={lanes} loaded error={null} />);
    expect(html).toContain("Show the agent&#x27;s output");
    expect(html).not.toContain("The worktree needed psql.");
  });
});

describe("operator mode is unchanged", () => {
  test("needsYouView with no mode is the operator view", () => {
    for (const t of tasks) expect(needsYouView(t)).toEqual(needsYouView(t, "operator"));
    expect(needsYouView(tasks[1]!).line).toBe("Needs Bash(psql:*) to continue (round 2)");
    expect(needsYouView(tasks[1]!).outputHidden).toBeUndefined();
  });

  test("every screen renders the same with and without the provider", () => {
    for (const [, el] of screens) expect(render("operator", el)).toBe(renderToStaticMarkup(el));
  });

  test("statuses and chips keep their names", () => {
    expect(statusText("escalated", "operator")).toBe("escalated");
    expect(quickReplies([], "operator").map((r) => r.label)).toEqual(quickReplies([]).map((r) => r.label));
    expect(quickReplies([]).map((r) => r.label)).toContain("Show harnesses");
    expect(quickReplies([], "user").map((r) => r.label)).toContain("Show accounts");
  });
});
