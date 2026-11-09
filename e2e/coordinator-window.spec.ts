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

test("the window updates by itself: a channel entry posted through the API shows up with no click or reload", async ({ page, request }) => {
  const ws = await makeWorkstream(request, "live");
  await openWindow(page, ws.id);
  const panel = page.getByRole("tabpanel", { name: "Conversation" });
  await expect(panel.getByText("arrived while open")).toHaveCount(0);
  const posted = await request.post(`/workstreams/${ws.id}/channel`, { data: { kind: "status", from: "decider", about: { card: ws.id }, text: "arrived while open" } });
  expect(posted.status()).toBe(201);
  await expect(panel.getByText("arrived while open")).toBeVisible({ timeout: 8000 }); // the window looks again every few seconds
  await expect(page.locator(".cw-live")).toContainText("live");
});

test("the window's own buttons are never covered, on a short screen", async ({ page, request }) => {
  const ws = await makeWorkstream(request, "covered");
  await page.setViewportSize({ width: 390, height: 640 });
  await openWindow(page, ws.id);
  for (const name of ["Conversation", "Decisions", "Log", "Status now", "Restart when idle", "Send"]) {
    const el = page.getByRole(name === "Conversation" || name === "Decisions" || name === "Log" ? "tab" : "button", { name }).first();
    await el.scrollIntoViewIfNeeded();
    const top = await el.evaluate((node) => {
      const r = node.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return hit === node || node.contains(hit);
    });
    expect(top, `${name} is covered`).toBe(true);
  }
});

test("the dock starts at the cards and leaves the whole top menu visible and clickable", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/board");
  await page.locator("#coordBtn").click();
  await expect(page.locator("#coordDock")).toBeVisible();
  const geo = await page.evaluate(() => {
    const dock = document.getElementById("coordDock")!.getBoundingClientRect();
    const lanes = document.getElementById("lanesPanel")!.getBoundingClientRect();
    const bar = document.querySelector(".topbar")!.getBoundingClientRect();
    const links = Array.from(document.querySelectorAll(".topbar a")).filter((a) => (a as HTMLElement).offsetParent !== null).map((a) => {
      const r = a.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { text: (a.textContent ?? "").trim(), reachable: hit === a || a.contains(hit) };
    });
    return { dockTop: dock.top, lanesTop: lanes.top, barBottom: bar.bottom, barRight: bar.right, links };
  });
  expect(Math.abs(geo.dockTop - geo.lanesTop)).toBeLessThanOrEqual(2); // aligned with the cards
  expect(geo.dockTop).toBeGreaterThanOrEqual(geo.barBottom - 1); // below the menu, never over it
  expect(geo.links.length).toBeGreaterThan(3);
  expect(geo.links.filter((l) => !l.reachable), "a top-menu link is covered").toEqual([]);
});

// docs/SDD-coordinator-dock.md R1-R3, checks 1 and 2: the lanes area gives
// up width to the dock instead of being covered by it.
const BOARD_LANE_IDS = ["queued", "working", "in-review", "next-step", "done"];

/** Where the dock and the lanes area sit, and for each lane whether the
 *  point at the centre of its header reaches that header (nothing over
 *  it). With scrollTo, each header is first scrolled into view, which
 *  only the lanes area's own box may do. */
async function dockGeometry(page: Page, scrollTo: boolean) {
  return page.evaluate(({ lanes, scrollTo }) => {
    const dock = document.getElementById("coordDock")!.getBoundingClientRect();
    const area = document.getElementById("lanesPanel")!.getBoundingClientRect();
    const kanban = document.getElementById("kanbanBody")!;
    const headers = lanes.map((lane) => {
      const h = document.querySelector(`.kcol[data-lane="${lane}"] h3`) as HTMLElement | null;
      if (!h) return { lane, hit: false, right: NaN };
      if (scrollTo) h.scrollIntoView({ block: "nearest", inline: "nearest" });
      const r = h.getBoundingClientRect();
      const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { lane, hit: el === h || h.contains(el), right: r.right };
    });
    return {
      dockLeft: dock.left, dockWidth: dock.width, lanesRight: area.right, headers,
      lanesScroll: kanban.scrollWidth > kanban.clientWidth,
      pageScrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth,
    };
  }, { lanes: BOARD_LANE_IDS, scrollTo });
}

async function openDockOnBoard(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.goto("/board");
  await expect(page.locator('.kcol[data-lane="done"] h3')).toBeVisible();
  await page.locator("#coordBtn").click();
  await expect(page.locator("#coordDock")).toBeVisible();
}

test("at 1280 x 800 the five lanes sit beside the 380 px dock, none under it, no scrolling needed", async ({ page }) => {
  await openDockOnBoard(page, 1280, 800);
  const geo = await dockGeometry(page, false);
  expect(Math.round(geo.dockWidth)).toBe(380);
  expect(geo.dockLeft).toBeGreaterThanOrEqual(geo.lanesRight - 0.5); // the lanes area ends where the dock starts
  expect(geo.headers.filter((h) => !h.hit).map((h) => h.lane), "a lane header is covered").toEqual([]);
  expect(geo.headers.filter((h) => h.right > geo.dockLeft + 0.5).map((h) => h.lane), "a lane header runs under the dock").toEqual([]);
  expect(geo.lanesScroll, "the lanes area scrolls at 1280").toBe(false);
  expect(geo.pageScrollWidth).toBeLessThanOrEqual(geo.innerWidth);
});

test("at 1024 x 768 the lanes area scrolls inside its own box; the page does not, and the dock covers none of it", async ({ page }) => {
  await openDockOnBoard(page, 1024, 768);
  const geo = await dockGeometry(page, true);
  expect(geo.dockLeft).toBeGreaterThanOrEqual(geo.lanesRight - 0.5);
  expect(geo.headers.filter((h) => !h.hit).map((h) => h.lane), "a lane header is covered").toEqual([]);
  expect(geo.headers.filter((h) => h.right > geo.dockLeft + 0.5).map((h) => h.lane), "a lane header runs under the dock").toEqual([]);
  expect(geo.pageScrollWidth).toBeLessThanOrEqual(geo.innerWidth); // the page itself never scrolls sideways
  // Each lane keeps at least 160px: five of them do not fit in what 1024 leaves, so the lanes area is the one that scrolls.
  expect(geo.lanesScroll).toBe(true);
});

// docs/SDD-coordinator-dock.md R4, check 3: the handle on the dock's left
// edge resizes it between 320 and 560 px, by pointer and by keyboard, and
// the width is kept in localStorage.
const resizeHandle = (page: Page) => page.getByRole("separator", { name: "Resize coordinator window" });
const dockWidth = (page: Page) => page.locator("#coordDock").evaluate((el) => Math.round(el.getBoundingClientRect().width));

/** Drags the handle by dx (negative: left, so the dock grows). */
async function dragHandle(page: Page, dx: number) {
  const box = (await resizeHandle(page).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y);
  await page.mouse.move(x + dx, y);
  await page.mouse.up();
}

test("dragging the handle 100 px left widens the dock by 100 px; the width survives a reload; arrow keys step 16 px, Home and End hit the limits", async ({ page }) => {
  await openDockOnBoard(page, 1280, 800);
  const handle = resizeHandle(page);
  await expect(handle).toHaveAttribute("aria-valuemin", "320");
  await expect(handle).toHaveAttribute("aria-valuemax", "560");
  await expect(handle).toHaveAttribute("aria-valuenow", "380");
  expect(await dockWidth(page)).toBe(380);

  await dragHandle(page, -100);
  expect(await dockWidth(page)).toBe(480);
  await expect(handle).toHaveAttribute("aria-valuenow", "480");
  const geo = await dockGeometry(page, false);
  expect(geo.dockLeft).toBeGreaterThanOrEqual(geo.lanesRight - 0.5); // the lanes area gave up the 100px
  expect(geo.pageScrollWidth).toBeLessThanOrEqual(geo.innerWidth);

  await page.reload();
  await expect(page.locator('.kcol[data-lane="done"] h3')).toBeVisible();
  await page.locator("#coordBtn").click();
  await expect(page.locator("#coordDock")).toBeVisible();
  expect(await dockWidth(page)).toBe(480); // restored from localStorage
  await expect(handle).toHaveAttribute("aria-valuenow", "480");

  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  expect(await dockWidth(page)).toBe(496);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  expect(await dockWidth(page)).toBe(464);
  await expect(handle).toHaveAttribute("aria-valuenow", "464");
  await page.keyboard.press("End");
  expect(await dockWidth(page)).toBe(560);
  await page.keyboard.press("ArrowLeft"); // already at the limit: stays
  expect(await dockWidth(page)).toBe(560);
  await page.keyboard.press("Home");
  expect(await dockWidth(page)).toBe(320);
  await expect(handle).toHaveAttribute("aria-valuenow", "320");

  await dragHandle(page, -400); // past the limit: clamps
  expect(await dockWidth(page)).toBe(560);
  await dragHandle(page, 400);
  expect(await dockWidth(page)).toBe(320);
  expect(await page.evaluate(() => localStorage.getItem("wissel-coord-width"))).toBe("320");
});

test("with storage blocked the dock still opens at 380 px and the handle still resizes it", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new Error("storage blocked"); } });
  });
  await openDockOnBoard(page, 1280, 800);
  expect(await dockWidth(page)).toBe(380);
  await resizeHandle(page).focus();
  await page.keyboard.press("ArrowLeft");
  expect(await dockWidth(page)).toBe(396);
  await dragHandle(page, -50);
  expect(await dockWidth(page)).toBe(446);
});

// docs/SDD-coordinator-dock.md R5, check 4: the header's collapse button
// folds the dock to a 44 px rail (a vertical "Coordinator" and the count
// of cards that need the owner); the rail or the button expands it back to
// the saved width, and the collapsed state is kept in localStorage.
const lanesWidth = (page: Page) => page.locator("#lanesPanel").evaluate((el) => Math.round(el.getBoundingClientRect().width));
const collapseBtn = (page: Page) => page.locator("#coordCollapse");
const rail = (page: Page) => page.locator("#coordRail");

/** A card whose result nobody has checked: review is the owner's queue, so it sits in Needs a human. */
async function makeReviewCard(request: APIRequestContext, label: string) {
  const created = await request.post("/tasks", { data: { title: unique(label), body: "x", labels: [], repo: "/tmp/wissel-e2e-repo" } });
  const task = (await created.json()) as { id: string };
  const result = await request.post(`/tasks/${task.id}/result`, { data: { agentId: "fixer", ok: true, summary: "opened a PR" } });
  expect(result.ok()).toBe(true);
  return task;
}

test("collapse folds the dock to a 44 px rail with the needs-owner count and gives the lanes 300 px more; expand restores the saved width; the state survives a reload", async ({ page, request }) => {
  const card = await makeReviewCard(request, "rail");
  await openDockOnBoard(page, 1280, 800);
  await expect(page.locator(`#needsYou .kcard[data-task-id="${card.id}"]`)).toBeVisible();
  const needing = await page.locator("#needsYouBody .kcard").count();
  expect(needing).toBeGreaterThanOrEqual(1);
  expect(await dockWidth(page)).toBe(380);
  const open = await lanesWidth(page);
  await expect(collapseBtn(page)).toHaveAttribute("aria-expanded", "true");
  await expect(rail(page)).toBeHidden();

  await collapseBtn(page).click();
  expect(await dockWidth(page)).toBe(44);
  expect(await lanesWidth(page)).toBeGreaterThanOrEqual(open + 300); // the lanes area uses the freed width
  await expect(collapseBtn(page)).toHaveAttribute("aria-expanded", "false");
  await expect(rail(page)).toBeVisible();
  await expect(rail(page).locator(".coord-rail-label")).toHaveText("Coordinator");
  expect(await rail(page).locator(".coord-rail-label").evaluate((el) => getComputedStyle(el).writingMode)).toMatch(/^vertical/);
  await expect(rail(page).locator("#coordRailCount")).toHaveText(String(needing));
  await expect(page.locator("#coordWorkstream")).toBeHidden();
  await expect(page.locator("#coordFrame")).toBeHidden();
  await expect(resizeHandle(page)).toBeHidden();
  const folded = await dockGeometry(page, false);
  expect(folded.dockLeft).toBeGreaterThanOrEqual(folded.lanesRight - 0.5);
  expect(folded.headers.filter((h) => !h.hit).map((h) => h.lane), "a lane header is covered").toEqual([]);
  expect(folded.pageScrollWidth).toBeLessThanOrEqual(folded.innerWidth);
  expect(await page.evaluate(() => localStorage.getItem("wissel-coord-collapsed"))).toBe("1");

  await rail(page).click(); // the rail expands it
  expect(await dockWidth(page)).toBe(380);
  expect(await lanesWidth(page)).toBe(open);
  await expect(rail(page)).toBeHidden();
  await expect(page.locator("#coordFrame")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("wissel-coord-collapsed"))).toBeNull();

  await dragHandle(page, -60); // a chosen width, then collapse: the rail is still 44 and the width is kept for the expand
  expect(await dockWidth(page)).toBe(440);
  await collapseBtn(page).click();
  expect(await dockWidth(page)).toBe(44);
  await page.reload();
  await expect(page.locator('.kcol[data-lane="done"] h3')).toBeVisible();
  await page.locator("#coordBtn").click();
  await expect(page.locator("#coordDock")).toBeVisible();
  expect(await dockWidth(page)).toBe(44); // still collapsed after the reload
  await expect(rail(page)).toBeVisible();
  await collapseBtn(page).click(); // the same button expands it
  expect(await dockWidth(page)).toBe(440); // the saved width, not the default
  await expect(collapseBtn(page)).toHaveAttribute("aria-expanded", "true");
  await expect(resizeHandle(page)).toHaveAttribute("aria-valuenow", "440");
});

test("with storage blocked collapse and expand still work", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new Error("storage blocked"); } });
  });
  await openDockOnBoard(page, 1280, 800);
  await collapseBtn(page).click();
  expect(await dockWidth(page)).toBe(44);
  await rail(page).click();
  expect(await dockWidth(page)).toBe(380);
});

test("+ New has a Coordinator tab that creates a workstream and docks its window", async ({ page, request }) => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-e2e-new-coord-"));
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "pipe" });
  const project = (await (await request.post("/projects/local", { data: { path: dir, initGit: false } })).json()) as { id: string; name: string };
  const name = unique("newtab");
  await page.goto("/board");
  await page.locator("#newBtn").click();
  await page.getByRole("tab", { name: "Coordinator" }).click();
  const submit = page.getByRole("button", { name: "Create coordinator" });
  await expect(submit).toBeDisabled(); // no name yet
  await page.locator("#wsName").fill(name);
  await expect(submit).toBeEnabled();
  await page.getByRole("checkbox", { name: project.name }).first().check();
  await submit.click();
  await expect(page.locator("#newDrawer")).toBeHidden();
  await expect(page.locator("#coordDock")).toBeVisible();
  await expect(page.locator("#coordWorkstream option:checked")).toHaveText(name);
  const list = (await (await request.get("/workstreams")).json()) as { name: string; projects: { projectId: string; role: string }[] }[];
  expect(list.find((w) => w.name === name)?.projects.map((p) => [p.projectId, p.role])).toEqual([[project.id, "shadow"]]);
});
