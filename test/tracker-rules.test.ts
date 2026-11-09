import { expect, test } from "bun:test";
import type { TaskCard } from "../src/core/types.ts";
import type { Ticket, TicketProvider, TicketTransition } from "../src/services/ticket-provider.ts";
import { STAGE_ORDER, stageOfTicket, syncTicket, ticketStage, type TicketWrite, type TrackerCard } from "../src/services/tracker-rules.ts";

type Status = TaskCard["status"];
const card = (id: string, status: Status, pr?: { number: number; merged?: boolean }): TrackerCard => ({
  id,
  key: id,
  status,
  ...(pr ? { pr: { number: pr.number, url: `https://gh.example/pr/${pr.number}`, head: `h${pr.number}`, ...(pr.merged ? { lifecycle: "merged" as const } : {}) } } : {}),
});

const TRANSITIONS: TicketTransition[] = [
  { id: "11", name: "Start", to: "In Progress" },
  { id: "21", name: "Review", to: "In Review" },
  { id: "31", name: "Finish", to: "Done" },
];

function fakeProvider(ticket: Ticket | undefined, opts: { writeBack?: boolean; transitions?: TicketTransition[] } = {}) {
  const calls: string[] = [];
  const provider: TicketProvider = {
    id: "fake",
    writeBack: opts.writeBack ?? true,
    async lookup(keys) {
      calls.push(`lookup ${keys.join(",")}`);
      return ticket && keys.includes(ticket.key) ? { [ticket.key]: ticket } : {};
    },
    async transitions(key) {
      calls.push(`transitions ${key}`);
      if (!provider.writeBack) throw new Error("write-back is off");
      return opts.transitions ?? TRANSITIONS;
    },
    async comment(key, text) {
      calls.push(`comment ${key} ${text}`);
    },
    async transition(key, id) {
      calls.push(`transition ${key} ${id}`);
    },
  };
  return { provider, calls };
}

const ticket = (status: string, statusCategory?: string): Ticket => ({ key: "ABC-7", summary: "Checkout", status, ...(statusCategory ? { statusCategory } : {}), url: "https://t.example/browse/ABC-7" });

test("ticketStage: todo before the first card, in progress at the first started card", () => {
  expect(ticketStage([])).toBe("todo");
  expect(ticketStage([card("A1", "inbox"), card("A2", "ready")])).toBe("todo");
  expect(ticketStage([card("A1", "running"), card("A2", "inbox")])).toBe("in-progress");
  expect(ticketStage([card("A1", "done", { number: 1 }), card("A2", "inbox")])).toBe("in-progress");
});

test("ticketStage: in review once every card has a PR, done once the acceptance is merged", () => {
  const open = [card("A1", "done", { number: 1, merged: true }), card("A2", "done", { number: 2 })];
  expect(ticketStage(open)).toBe("in-review");
  expect(ticketStage(open.map((c) => ({ ...c, pr: { ...c.pr!, lifecycle: "merged" } })))).toBe("done");
  // Named acceptance: only those cards must be merged; another open PR keeps it at in-review.
  expect(ticketStage(open, ["A1"])).toBe("done");
  expect(ticketStage(open, ["A2"])).toBe("in-review");
  // The watcher's state counts as merged too; a failed card without a PR still blocks review.
  const watched: TrackerCard = { ...card("A1", "done", { number: 1 }), pr: { number: 1, url: "u", head: "h", watch: { sha: "h", checks: "passing", mergeable: "clean", state: "merged", at: "t" } } };
  expect(ticketStage([watched])).toBe("done");
  expect(ticketStage([watched, card("A2", "failed")])).toBe("in-progress");
});

test("stageOfTicket reads the tracker's status name first, then its category", () => {
  expect(stageOfTicket(ticket("To Do"))).toBe("todo");
  expect(stageOfTicket(ticket("In Progress"))).toBe("in-progress");
  expect(stageOfTicket(ticket("Code Review"))).toBe("in-review");
  expect(stageOfTicket(ticket("Closed"))).toBe("done");
  expect(stageOfTicket(ticket("Weird", "done"))).toBe("done");
  expect(stageOfTicket(ticket("Weird", "indeterminate"))).toBe("in-progress");
  expect(stageOfTicket(ticket("Weird"))).toBe("todo");
  expect(stageOfTicket(ticket("Reviewing"), { "in-review": ["Reviewing"] })).toBe("in-review");
  expect(STAGE_ORDER).toEqual(["todo", "in-progress", "in-review", "done"]);
});

test("syncTicket moves the ticket forward through the injected writer, with one comment naming the merged PRs", async () => {
  const { provider, calls } = fakeProvider(ticket("In Progress"));
  const writes: TicketWrite[] = [];
  const cards = [card("A1", "done", { number: 12, merged: true }), card("A2", "done", { number: 15, merged: true })];
  const res = await syncTicket({ ticket: "ABC-7", cards }, provider, async (w) => void writes.push(w));
  expect(res).toMatchObject({ ticket: "ABC-7", from: "in-progress", to: "done", written: true });
  expect(writes).toEqual([
    { kind: "ticket.transition", key: "ABC-7", transitionId: "31", to: "Done" },
    { kind: "ticket.comment", key: "ABC-7", text: "Wissel moved ABC-7 to Done.\nMerged PRs: A1 #12 https://gh.example/pr/12, A2 #15 https://gh.example/pr/15" },
  ]);
  // The writer is the only path: the provider itself saw reads only.
  expect(calls).toEqual(["lookup ABC-7", "transitions ABC-7"]);
});

test("syncTicket without a writer writes through the provider; an unmoved ticket writes nothing", async () => {
  const { provider, calls } = fakeProvider(ticket("To Do"));
  const res = await syncTicket({ ticket: "ABC-7", cards: [card("A1", "running")] }, provider);
  expect(res).toMatchObject({ from: "todo", to: "in-progress", written: true });
  expect(calls).toEqual(["lookup ABC-7", "transitions ABC-7", "transition ABC-7 11", "comment ABC-7 Wissel moved ABC-7 to In Progress.\nNo PRs merged yet."]);

  // Same cards, ticket already there: no second comment.
  const again = fakeProvider(ticket("In Progress"));
  const same = await syncTicket({ ticket: "ABC-7", cards: [card("A1", "running")] }, again.provider);
  expect(same).toMatchObject({ from: "in-progress", to: "in-progress", written: false, writes: [] });
  expect(again.calls).toEqual(["lookup ABC-7"]);
});

test("syncTicket never moves a ticket backwards, and leaves a ticket someone else closed alone", async () => {
  const { provider, calls } = fakeProvider(ticket("Done", "done"));
  const res = await syncTicket({ ticket: "ABC-7", cards: [card("A1", "running")] }, provider);
  expect(res).toMatchObject({ from: "done", to: "in-progress", written: false, writes: [] });
  expect(res.reason).toContain("ahead");
  expect(calls).toEqual(["lookup ABC-7"]);
});

test("with writeBack off nothing is written and the would-be move is returned", async () => {
  const { provider, calls } = fakeProvider(ticket("In Progress"), { writeBack: false });
  const writes: TicketWrite[] = [];
  const res = await syncTicket({ ticket: "ABC-7", cards: [card("A1", "done", { number: 3 })] }, provider, async (w) => void writes.push(w));
  expect(res).toMatchObject({ from: "in-progress", to: "in-review", written: false });
  expect(res.writes).toEqual([
    { kind: "ticket.transition", key: "ABC-7", to: "In Review" },
    { kind: "ticket.comment", key: "ABC-7", text: "Wissel moved ABC-7 to In Review.\nNo PRs merged yet." },
  ]);
  expect(writes).toEqual([]);
  expect(calls).toEqual(["lookup ABC-7"]);
});

test("syncTicket reports when there is no ticket, the tracker does not know it, or no transition reaches the stage", async () => {
  const none = await syncTicket({ cards: [card("A1", "running")] }, fakeProvider(undefined).provider);
  expect(none).toMatchObject({ to: "in-progress", written: false, writes: [] });
  expect(none.ticket).toBeUndefined();
  expect(none.reason).toContain("no ticket");

  const unknown = await syncTicket({ ticket: "ABC-7", cards: [card("A1", "running")] }, fakeProvider(undefined).provider);
  expect(unknown).toMatchObject({ ticket: "ABC-7", written: false, writes: [] });
  expect(unknown.reason).toContain("does not know");

  const noPath = fakeProvider(ticket("To Do"), { transitions: [{ id: "31", name: "Finish", to: "Done" }] });
  const res = await syncTicket({ ticket: "ABC-7", cards: [card("A1", "running")] }, noPath.provider);
  expect(res).toMatchObject({ from: "todo", to: "in-progress", written: false, writes: [] });
  expect(res.reason).toContain("no transition");
  expect(noPath.calls).toEqual(["lookup ABC-7", "transitions ABC-7"]);
});

test("a failed transition write is reported, and the comment is not sent", async () => {
  const { provider } = fakeProvider(ticket("To Do"));
  const res = await syncTicket({ ticket: "ABC-7", cards: [card("A1", "running")] }, provider, async (w) => {
    if (w.kind === "ticket.transition") throw new Error("tracker said no");
  });
  expect(res).toMatchObject({ from: "todo", to: "in-progress", written: false });
  expect(res.writes).toHaveLength(2);
  expect(res.reason).toContain("tracker said no");
});
