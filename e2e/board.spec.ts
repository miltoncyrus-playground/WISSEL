import { test, expect } from "@playwright/test";

test.describe("Board view", () => {
  test("is the default view and shows status stats, task-by-status, and both fleet boxes", async ({ page }) => {
    await page.goto("/board");

    await expect(page.getByRole("button", { name: "Board" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#boardPanel")).toBeVisible();
    await expect(page.locator("#newTaskPanel")).toBeHidden();

    // Status stat strip covers every real status, in order.
    const statLabels = page.locator("#stats .l");
    await expect(statLabels).toHaveText([
      "Inbox", "Ready", "Running", "Dispatched", "Review", "Done", "Failed", "No match",
    ]);

    // Task-by-status sits above the fleet boxes.
    const kanbanTop = await page.locator("#kanbanBody").boundingBox();
    const agentsTop = await page.locator("#agentsBox").boundingBox();
    expect(kanbanTop!.y).toBeLessThan(agentsTop!.y);

    // Fleet boxes are populated from the real manifest, not a mock.
    await expect(page.locator("#agentsBox")).toContainText("triager");
    await expect(page.locator("#agentsBox")).toContainText("implementer");
    await expect(page.locator("#agentsBox .tier-chip.write").first()).toContainText("handed off");
    await expect(page.locator("#skillsBox")).toContainText("lint-fixer");
    await expect(page.locator("#agentsCount")).toContainText("8 agents");
    await expect(page.locator("#skillsCount")).toContainText("4 skills");

    // No cost figure anywhere in the fleet boxes — replaced by the active dot.
    await expect(page.locator(".fleet-cost")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("$0.");
  });

  test("a fleet row shows the active dot only while it has running/dispatched work", async ({ page, request }) => {
    const idleRow = () => page.locator("#agentsBox .fleet-row", { hasText: "memory-curator" });
    const busyRow = () => page.locator("#agentsBox .fleet-row", { hasText: "triager" });

    const created = await request.post("/tasks", {
      data: { title: `Active dot test ${Date.now()}`, body: "x", labels: ["intake"], repo: "/tmp/wissel-e2e-repo" },
    });
    const task = await created.json();
    await request.post(`/tasks/${task.id}/decision`, {
      data: {
        matchedTags: ["intake"],
        candidates: [{ agentId: "triager", score: 1, reason: "tag overlap 1/1" }],
        selected: "triager", confident: true, strategy: "rule", reason: "tag overlap 1/1",
        decidedAt: new Date().toISOString(),
      },
    });
    await request.post(`/tasks/${task.id}/move`, { data: { status: "running" } });

    await page.goto("/board");
    await expect(busyRow().locator(".active-dot")).toBeVisible();
    await expect(idleRow().locator(".active-dot")).toHaveCount(0);

    await request.post(`/tasks/${task.id}/move`, { data: { status: "done" } });
    await page.reload();
    await expect(busyRow().locator(".active-dot")).toHaveCount(0);
  });

  test("clicking a task card shows its routing decision", async ({ page, request }) => {
    const created = await request.post("/tasks", {
      data: { title: `Board click test ${Date.now()}`, body: "x", labels: ["intake"], repo: "/tmp/wissel-e2e-repo" },
    });
    const task = await created.json();
    await request.post(`/tasks/${task.id}/decision`, {
      data: {
        matchedTags: ["intake"],
        candidates: [{ agentId: "triager", score: 1, reason: "tag overlap 1/1" }],
        selected: "triager", confident: true, strategy: "rule", reason: "tag overlap 1/1",
        decidedAt: new Date().toISOString(),
      },
    });

    await page.goto("/board");
    await page.locator("#kanbanBody").getByText(task.title).click();

    const decisionPanel = page.locator("#decisionPanel");
    await expect(decisionPanel).toBeVisible();
    await expect(decisionPanel).toContainText("Routed to");
    await expect(decisionPanel).toContainText("triager");
  });
});
