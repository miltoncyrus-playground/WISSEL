import { test, expect, type APIRequestContext } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// docs/SDD-coordinator.md §4.14 and §8: the coordinator window's tabs,
// Flip, owner task Done, and the confirm step on a role change.

/** What each test made, cleared after it so the shared e2e server's
 *  Needs you strip is as other spec files expect it. */
const made: { ownerTasks: string[]; cards: string[] } = { ownerTasks: [], cards: [] };

async function setup(request: APIRequestContext) {
  const repo = mkdtempSync(join(tmpdir(), "wissel-e2e-coordinator-"));
  spawnSync("git", ["init", "-q"], { cwd: repo });
  const project = await (await request.post("/projects/local", { data: { path: repo } })).json();
  // A channel adapter Wissel doesn't post to: nothing leaves the e2e server.
  const ws = await (
    await request.post("/workstreams", { data: { name: `Checkout ${Date.now()}`, ticket: "SHOP-12", projects: [{ projectId: project.id, role: "decide", decideAlone: ["decide-default"] }], channel: { adapter: "e2e", target: "e2e:decisions" } } })
  ).json();
  // A decision, the way a decider's answer arrives.
  const card = await (await request.post(`/workstreams/${ws.id}/decisions/start`, { data: { kind: "decide-default", projectId: project.id, context: "Which timezone do logs use?" } })).json();
  await request.post(`/tasks/${card.id}/result`, { data: { agentId: "decider", ok: true, summary: "decided", decision: { kind: "decide-default", text: "Use UTC", alternative: "Local time", lean: "Logs compare across hosts" } } });
  const task = await (await request.post("/owner-tasks", { data: { title: `Rotate the key ${Date.now()}`, why: "It expires Friday.", steps: ["Rotate it", "Update the secret"] } })).json();
  made.ownerTasks.push(task.id);
  made.cards.push(card.id, task.cardId);
  return { ws, project, task };
}

test.describe("Coordinator window", () => {
  test.afterEach(async ({ request }) => {
    for (const id of made.ownerTasks.splice(0)) await request.post(`/owner-tasks/${id}/dismiss`);
    for (const id of made.cards.splice(0)) await request.post(`/tasks/${id}/archive`);
  });

  test("tabs, Flip, owner task Done, and the confirm step on a role change", async ({ page, request }) => {
    const { ws, task } = await setup(request);
    await page.goto(`/app#/coordinator/${ws.id}`);
    const window = page.getByRole("region", { name: `Coordinator for ${ws.name}` });
    await expect(window.getByRole("heading", { level: 1 })).toContainText(ws.name);
    await expect(window.getByRole("list", { name: "Roles" })).toContainText("decide");
    await expect(window.getByRole("tab")).toHaveCount(4);

    // Conversation: the owner task's steps are tick-boxes; Done closes it.
    const ownerTask = window.locator(".ws-owner-task", { hasText: task.title });
    await expect(ownerTask.getByRole("checkbox")).toHaveCount(2);
    await ownerTask.getByRole("button", { name: "Done" }).click();
    await expect(window.locator(".ws-owner-task", { hasText: task.title })).toHaveCount(0);

    // Quick action: Status now shows the digest, from Wissel's own data.
    await window.getByRole("button", { name: "Status now" }).click();
    await expect(window.getByLabel("Status")).toContainText(`Digest for ${ws.name}`);

    // Decisions: Flip takes the alternative.
    await window.getByRole("tab", { name: "Decisions" }).click();
    await expect(window.locator(".ws-decision-text")).toHaveText("Use UTC");
    await window.getByRole("button", { name: "Flip: Use UTC" }).click();
    await expect(window.locator(".ws-decision-text")).toHaveText("Local time");

    // Settings: a role change shows the server's confirm text first; only
    // Confirm applies it.
    await window.getByRole("tab", { name: "Settings" }).click();
    await window.getByRole("combobox").selectOption("follow");
    const dialog = page.getByRole("dialog", { name: "Confirm the change" });
    await expect(dialog).toContainText("from decide to follow");
    expect((await (await request.get(`/workstreams/${ws.id}`)).json()).projects[0].role).toBe("decide");
    await dialog.getByRole("button", { name: "Confirm" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(window.getByRole("list", { name: "Roles" })).toContainText("follow");
    expect((await (await request.get(`/workstreams/${ws.id}`)).json()).projects[0].role).toBe("follow");

    // Log: the gate's decisions are there.
    await window.getByRole("tab", { name: "Log" }).click();
    await expect(window.getByRole("list", { name: "Gate log" })).toContainText("decision");
  });

  test("the list links each workstream's window", async ({ page, request }) => {
    const { ws } = await setup(request);
    await page.goto("/app#/coordinator");
    await page.getByRole("link", { name: ws.name }).click();
    await expect(page).toHaveURL(new RegExp(`#/coordinator/${ws.id}$`));
  });
});
