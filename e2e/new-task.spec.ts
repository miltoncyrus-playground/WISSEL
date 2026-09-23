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

  test("Follow-up of restricts the live preview to the parent's declared handoffs", async ({ page, request }) => {
    const parentTitle = unique("Parent routed to triager");
    const created = await request.post("/tasks", {
      data: { title: parentTitle, body: "x", labels: ["intake"], repo: "/tmp/wissel-e2e-repo" },
    });
    const parent = await created.json();
    await request.post(`/tasks/${parent.id}/decision`, {
      data: {
        matchedTags: ["intake"], candidates: [{ agentId: "triager", score: 1, reason: "tag overlap 1/1" }],
        selected: "triager", confident: true, strategy: "rule", reason: "tag overlap 1/1",
        decidedAt: new Date().toISOString(),
      },
    });

    await page.goto("/board");
    await page.getByRole("button", { name: "New task" }).click();

    // "ci" matches fixer perfectly and would win with no restriction.
    await page.locator("#ntLabelInput").fill("ci");
    await page.locator("#ntLabelInput").press("Enter");
    await expect(page.locator("#ntPreviewBody")).toContainText("fixer");

    await page.locator("#ntParentTask").selectOption(parent.id);

    // triager's only declared handoff is planner — fixer must drop out.
    const preview = page.locator("#ntPreviewBody");
    await expect(preview).toContainText("Would not route");
    await expect(preview).toContainText("restricted to declared handoffs: planner");
    await expect(preview.locator("table.candidates tr")).toHaveCount(2); // header + planner only
  });

  test("creating a follow-up task round-trips parentTaskId", async ({ page, request }) => {
    const parentTitle = unique("Parent for create test");
    const created = await request.post("/tasks", {
      data: { title: parentTitle, body: "x", labels: ["intake"], repo: "/tmp/wissel-e2e-repo" },
    });
    const parent = await created.json();
    await request.post(`/tasks/${parent.id}/decision`, {
      data: {
        matchedTags: ["intake"], candidates: [{ agentId: "triager", score: 1, reason: "tag overlap 1/1" }],
        selected: "triager", confident: true, strategy: "rule", reason: "tag overlap 1/1",
        decidedAt: new Date().toISOString(),
      },
    });

    await page.goto("/board");
    await page.getByRole("button", { name: "New task" }).click();

    const childTitle = unique("Follow-up task");
    await page.locator("#ntTitle").fill(childTitle);
    await page.locator("#ntBody").fill("created as a follow-up");
    await page.locator("#ntRepo").fill("/tmp/wissel-e2e-repo");
    await page.locator("#ntLabelInput").fill("planning");
    await page.locator("#ntLabelInput").press("Enter");
    await page.locator("#ntParentTask").selectOption(parent.id);

    const [createResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/tasks") && r.request().method() === "POST"),
      page.locator("#newTaskForm button[type=submit]").click(),
    ]);
    const child = (await createResponse.json()) as { id: string; parentTaskId?: string };
    expect(child.parentTaskId).toBe(parent.id);

    // Sticky-field reset clears the parent selection back to "None".
    await expect(page.locator("#ntParentTask")).toHaveValue("");
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

  // e2e-fixture-harness is the deterministic anthropic-api fixture
  // harness (see e2e/fixtures/harnesses.yaml/models-cache.json) —
  // always enabled: true and always has two known models on every
  // machine, unlike a claude-cli/codex-cli entry that would depend on
  // real local auth. Drives the real GET /harnesses response, not a
  // mock, so the model select's options prove the real harness ->
  // availableModels wiring, not a hardcoded list.
  test("picking a harness repopulates the model select, and both submit as harnessOverride/model", async ({ page }) => {
    const title = unique("Harness+model override task");

    await page.locator("#ntTitle").fill(title);
    await page.locator("#ntBody").fill("Exercises the harness/model override path.");
    await page.locator("#ntRepo").fill("/tmp/wissel-e2e-repo");

    await page.locator("#ntAdvanced summary").click();

    const harnessSelect = page.locator("#ntHarness");
    const modelSelect = page.locator("#ntModel");
    await expect(modelSelect).toBeDisabled();

    await harnessSelect.selectOption("e2e-fixture-harness");
    await expect(modelSelect).toBeEnabled();
    await expect(modelSelect.locator("option")).toHaveText(["Use default", "fixture-model-a", "fixture-model-b"]);

    await modelSelect.selectOption("fixture-model-a");

    const [createResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/tasks") && r.request().method() === "POST"),
      page.locator("#newTaskForm button[type=submit]").click(),
    ]);
    expect(createResponse.request().postDataJSON()).toMatchObject({
      harnessOverride: "e2e-fixture-harness",
      model: "fixture-model-a",
    });

    // Sticky-field reset clears both back to their defaults.
    await expect(harnessSelect).toHaveValue("");
    await expect(modelSelect).toBeDisabled();
  });

  test("submitting with harness and model left at their defaults omits both fields entirely", async ({ page }) => {
    const title = unique("Default harness/model task");

    await page.locator("#ntTitle").fill(title);
    await page.locator("#ntBody").fill("Exercises the no-override default path.");
    await page.locator("#ntRepo").fill("/tmp/wissel-e2e-repo");

    const [createResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/tasks") && r.request().method() === "POST"),
      page.locator("#newTaskForm button[type=submit]").click(),
    ]);
    const body = createResponse.request().postDataJSON();
    expect(body).not.toHaveProperty("harnessOverride");
    expect(body).not.toHaveProperty("model");
  });
});
