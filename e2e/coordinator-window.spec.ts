/// <reference lib="dom" />
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

// docs/SDD-coordinator.md §4.14: the coordinator window as an app screen
// (/app#/window/<id>) and as a dock beside the board. Every test makes
// its own workstream over the real API; nothing here touches another
// spec's cards.

const unique = (label: string) => `cw-${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function makeWorkstream(request: APIRequestContext, label: string, entry: Record<string, unknown> = { role: "follow" }): Promise<{ id: string; name: string; projectId: string }> {
  const dir = await mkdtemp(join(tmpdir(), "wissel-e2e-window-"));
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "pipe" });
  const project = (await (await request.post("/projects/local", { data: { path: dir, initGit: false } })).json()) as { id: string };
  const name = unique(label);
  const res = await request.post("/workstreams", { data: { name, projects: [{ projectId: project.id, ...entry }] } });
  expect(res.status()).toBe(201);
  const ws = (await res.json()) as { id: string };
  return { id: ws.id, name, projectId: project.id };
}

type AskRow = { id: string; status: string; resolvedBy?: string; via?: string; action: { kind: string; decision?: string } };
const asksWith = async (request: APIRequestContext, wsId: string, status: string) => (await (await request.get(`/workstreams/${wsId}/asks?status=${status}`)).json()) as AskRow[];
const wisselDecisions = async (request: APIRequestContext, wsId: string) => ((await (await request.get(`/workstreams/${wsId}/channel`)).json()) as { message: { kind: string; from: string } }[]).filter((e) => e.message.from === "wissel" && e.message.kind === "decision");

/** A decide-role project whose must-ask list names the decision kind "schema": the decider's decision on the channel
 *  becomes a decision post the gate asks the owner about (ask-owner, rule 5:must-ask), and nothing runs until the answer. */
async function raiseAsk(request: APIRequestContext, label: string, card: string) {
  const ws = await makeWorkstream(request, label, { role: "decide", decider: "Ana", mustAsk: ["schema"] });
  const posted = await request.post(`/workstreams/${ws.id}/channel`, { data: { kind: "decision", from: "Ana", about: { card }, decision: "schema", text: `one table for ${card}` } });
  expect(posted.status()).toBe(201);
  await expect.poll(async () => (await asksWith(request, ws.id, "open")).length, { timeout: 15_000 }).toBe(1);
  const ask = (await asksWith(request, ws.id, "open"))[0]!;
  expect(ask.action).toMatchObject({ kind: "channel.post", decision: "schema" });
  expect(await wisselDecisions(request, ws.id)).toHaveLength(0);
  return { ws, ask };
}

async function openWindow(page: Page, id: string) {
  await page.goto(`/app#/window/${id}`);
  await expect(page.getByRole("heading", { level: 1, name: /Coordinator window/ })).toBeVisible();
}

const tab = (page: Page, name: string) => page.getByRole("tab", { name });

test("tabs: the header, Conversation, Decisions and Log, with the channel entries in the log", async ({ page, request }) => {
  const ws = await makeWorkstream(request, "tabs");
  const posted = await request.post(`/workstreams/${ws.id}/channel`, { data: { kind: "status", from: "decider", about: { card: ws.id }, text: "hello from the channel" } });
  expect(posted.status()).toBe(201);
  await openWindow(page, ws.id);

  const header = page.getByRole("region", { name: "Window header" });
  await expect(header.getByText(ws.name)).toBeVisible();
  await expect(header.getByRole("combobox", { name: `Role for ${ws.projectId}` })).toHaveValue("follow");
  await expect(header).toContainText(/0 live/);
  await expect(header).toContainText("New cards start");
  await expect(header).toContainText("Channel written");
  await expect(header).toContainText("Quiet hours");
  await expect(header).toContainText("none");
  await expect(header).toContainText(/0 queued/);

  await expect(tab(page, "Conversation")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "Conversation" }).getByText("hello from the channel")).toBeVisible();
  await tab(page, "Decisions").click();
  await expect(page.getByRole("tabpanel", { name: "Decisions" }).getByText("No decisions recorded.")).toBeVisible();
  await tab(page, "Log").click();
  const log = page.getByRole("tabpanel", { name: "Log" });
  await expect(log.getByText("hello from the channel")).toBeVisible();
  await expect(log.getByText("decider", { exact: true })).toBeVisible();
  await expect(tab(page, "Conversation")).toHaveAttribute("aria-selected", "false");
});

test("Flip takes the alternative; a flipped decision offers no Flip", async ({ page, request }) => {
  const ws = await makeWorkstream(request, "flip");
  const made = await request.post(`/workstreams/${ws.id}/decisions`, { data: { text: "Use SQLite", alternative: "Use Postgres" } });
  expect(made.status()).toBe(201);
  const decision = (await made.json()) as { id: string };
  await openWindow(page, ws.id);

  const item = page.getByRole("tabpanel", { name: "Conversation" }).locator(`[data-decision-id="${decision.id}"]`);
  await expect(item.getByText("Use SQLite")).toBeVisible();
  await item.getByRole("button", { name: "Flip" }).click();
  await expect(item.getByText("Use Postgres")).toBeVisible();
  await expect(item.getByText("Flipped")).toBeVisible();
  await expect(item.getByRole("button", { name: "Flip" })).toHaveCount(0);
  const after = (await (await request.get(`/workstreams/${ws.id}/decisions`)).json()) as { id: string; status: string; text: string }[];
  expect(after.find((d) => d.id === decision.id)).toMatchObject({ status: "flipped", text: "Use Postgres" });

  await tab(page, "Decisions").click();
  await expect(page.getByRole("tabpanel", { name: "Decisions" }).getByText("Use Postgres")).toBeVisible();
});

test("owner task Done runs the check: a failing check keeps it open and shows the output; a passing one closes it", async ({ page, request }) => {
  const ws = await makeWorkstream(request, "task");
  const failing = (await (await request.post("/owner-tasks", { data: { title: unique("failing"), why: "the check exits 1", steps: ["step one", "step two"], check: ["sh", "-c", "echo gh: not logged in; exit 1"] } })).json()) as { id: string; title: string };
  const passing = (await (await request.post("/owner-tasks", { data: { title: unique("passing"), why: "the check exits 0", steps: [], check: ["true"] } })).json()) as { id: string; title: string };
  await openWindow(page, ws.id);

  const panel = page.getByRole("tabpanel", { name: "Conversation" });
  const bad = panel.locator(`[data-owner-task-id="${failing.id}"]`);
  await expect(bad.getByRole("checkbox", { name: "step one" })).toBeVisible();
  await bad.getByRole("button", { name: "Done" }).click();
  await expect(bad.getByRole("alert")).toContainText("the task stays open");
  await expect(bad.locator("pre")).toHaveText("gh: not logged in");
  await expect(bad.getByRole("button", { name: "Done" })).toBeVisible();
  expect(((await (await request.get("/owner-tasks")).json()) as { id: string; status: string }[]).find((t) => t.id === failing.id)!.status).toBe("open");

  const good = panel.locator(`[data-owner-task-id="${passing.id}"]`);
  await good.getByRole("button", { name: "Done" }).click();
  await expect(good).toHaveCount(0);
  await expect.poll(async () => ((await (await request.get("/owner-tasks")).json()) as { id: string; status: string }[]).find((t) => t.id === passing.id)!.status).toBe("done");
});

test("a role change shows the change and does nothing until Confirm", async ({ page, request }) => {
  const ws = await makeWorkstream(request, "role");
  await openWindow(page, ws.id);
  const header = page.getByRole("region", { name: "Window header" });
  await header.getByRole("combobox", { name: `Role for ${ws.projectId}` }).selectOption("decide");

  const change = page.getByRole("group", { name: "Confirm the role change" });
  await expect(change.getByText(`${ws.projectId}: follow to decide`)).toBeVisible();
  const role = async () => ((await (await request.get(`/workstreams/${ws.id}`)).json()) as { projects: { role: string }[] }).projects[0]!.role;
  expect(await role()).toBe("follow");

  await change.getByRole("button", { name: "Cancel" }).click();
  await expect(change).toHaveCount(0);
  expect(await role()).toBe("follow");
  await expect(header.getByRole("combobox", { name: `Role for ${ws.projectId}` })).toHaveValue("follow");

  await header.getByRole("combobox", { name: `Role for ${ws.projectId}` }).selectOption("decide");
  await page.getByRole("group", { name: "Confirm the role change" }).getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByRole("group", { name: "Confirm the role change" })).toHaveCount(0);
  await expect.poll(role).toBe("decide");
  await expect(header.getByRole("combobox", { name: `Role for ${ws.projectId}` })).toHaveValue("decide");
});

test("a policy quick action shows the change and waits for Confirm; the log toggle is on by default", async ({ page, request }) => {
  const ws = await makeWorkstream(request, "policy");
  await openWindow(page, ws.id);
  await expect(page.getByRole("checkbox", { name: "Log it on the channel" })).toBeChecked();
  await page.getByRole("button", { name: "Status now" }).click();
  const panel = page.getByRole("tabpanel", { name: "Conversation" });
  // The reply, and (log on) the same words as a status line on the channel.
  await expect(panel.locator(".msg-assistant").getByText(`Status now for ${ws.name}:`, { exact: false })).toBeVisible();
  await expect(panel.locator(".cw-status").getByText(`Status now for ${ws.name}:`, { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "Pause new cards" }).click();
  const confirm = panel.getByRole("group", { name: "Waiting for your Confirm" });
  await expect(confirm.getByText(`Pause new cards on ${ws.name}`)).toBeVisible();
  await expect(confirm.getByRole("button", { name: "Confirm" })).toBeVisible();
  await expect(panel.getByText(/Change: new cards stop starting/)).toBeVisible();
  // Not confirmed: still Confirm, nothing ran. (The pause is left unconfirmed so other specs keep dispatching.)
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm.getByText("Cancelled")).toBeVisible();
});

test("an ask: Approve shows the Change line and runs nothing; Confirm runs it once; the ask leaves the open list and lands in the Log", async ({ page, request }) => {
  const { ws, ask } = await raiseAsk(request, "approve", "A4");
  await openWindow(page, ws.id);
  const item = page.getByRole("tabpanel", { name: "Conversation" }).locator(`[data-ask-id="${ask.id}"]`);
  await expect(item).toContainText("wissel wants to post a decision (schema) on the channel about card A4");
  await expect(item).toContainText("rule 5:must-ask");
  await expect(item.getByText("The decider can also answer")).toHaveCount(0); // ask-owner: the owner alone answers

  await item.getByRole("button", { name: "Approve" }).click();
  const confirm = item.getByRole("group", { name: "Confirm the approval" });
  await expect(confirm.getByText(/^Change: wissel will post a decision \(schema\) on the channel about card A4.*\. Confirm\.$/)).toBeVisible();
  expect(await asksWith(request, ws.id, "open")).toHaveLength(1); // Approve alone ran nothing
  expect(await wisselDecisions(request, ws.id)).toHaveLength(0);
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(item.getByRole("button", { name: "Approve" })).toBeVisible();

  await item.getByRole("button", { name: "Approve" }).click();
  await item.getByRole("group", { name: "Confirm the approval" }).getByRole("button", { name: "Confirm" }).click();
  await expect(item).toHaveCount(0);
  await expect.poll(async () => (await asksWith(request, ws.id, "approved")).map((a) => [a.id, a.resolvedBy, a.via])).toEqual([[ask.id, "owner", "api"]]);
  expect(await asksWith(request, ws.id, "open")).toHaveLength(0);
  expect(await wisselDecisions(request, ws.id)).toHaveLength(1); // ran once

  await tab(page, "Log").click();
  const row = page.getByRole("tabpanel", { name: "Log" }).locator(`li[data-ask-id="${ask.id}"]`);
  await expect(row.getByText("owner", { exact: true })).toBeVisible();
  await expect(row.getByText("ask approved", { exact: true })).toBeVisible();
  await expect(row).toContainText("from the window; it ran once");
});

test("an ask: Reject runs nothing, the ask leaves the open list and the Log says who rejected it", async ({ page, request }) => {
  const { ws, ask } = await raiseAsk(request, "reject", "A5");
  await openWindow(page, ws.id);
  const item = page.getByRole("tabpanel", { name: "Conversation" }).locator(`[data-ask-id="${ask.id}"]`);
  await expect(item.getByRole("button", { name: "Approve" })).toBeVisible();
  await item.getByRole("button", { name: "Reject" }).click();
  await expect(item).toHaveCount(0);
  await expect.poll(async () => (await asksWith(request, ws.id, "rejected")).map((a) => [a.id, a.resolvedBy])).toEqual([[ask.id, "owner"]]);
  expect(await wisselDecisions(request, ws.id)).toHaveLength(0);

  await tab(page, "Log").click();
  const row = page.getByRole("tabpanel", { name: "Log" }).locator(`li[data-ask-id="${ask.id}"]`);
  await expect(row.getByText("ask rejected", { exact: true })).toBeVisible();
  await expect(row).toContainText("nothing ran");
  // The answer is final: a second answer over the API is a 409 in the server's words, which the window would show under the item.
  const again = await request.post(`/workstreams/${ws.id}/asks/${ask.id}/approve`);
  expect(again.status()).toBe(409);
  expect(((await again.json()) as { error: string }).error).toContain("already rejected");
});

test("the board docks the same window beside the lanes and follows the theme toggle", async ({ page, request }) => {
  const ws = await makeWorkstream(request, "dock");
  await page.goto("/board#/setup/settings");
  await page.locator('#themeToggle button[data-theme-choice="dark"]').click();
  await page.getByRole("link", { name: "Board", exact: true }).click();
  await page.getByRole("button", { name: "Coordinator" }).click();
  const dock = page.locator("#coordDock");
  await expect(dock).toBeVisible();
  await dock.getByRole("combobox", { name: "Workstream" }).selectOption({ label: ws.name });
  const frame = page.frameLocator("#coordFrame");
  await expect(frame.getByRole("heading", { level: 1, name: /Coordinator window/ })).toBeVisible();
  await expect(frame.getByRole("region", { name: "Window header" }).getByText(ws.name)).toBeVisible();
  await expect(frame.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(frame.getByRole("navigation", { name: "Screens" })).toHaveCount(0);
  await dock.getByRole("button", { name: "Close coordinator window" }).click();
  await expect(dock).toBeHidden();
});

test("the picker creates a workstream from a form and opens its window", async ({ page, request }) => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-e2e-window-new-"));
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "pipe" });
  const project = (await (await request.post("/projects/local", { data: { path: dir, initGit: false } })).json()) as { id: string; name: string };
  const name = unique("form");
  await page.goto("/app#/window");
  const form = page.getByRole("form", { name: "New workstream" });
  await expect(form).toBeVisible();
  await expect(form.getByRole("button", { name: "Create workstream" })).toBeDisabled(); // no name yet
  await form.getByLabel("Name").fill(name);
  await form.getByRole("checkbox", { name: project.name }).check();
  await expect(form.getByLabel(`Role in ${project.name}`)).toHaveValue("shadow"); // the safe default
  await form.getByRole("button", { name: "Create workstream" }).click();
  await expect(page.getByRole("heading", { level: 1, name: new RegExp(`Coordinator window: ${name}`) })).toBeVisible();
  const list = (await (await request.get("/workstreams")).json()) as { name: string; projects: { projectId: string; role: string }[] }[];
  expect(list.find((w) => w.name === name)?.projects).toEqual([{ projectId: project.id, role: "shadow", decideAlone: [], mustAsk: [], never: [] }]);
});
