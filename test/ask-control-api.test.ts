import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type CreateAppOptions } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { TelemetryLog } from "../src/services/telemetry.ts";
import { Registry } from "../src/core/registry.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { ReadOnlyExecutor } from "../src/executors/readonly.ts";
import type { CommandRunner } from "../src/executors/claude-cli.ts";
import type { Executor, TaskCard } from "../src/core/types.ts";
import type { ChatMessage, Conversation, ControlExecuted, PendingView } from "../src/services/conversations.ts";

// docs/SDD-wissel-app.md §3.7, through the real routes: POST /ask with a
// scripted concierge, then POST /ask/actions/:id/confirm|cancel. Tier A
// runs at once, Tier B waits for the tap, a "yes" never confirms, and
// every pending action is used once, in time, in its own chat.

const home = await mkdtemp(join(tmpdir(), "wissel-ask-control-test-"));
afterAll(() => rm(home, { recursive: true, force: true }));

const block = (reply: string, actions: unknown[] = []) => "```wissel-actions\n" + JSON.stringify({ reply, actions }) + "\n```";

interface AskBody {
  conversation: Conversation;
  user: ChatMessage;
  assistant: ChatMessage;
}
interface PendingBody {
  pending: PendingView;
  message: ChatMessage;
}

/** A fake `claude -p` answering each call with the next scripted reply. */
function scripted(answers: string[]): CommandRunner {
  return async () => {
    const next = answers.shift();
    if (next === undefined) throw new Error("concierge called more times than scripted");
    return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: next, total_cost_usd: 0.01 }), stderr: "", exitCode: 0 };
  };
}

/** Run now lands here, so nothing real runs. Agents with no harness list
 *  only: startup refuses a pool that would run a harness-bound agent
 *  (the concierge, say) with no harness tool. */
const fakeRunNow: Executor = { id: "test-run-now", canHandle: (agent) => !agent.harnesses?.length, run: async (task, agent) => ({ taskId: task.id, agentId: agent.id, ok: true, summary: "ok" }) };

async function setup(answers: string[], opts: CreateAppOptions = {}) {
  const board = new SqliteBoard();
  const telemetryPath = join(home, `telemetry-${Math.random()}.jsonl`);
  const app = createApp(board, await Registry.load(), new TelemetryLog(telemetryPath), {
    conciergeExecutor: new ReadOnlyExecutor({ runner: scripted(answers) }),
    conciergeHarnesses: HarnessPool.from([{ id: "claude", tool: "claude-cli", label: "Claude", enabled: true }]),
    conciergeHomeDir: home,
    manualExecutors: [fakeRunNow],
    harnesses: HarnessPool.from([{ id: "codex", tool: "codex-cli", label: "Codex", enabled: true }]),
    harnessesPath: join(home, `harnesses-${Math.random()}.yaml`),
    ...opts,
  });
  const post = async <T>(path: string, body: unknown): Promise<{ status: number; body: T }> => {
    const res = await app(new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  };
  const ask = async (text: string, conversationId?: string) => (await post<AskBody>("/ask", { text, ...(conversationId ? { conversationId } : {}) })).body;
  const telemetry = async () =>
    (await readFile(telemetryPath, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { type: string; [k: string]: unknown })
      .filter((e) => e.type === "ask.action");
  const make = async (title: string, status: TaskCard["status"] = "inbox", labels = ["docs"]) => {
    const t = await board.create({ title, body: "", labels });
    return status === "inbox" ? t : board.move(t.id, status);
  };
  return { board, app, post, ask, telemetry, make };
}

const controls = (m: ChatMessage) => m.actions.filter((a): a is ControlExecuted => "control" in a);
const id8 = (t: TaskCard) => t.id.slice(0, 8);

describe("Tier A runs at once", () => {
  test("retry by title: the board's Run now runs it, the reply says so in plain words, telemetry has it", async () => {
    const s = await setup([block("Retrying it.", [{ type: "retry_task", card: "Feed and Stories" }])]);
    const feed = await s.make("Feed and Stories", "failed");
    const body = await s.ask("retry the Feed and Stories card");
    expect(controls(body.assistant)).toEqual([
      { type: "retry_task", control: true, ok: true, tier: "A", confirmedBy: "tier-a", target: { kind: "card", id: feed.id, label: "Feed and Stories" }, text: `Retried 'Feed and Stories' (card ${id8(feed)}).` },
    ]);
    expect(body.assistant.text).toBe(`Retrying it.\n\nRetried 'Feed and Stories' (card ${id8(feed)}).`);
    expect(body.assistant.pending).toBeUndefined();
    // Run now went through the orchestrator: the card was routed again.
    await Bun.sleep(20);
    expect(await s.board.getDecision(feed.id)).toBeDefined();
    expect(await s.telemetry()).toMatchObject([{ type: "ask.action", actionType: "retry_task", tier: "A", target: { kind: "card", id: feed.id }, ok: true, confirmedBy: "tier-a", messageId: body.assistant.id }]);
  });

  test("archive gets an Undo; the Undo tap unarchives the whole cascade, once", async () => {
    const s = await setup([block("Archiving.", [{ type: "archive_task", card: "Old podcast" }])]);
    const old = await s.make("Old podcast", "done");
    const child = await s.board.create({ title: "Old podcast step", body: "", labels: ["docs"], parentTaskId: old.id });
    const body = await s.ask("archive the old podcast");
    const [archived] = controls(body.assistant);
    // Read before any asymmetric matcher touches the object.
    const undoId = archived!.undoId!;
    expect(typeof undoId).toBe("string");
    expect([archived!.type, archived!.ok]).toEqual(["archive_task", true]);
    expect((await s.board.get(child.id))!.archivedAt).toBeDefined();
    const [view] = body.assistant.pending!;
    expect([view!.id, view!.kind, view!.state, view!.lines]).toEqual([undoId, "undo", "open", [`Unarchive 'Old podcast' (card ${id8(old)})`, `Unarchive 'Old podcast step' (card ${id8(child)})`]]);

    const undo = await s.post<PendingBody>(`/ask/actions/${undoId}/confirm`, { conversationId: body.conversation.id });
    expect(undo.status).toBe(200);
    expect(undo.body.pending.state).toBe("confirmed");
    expect((await s.board.get(old.id))!.archivedAt).toBeUndefined();
    expect((await s.board.get(child.id))!.archivedAt).toBeUndefined();
    expect(controls(undo.body.message).map((a) => [a.type, a.confirmedBy, a.ok])).toEqual([
      ["archive_task", "tier-a", true],
      ["unarchive_task", "undo", true],
      ["unarchive_task", "undo", true],
    ]);
    // No Undo of the Undo, and the chip can't be used twice.
    expect(controls(undo.body.message).filter((a) => a.type === "unarchive_task").every((a) => a.undoId === undefined)).toBe(true);
    expect((await s.post(`/ask/actions/${undoId}/confirm`, { conversationId: body.conversation.id })).status).toBe(409);
  });

  test("move and harness disable get an Undo that puts things back", async () => {
    const s = await setup([
      block("Moved.", [{ type: "move_task", card: "Listen", status: "ready" }]),
      block("Off.", [{ type: "set_harness_enabled", harness: "codex", enabled: false }]),
    ]);
    const listen = await s.make("Listen");
    const moved = await s.ask("move Listen to ready");
    expect((await s.board.get(listen.id))!.status).toBe("ready");
    await s.post(`/ask/actions/${controls(moved.assistant)[0]!.undoId}/confirm`, { conversationId: moved.conversation.id });
    expect((await s.board.get(listen.id))!.status).toBe("inbox");

    const off = await s.ask("disable codex", moved.conversation.id);
    const harnesses = async () => (await (await s.app(new Request("http://localhost/harnesses"))).json()) as { id: string; enabled: boolean }[];
    expect((await harnesses()).find((h) => h.id === "codex")!.enabled).toBe(false);
    // Undo re-enables through the endpoint's own auth re-check.
    const undo = await s.post<PendingBody>(`/ask/actions/${controls(off.assistant)[0]!.undoId}/confirm`, { conversationId: off.conversation.id });
    expect(undo.status).toBe(200);
    expect(controls(undo.body.message).at(-1)).toMatchObject({ type: "set_harness_enabled", confirmedBy: "undo" });
  });
});

describe("Tier B waits for the Confirm tap", () => {
  test("delete: pending, nothing happens; the Confirm tap deletes it and is logged as confirmed", async () => {
    const s = await setup([block("Tap Confirm to delete it.", [{ type: "delete_task", card: "Flaky" }])]);
    const flaky = await s.make("Flaky", "failed");
    const body = await s.ask("delete the flaky card");
    expect(controls(body.assistant)).toEqual([]);
    expect(body.assistant.text).toBe(`Tap Confirm to delete it.\n\nWaiting for your Confirm:\n- Delete 'Flaky' (card ${id8(flaky)})`);
    const [p] = body.assistant.pending!;
    expect(p).toMatchObject({ kind: "confirm", state: "open", lines: [`Delete 'Flaky' (card ${id8(flaky)})`] });
    expect(await s.board.get(flaky.id)).toBeDefined();
    expect(await s.telemetry()).toEqual([]);

    // Another chat can't confirm it.
    expect((await s.post(`/ask/actions/${p!.id}/confirm`, { conversationId: "someone-else" })).status).toBe(409);
    expect(await s.board.get(flaky.id)).toBeDefined();

    const ok = await s.post<PendingBody>(`/ask/actions/${p!.id}/confirm`, { conversationId: body.conversation.id });
    expect(ok.status).toBe(200);
    expect(await s.board.get(flaky.id)).toBeUndefined();
    expect(controls(ok.body.message)).toMatchObject([{ type: "delete_task", ok: true, tier: "B", confirmedBy: "confirm", text: `Deleted 'Flaky' (card ${id8(flaky)}).` }]);
    expect(await s.telemetry()).toMatchObject([{ actionType: "delete_task", tier: "B", confirmedBy: "confirm", ok: true }]);

    // The stored chat has it too, and the pending card reads confirmed.
    const chat = (await (await s.app(new Request(`http://localhost/conversations/${body.conversation.id}`))).json()) as { messages: ChatMessage[] };
    expect(chat.messages[1]!.pending![0]!.state).toBe("confirmed");
    expect(controls(chat.messages[1]!)).toHaveLength(1);

    // Twice is refused.
    expect((await s.post(`/ask/actions/${p!.id}/confirm`, { conversationId: body.conversation.id })).status).toBe(409);
  });

  test("Cancel does nothing and closes it", async () => {
    const s = await setup([block("Tap Confirm.", [{ type: "delete_task", card: "Flaky" }])]);
    const flaky = await s.make("Flaky");
    const body = await s.ask("delete flaky");
    const id = body.assistant.pending![0]!.id;
    const cancelled = await s.post<PendingBody>(`/ask/actions/${id}/cancel`, { conversationId: body.conversation.id });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.pending.state).toBe("cancelled");
    expect(controls(cancelled.body.message)).toEqual([]);
    expect((await s.post(`/ask/actions/${id}/confirm`, { conversationId: body.conversation.id })).status).toBe(409);
    expect(await s.board.get(flaky.id)).toBeDefined();
  });

  test("an expired pending action fails closed and reads expired", async () => {
    const s = await setup([block("Tap Confirm.", [{ type: "delete_task", card: "Flaky" }])]);
    const flaky = await s.make("Flaky");
    const body = await s.ask("delete flaky");
    const id = body.assistant.pending![0]!.id;
    s.board.db.run("UPDATE ask_pending_actions SET expiresAt = ? WHERE id = ?", [new Date(Date.now() - 1000).toISOString(), id]);
    const res = await s.post<{ error: string }>(`/ask/actions/${id}/confirm`, { conversationId: body.conversation.id });
    expect(res).toEqual({ status: 409, body: { error: "that action expired; ask again" } });
    expect(await s.board.get(flaky.id)).toBeDefined();
    const chat = (await (await s.app(new Request(`http://localhost/conversations/${body.conversation.id}`))).json()) as { messages: ChatMessage[] };
    expect(chat.messages[1]!.pending![0]!.state).toBe("expired");
  });

  test("'yes, go ahead' in a message never confirms", async () => {
    const s = await setup([block("Tap Confirm.", [{ type: "delete_task", card: "Flaky" }]), block("Done, deleted it!", [{ type: "confirm", id: "anything" }])]);
    const flaky = await s.make("Flaky");
    const first = await s.ask("delete flaky");
    const second = await s.ask("yes, go ahead", first.conversation.id);
    expect(controls(second.assistant)).toEqual([]);
    expect(second.assistant.dropped).toMatchObject([{ type: "confirm", disallowed: true }]);
    expect(await s.board.get(flaky.id)).toBeDefined();
    const chat = (await (await s.app(new Request(`http://localhost/conversations/${first.conversation.id}`))).json()) as { messages: ChatMessage[] };
    expect(chat.messages[1]!.pending![0]!.state).toBe("open");
  });

  test("at Confirm the action is rechecked on the board as it is now", async () => {
    const s = await setup([block("Tap Confirm.", [{ type: "delete_task", card: "Flaky" }])]);
    const flaky = await s.make("Flaky");
    const body = await s.ask("delete flaky");
    await s.board.move(flaky.id, "running");
    const res = await s.post<PendingBody>(`/ask/actions/${body.assistant.pending![0]!.id}/confirm`, { conversationId: body.conversation.id });
    expect(res.status).toBe(200);
    expect(controls(res.body.message)).toMatchObject([{ type: "delete_task", ok: false, error: "it is running; stop it first", confirmedBy: "confirm" }]);
    expect(await s.board.get(flaky.id)).toBeDefined();
  });

  test("a batch over three cards waits for a Confirm even though archive is Tier A", async () => {
    const s = await setup([block("Tap Confirm.", [{ type: "archive_task", where: { status: "done" } }])]);
    const done = await Promise.all(["A", "B", "C", "D"].map((t) => s.make(`Done ${t}`, "done")));
    const body = await s.ask("archive every done card");
    expect(controls(body.assistant)).toEqual([]);
    expect(body.assistant.pending![0]!.lines).toHaveLength(4);
    for (const t of done) expect((await s.board.get(t.id))!.archivedAt).toBeUndefined();
    const res = await s.post<PendingBody>(`/ask/actions/${body.assistant.pending![0]!.id}/confirm`, { conversationId: body.conversation.id });
    expect(controls(res.body.message).map((a) => a.ok)).toEqual([true, true, true, true]);
    for (const t of done) expect((await s.board.get(t.id))!.archivedAt).toBeDefined();
    // A confirmed archive can be undone too.
    expect(res.body.message.pending!.map((p) => p.kind)).toEqual(["confirm", "undo"]);
  });
});

describe("targets and refusals", () => {
  test("an ambiguous card is a question in the reply, never an action", async () => {
    const s = await setup([block("On it.", [{ type: "archive_task", card: "README" }])]);
    const a = await s.make("Update the README badges");
    const b = await s.make("Update the README install steps");
    const body = await s.ask("archive the README card");
    expect(controls(body.assistant)).toEqual([]);
    expect(body.assistant.pending).toBeUndefined();
    expect(body.assistant.text).toBe(`On it.\n\nWhich card should I archive: 'Update the README badges' (card ${id8(a)}) or 'Update the README install steps' (card ${id8(b)})?`);
    expect((await s.board.list()).every((t) => !t.archivedAt)).toBe(true);
  });

  test("a never-from-chat request is refused with the reason", async () => {
    const s = await setup([block("That is done by hand.", [{ type: "set_api_key", harness: "claude", key: "sk" }])]);
    const body = await s.ask("change my API key");
    expect(body.assistant.dropped).toEqual([{ type: "set_api_key", reason: "secrets, accounts and credentials never change from chat; do it by hand", disallowed: true, never: true }]);
    expect(body.assistant.text).toContain("- set api key: secrets, accounts and credentials never change from chat; do it by hand");
  });

  test("the confirm route: 404 for an unknown id, 400 without a conversationId or a JSON body", async () => {
    const s = await setup([]);
    expect((await s.post("/ask/actions/nope/confirm", { conversationId: "c" })).status).toBe(404);
    expect((await s.post("/ask/actions/nope/confirm", {})).status).toBe(400);
    const res = await s.app(new Request("http://localhost/ask/actions/nope/cancel", { method: "POST", body: "not json" }));
    expect(res.status).toBe(400);
  });
});

describe("live events", () => {
  test("ask.action and ask.pending go out as named ask events; /board's plain messages don't carry them", async () => {
    const s = await setup([block("Ok.", [{ type: "archive_task", card: "Old" }, { type: "delete_task", card: "Flaky" }])]);
    await s.make("Old", "done");
    await s.make("Flaky");
    const res = await s.app(new Request("http://localhost/events"));
    const reader = res.body!.getReader();
    const body = await s.ask("archive old, delete flaky");
    let text = "";
    const deadline = Date.now() + 2000;
    while (!text.includes('"ask.replied"') && Date.now() < deadline) {
      const { value } = await reader.read();
      text += new TextDecoder().decode(value);
    }
    await reader.cancel();
    expect(text).toContain(`event: ask\ndata: {"type":"ask.action","conversationId":"${body.conversation.id}","messageId":"${body.assistant.id}"}`);
    expect(text).toContain(`event: ask\ndata: {"type":"ask.pending","conversationId":"${body.conversation.id}","messageId":"${body.assistant.id}","pendingId":"${body.assistant.pending!.find((p) => p.kind === "confirm")!.id}"}`);
    for (const line of text.split("\n\n").filter((b) => b.startsWith("data:"))) expect(line).not.toContain('"ask.');
  });
});
