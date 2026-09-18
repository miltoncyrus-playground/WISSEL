import { test, expect } from "@playwright/test";

function unique(label: string): string {
  return `${label} ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

test.describe("New Task tab", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/board");
    await page.getByRole("button", { name: "New task" }).click();
  });

  test("submit stays disabled until title, description, and repo are all filled", async ({ page }) => {
    const submit = page.locator("#newTaskForm button[type=submit]");
    await expect(submit).toBeDisabled();

    await page.locator("#ntTitle").fill("a title");
    await expect(submit).toBeDisabled();
    await page.locator("#ntBody").fill("a description");
    await expect(submit).toBeDisabled();
    await page.locator("#ntRepo").fill("/tmp/wissel-e2e-repo");
    await expect(submit).toBeEnabled();

    await page.locator("#ntRepo").fill("");
    await expect(submit).toBeDisabled();
  });

  test("live routing preview calls the real router as labels change", async ({ page }) => {
    const preview = page.locator("#ntPreviewBody");
    await expect(preview).toContainText("Add labels");

    // "intake" is triager's real tag in agents/manifest.yaml — this
    // proves the preview hits POST /route/preview and gets back a real
    // decision, not a hardcoded UI string.
    await page.locator("#ntLabelInput").fill("intake");
    await page.locator("#ntLabelInput").press("Enter");

    await expect(preview).toContainText("Would route to");
    await expect(preview).toContainText("triager");
    await expect(preview.locator("table.candidates tr")).not.toHaveCount(0);
  });

  test("an unmatched label previews as a refusal, not a guess", async ({ page }) => {
    const preview = page.locator("#ntPreviewBody");
    await page.locator("#ntLabelInput").fill("no-such-tag-anywhere");
    await page.locator("#ntLabelInput").press("Enter");

    await expect(preview).toContainText("Would not route");
  });

  test("creating a task end to end: it appears on the kanban board", async ({ page }) => {
    const title = unique("Playwright smoke task");

    await page.locator("#ntTitle").fill(title);
    await page.locator("#ntBody").fill("Created by the New Task tab e2e smoke test.");
    await page.locator("#ntRepo").fill("/tmp/wissel-e2e-repo");
    await page.locator("#ntLabelInput").fill("intake");
    await page.locator("#ntLabelInput").press("Enter");
    await expect(page.locator("#ntChips")).toContainText("intake");

    await page.locator("#newTaskForm button[type=submit]").click();
    await expect(page.locator("#ntStatus")).toContainText("Created");

    // Form clears title/labels but keeps repo sticky, per the spec.
    await expect(page.locator("#ntTitle")).toHaveValue("");
    await expect(page.locator("#ntRepo")).toHaveValue("/tmp/wissel-e2e-repo");
    await expect(page.locator("#ntChips")).toBeEmpty();

    await page.getByRole("button", { name: "Board" }).click();
    await expect(page.locator("#kanbanBody")).toContainText(title);
  });

  test("manual override records a manual decision that beats the router's pick", async ({ page, request }) => {
    const title = unique("Override smoke task");

    await page.locator("#ntTitle").fill(title);
    await page.locator("#ntBody").fill("Exercises the override path.");
    await page.locator("#ntRepo").fill("/tmp/wissel-e2e-repo");
    // A label that would confidently route to triager on its own...
    await page.locator("#ntLabelInput").fill("intake");
    await page.locator("#ntLabelInput").press("Enter");
    await expect(page.locator("#ntPreviewBody")).toContainText("triager");

    // ...but the human overrides it to a different real agent.
    await page.locator("#ntAdvanced summary").click();
    await page.locator('#ntOverrideGrid button[data-override="reviewer"]').click();

    const [createResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/tasks") && r.request().method() === "POST"),
      page.locator("#newTaskForm button[type=submit]").click(),
    ]);
    const created = (await createResponse.json()) as { id: string };

    await expect(page.locator("#ntStatus")).toContainText("Created");

    const decisionRes = await request.get(`/tasks/${created.id}/decision`);
    const decision = await decisionRes.json();
    expect(decision.strategy).toBe("manual");
    expect(decision.selected).toBe("reviewer");

    const taskRes = await request.get(`/tasks/${created.id}`);
    const task = await taskRes.json();
    expect(task.routedTo).toBe("reviewer");
  });
});
