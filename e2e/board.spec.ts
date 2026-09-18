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

    // Declared handoffs show as advisory text — triager only, from the
    // real manifest; agents that never declared a handoff graph (e.g.
    // reviewer) show no line at all rather than a blank one. Matched by
    // exact fleet-id, not a loose row-text substring — "reviewer" is
    // also a substring of planner's and implementer's own handoffs
    // lines ("hands off to: ...reviewer"), which a plain hasText match
    // on the whole row would collide with.
    function fleetRowById(id: string) {
      return page.locator("#agentsBox .fleet-row").filter({ has: page.locator(".fleet-id", { hasText: new RegExp("^" + id + "$") }) });
    }
    await expect(fleetRowById("triager").locator(".fleet-handoffs")).toContainText("hands off to: planner");
    await expect(fleetRowById("reviewer").locator(".fleet-handoffs")).toHaveCount(0);
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

  test("clicking a task card opens its detail drawer with routing decision, description, and actions", async ({ page, request }) => {
    const created = await request.post("/tasks", {
      data: { title: `Board click test ${Date.now()}`, body: "Some task body text.", labels: ["intake"], repo: "/tmp/wissel-e2e-repo" },
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

    const drawer = page.locator("#taskDrawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.locator("#tdTitle")).toHaveText(task.title);
    await expect(drawer.locator("#tdDescription")).toHaveText("Some task body text.");
    await expect(drawer.locator("#tdMeta")).toContainText("Inbox");
    await expect(drawer.locator("#tdDecision")).toContainText("Routed to");
    await expect(drawer.locator("#tdDecision")).toContainText("triager");

    // Run now is always offered; Mark done/failed only once the task
    // actually reaches review — never let a click take a shortcut around
    // the human-review gate.
    await expect(drawer.getByRole("button", { name: "Run now" })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Mark done" })).toHaveCount(0);
    await expect(drawer.getByRole("button", { name: "Mark failed" })).toHaveCount(0);

    await drawer.locator("#tdClose").click();
    await expect(drawer).toBeHidden();
  });

  test("a task in review offers Mark done / Mark failed, and marking it done closes the loop", async ({ page, request }) => {
    const created = await request.post("/tasks", {
      data: { title: `Review test ${Date.now()}`, body: "x", labels: [], repo: "/tmp/wissel-e2e-repo" },
    });
    const task = await created.json();
    await request.post(`/tasks/${task.id}/result`, { data: { agentId: "implementer", ok: true, summary: "opened a PR" } });

    await page.goto("/board");
    await page.locator("#kanbanBody").getByText(task.title).click();

    const drawer = page.locator("#taskDrawer");
    await expect(drawer.locator("#tdMeta")).toContainText("Review");
    await expect(drawer.locator("#tdResult")).toContainText("opened a PR");

    await drawer.getByRole("button", { name: "Mark done" }).click();
    await expect(drawer.locator("#tdMeta")).toContainText("Done");
    await expect(drawer.getByRole("button", { name: "Mark done" })).toHaveCount(0);
  });

  test("View diff reports a non-git repo honestly instead of an empty diff", async ({ page, request }) => {
    const created = await request.post("/tasks", {
      data: { title: `Diff test ${Date.now()}`, body: "x", labels: [], repo: "/tmp" },
    });
    const task = await created.json();

    await page.goto("/board");
    await page.locator("#kanbanBody").getByText(task.title).click();

    const drawer = page.locator("#taskDrawer");
    await drawer.getByRole("button", { name: "View diff" }).click();
    await expect(drawer.locator("#tdDiffSection")).toContainText("isn't a git working tree");
  });
});
