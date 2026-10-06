import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function unique(label: string): string {
  return `${label} ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function openNewDrawer(page: Page) {
  await page.getByRole("button", { name: "+ New", exact: true }).click();
  await expect(page.locator("#newDrawer")).toBeVisible();
  await expect(page.locator("#newTaskPanel")).toBeVisible();
}

// The live-card search behind "Follow-up of" and "Depends on"
// (docs/SDD-ui-cleanup.md §3.3): type, then pick the card's result row.
async function pickCard(page: Page, box: "Parent" | "Depends", query: string, taskId: string) {
  await page.locator(`#nt${box}Search`).fill(query);
  await page.locator(`#nt${box}Results [data-task-id="${taskId}"]`).click();
  await expect(page.locator(`#nt${box}Chips [data-task-id="${taskId}"]`)).toBeVisible();
}

async function createRoutedParent(request: APIRequestContext, title: string) {
  const created = await request.post("/tasks", {
    data: { title, body: "x", labels: ["intake"], repo: "/tmp/wissel-e2e-repo" },
  });
  const parent = await created.json();
  await request.post(`/tasks/${parent.id}/decision`, {
    data: {
      matchedTags: ["intake"], candidates: [{ agentId: "triager", score: 1, reason: "tag overlap 1/1" }],
      selected: "triager", confident: true, strategy: "rule", reason: "tag overlap 1/1",
      decidedAt: new Date().toISOString(),
    },
  });
  return parent as { id: string; title: string };
}

// Every step has an incoming edge, so the run has no entry point:
// startPipelineRun (src/core/pipeline-runner.ts) fails the root at once
// without spawning any agent. That keeps the Pipeline run tab's e2e on
// the real POST /pipelines/:id/run with no paid call.
async function createNoEntryPipeline(request: APIRequestContext, name: string) {
  const res = await request.post("/pipelines", {
    data: {
      name, description: "e2e: no entry step, fails instantly",
      graph: {
        steps: [
          { id: "a", name: "Plan", agentId: "planner", transition: "all" },
          { id: "b", name: "Review", agentId: "reviewer", transition: "all" },
        ],
        edges: [{ id: "ab", from: "a", to: "b" }, { id: "ba", from: "b", to: "a" }],
      },
    },
  });
  expect(res.status()).toBe(201);
  return (await res.json()) as { id: string; name: string };
}

// docs/SDD-ui-cleanup.md §3.3 (card A3): "+ New" is a side drawer with a
// Task tab and a Pipeline run tab, opened over whatever page you're on.
test.describe('"+ New" drawer', () => {
  test("opens over the current page without changing the URL, and closes with ×, Escape, or the overlay", async ({ page }) => {
    await page.goto("/board#/setup/memory");
    const newBtn = page.getByRole("button", { name: "+ New", exact: true });
    await openNewDrawer(page);
    await expect(page).toHaveURL(/#\/setup\/memory$/);
    await expect(page.locator("#memoryPanel")).toBeVisible();
    await expect(newBtn).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("tab", { name: "Task", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#ntTitle")).toBeFocused();

    await page.locator("#newClose").click();
    await expect(page.locator("#newDrawer")).toBeHidden();
    await expect(newBtn).toHaveAttribute("aria-expanded", "false");

    await openNewDrawer(page);
    await page.keyboard.press("Escape");
    await expect(page.locator("#newDrawer")).toBeHidden();

    await openNewDrawer(page);
    await page.locator("#newOverlay").click({ position: { x: 20, y: 400 } });
    await expect(page.locator("#newDrawer")).toBeHidden();
  });

  test("the old #/new URL lands on the board with the drawer open on Task, and the URL becomes #/board", async ({ page }) => {
    await page.goto("/board#/new");
    await expect(page.locator("#newDrawer")).toBeVisible();
    await expect(page.locator("#newTaskPanel")).toBeVisible();
    await expect(page.locator("#boardPanel")).toBeVisible();
    await expect(page).toHaveURL(/\/board#\/board$/);
    await expect(page.getByRole("link", { name: "Board", exact: true })).toHaveAttribute("aria-current", "page");

    // A reload is just the board: the redirect doesn't stick.
    await page.reload();
    await expect(page.locator("#boardPanel")).toBeVisible();
    await expect(page.locator("#newDrawer")).toBeHidden();
  });

  test("switching tabs shows one form at a time", async ({ page }) => {
    await page.goto("/board");
    await openNewDrawer(page);
    await page.getByRole("tab", { name: "Pipeline run", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Pipeline run", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#newPipelinePanel")).toBeVisible();
    await expect(page.locator("#newTaskPanel")).toBeHidden();
    await page.getByRole("tab", { name: "Task", exact: true }).click();
    await expect(page.locator("#newTaskPanel")).toBeVisible();
    await expect(page.locator("#newPipelinePanel")).toBeHidden();
  });
});

test.describe("New Task tab", () => {
  // Reached from the top bar's "+ New", which opens the drawer on its
  // Task tab (docs/SDD-ui-cleanup.md §3.3).
  test.beforeEach(async ({ page }) => {
    await page.goto("/board");
    await openNewDrawer(page);
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

  // docs/SDD-mcp-orchestration.md §3.3/§4 (Subtask 5): repo is only
  // truly optional once the live preview confidently resolves to a
  // readonly, no-file-access agent — "intake" is triager's real tag
  // (toolAccess: [read]) in agents/manifest.yaml.
  test("repo becomes optional once the live preview resolves to a readonly, no-file-access agent, and submits with no repo", async ({ page }) => {
    const title = unique("Playwright scratch-workspace task");
    const submit = page.locator("#newTaskForm button[type=submit]");
    const repo = page.locator("#ntRepo");

    await page.locator("#ntTitle").fill(title);
    await page.locator("#ntBody").fill("Created by the New Task tab e2e scratch-workspace test.");
    await expect(submit).toBeDisabled(); // repo still required — no confident resolution yet

    await page.locator("#ntLabelInput").fill("intake");
    await page.locator("#ntLabelInput").press("Enter");
    await expect(page.locator("#ntPreviewBody")).toContainText("triager");

    await expect(repo).not.toHaveAttribute("required");
    await expect(submit).toBeEnabled();

    const [createResponse] = await Promise.all([page.waitForResponse((r) => r.url().endsWith("/tasks") && r.request().method() === "POST"), submit.click()]);
    expect(createResponse.request().postDataJSON()).not.toHaveProperty("repo");
    await expect(page.locator("#ntStatus")).toContainText("Created");
  });

  // Regression: a write/bash-capable resolution (implementer, tag
  // "code") keeps repo required exactly as before this feature existed.
  test("repo stays required when the live preview resolves to a write/bash-capable agent", async ({ page }) => {
    const submit = page.locator("#newTaskForm button[type=submit]");
    const repo = page.locator("#ntRepo");

    await page.locator("#ntTitle").fill("a title");
    await page.locator("#ntBody").fill("a description");
    await page.locator("#ntLabelInput").fill("code");
    await page.locator("#ntLabelInput").press("Enter");
    await expect(page.locator("#ntPreviewBody")).toContainText("implementer");

    await expect(repo).toHaveAttribute("required");
    await expect(submit).toBeDisabled();

    await repo.fill("/tmp/wissel-e2e-repo");
    await expect(submit).toBeEnabled();
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

    // The board is right behind the drawer: close it and the card is there.
    await page.locator("#newClose").click();
    await expect(page.locator("#kanbanBody")).toContainText(title);
  });

  test("Follow-up of restricts the live preview to the parent's declared handoffs", async ({ page, request }) => {
    const parent = await createRoutedParent(request, unique("Parent routed to triager"));

    await page.goto("/board");
    await openNewDrawer(page);

    // "ci" matches fixer perfectly and would win with no restriction.
    await page.locator("#ntLabelInput").fill("ci");
    await page.locator("#ntLabelInput").press("Enter");
    await expect(page.locator("#ntPreviewBody")).toContainText("fixer");

    await pickCard(page, "Parent", parent.title, parent.id);
    await expect(page.locator("#ntParentTask")).toHaveValue(parent.id);

    // triager's only declared handoff is planner — fixer must drop out.
    const preview = page.locator("#ntPreviewBody");
    await expect(preview).toContainText("Would not route");
    await expect(preview).toContainText("restricted to declared handoffs: planner");
    await expect(preview.locator("table.candidates tr")).toHaveCount(2); // header + planner only
  });

  test("creating a follow-up task round-trips parentTaskId", async ({ page, request }) => {
    const parent = await createRoutedParent(request, unique("Parent for create test"));

    await page.goto("/board");
    await openNewDrawer(page);

    const childTitle = unique("Follow-up task");
    await page.locator("#ntTitle").fill(childTitle);
    await page.locator("#ntBody").fill("created as a follow-up");
    await page.locator("#ntRepo").fill("/tmp/wissel-e2e-repo");
    await page.locator("#ntLabelInput").fill("planning");
    await page.locator("#ntLabelInput").press("Enter");
    await pickCard(page, "Parent", parent.title, parent.id);
    // One parent at most: the search box hides while a parent is picked.
    await expect(page.locator("#ntParentSearch")).toBeHidden();

    const [createResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/tasks") && r.request().method() === "POST"),
      page.locator("#newTaskForm button[type=submit]").click(),
    ]);
    expect(createResponse.request().postDataJSON()).toMatchObject({ parentTaskId: parent.id, dependsOn: [] });
    const child = (await createResponse.json()) as { id: string; parentTaskId?: string };
    expect(child.parentTaskId).toBe(parent.id);

    // Sticky-field reset clears the parent selection back to none.
    await expect(page.locator("#ntParentTask")).toHaveValue("");
    await expect(page.locator("#ntParentChips")).toBeEmpty();
    await expect(page.locator("#ntParentSearch")).toBeVisible();
  });

  test("Follow-up of offers only live, routed cards", async ({ page, request }) => {
    const stamp = unique("followup-scope");
    const live = await createRoutedParent(request, `${stamp} live`);
    const done = await createRoutedParent(request, `${stamp} done`);
    await request.post(`/tasks/${done.id}/move`, { data: { status: "done" } });
    const unrouted = (await (await request.post("/tasks", { data: { title: `${stamp} unrouted`, body: "x", labels: [], repo: "/tmp/wissel-e2e-repo" } })).json()) as { id: string };

    await page.goto("/board");
    await openNewDrawer(page);
    await page.locator("#ntParentSearch").fill(stamp);
    const results = page.locator("#ntParentResults [data-task-id]");
    await expect(results).toHaveCount(1);
    await expect(results.first()).toHaveAttribute("data-task-id", live.id);
    await expect(page.locator(`#ntParentResults [data-task-id="${unrouted.id}"]`)).toHaveCount(0);
  });

  // The old "Depends on" was a checkbox list of every open card, stale
  // pending-review ones included. Now it's a search over live cards only.
  test("Depends on searches live cards only, picks several, and submits their ids as dependsOn", async ({ page, request }) => {
    const stamp = unique("depends-scope");
    const make = async (suffix: string) =>
      (await (await request.post("/tasks", { data: { title: `${stamp} ${suffix}`, body: "x", labels: [], repo: "/tmp/wissel-e2e-repo" } })).json()) as { id: string; title: string };
    const liveA = await make("live A");
    const liveB = await make("live B");
    const done = await make("done");
    await request.post(`/tasks/${done.id}/move`, { data: { status: "done" } });
    const archived = await make("archived");
    await request.post(`/tasks/${archived.id}/archive`);

    await page.goto("/board");
    await openNewDrawer(page);
    await page.locator("#ntDependsSearch").fill(stamp);
    const results = page.locator("#ntDependsResults [data-task-id]");
    // Newest first; done and archived never show.
    await expect(results).toHaveCount(2);
    await expect(results.nth(0)).toHaveAttribute("data-task-id", liveB.id);
    await expect(results.nth(1)).toHaveAttribute("data-task-id", liveA.id);

    // Keyboard: ArrowDown + Enter picks the highlighted row.
    await page.locator("#ntDependsSearch").press("ArrowDown");
    await page.locator("#ntDependsSearch").press("Enter");
    await expect(page.locator(`#ntDependsChips [data-task-id="${liveB.id}"]`)).toBeVisible();
    // A picked card isn't offered twice.
    await pickCard(page, "Depends", stamp, liveA.id);
    await page.locator("#ntDependsSearch").fill(stamp);
    await expect(page.locator("#ntDependsResults")).toContainText("No live card matches");
    await page.locator("#ntDependsSearch").press("Escape");
    // Escape closed only the result list, not the drawer.
    await expect(page.locator("#ntDependsResults")).toBeHidden();
    await expect(page.locator("#newDrawer")).toBeVisible();

    // Removing a chip un-picks it.
    await page.getByRole("button", { name: `Remove ${liveA.title}`, exact: true }).click();
    await pickCard(page, "Depends", liveA.title, liveA.id);

    await page.locator("#ntTitle").fill(unique("Task with dependencies"));
    await page.locator("#ntBody").fill("waits on two live cards");
    await page.locator("#ntRepo").fill("/tmp/wissel-e2e-repo");
    const [createResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/tasks") && r.request().method() === "POST"),
      page.locator("#newTaskForm button[type=submit]").click(),
    ]);
    expect(createResponse.request().postDataJSON().dependsOn).toEqual([liveB.id, liveA.id]);
    const created = (await createResponse.json()) as { dependsOn?: string[] };
    expect(created.dependsOn).toEqual([liveB.id, liveA.id]);
    await expect(page.locator("#ntDependsChips")).toBeEmpty();
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

  // Registers a real project via POST /projects/local against a tmp git
  // repo the test creates (initGit: true, since the tmp dir starts as a
  // plain folder) — same discipline as the harness+model test above:
  // assert on the real POST /tasks body, not just that the datalist
  // option rendered.
  test("registered projects appear in the repo datalist and submit their real path", async ({ page, request }) => {
    const dir = await mkdtemp(join(tmpdir(), "wissel-e2e-project-"));
    const addResponse = await request.post("/projects/local", { data: { path: dir, initGit: true } });
    expect(addResponse.ok()).toBe(true);
    const project = await addResponse.json();
    expect(project.path).toBe(dir);

    await page.goto("/board");
    await openNewDrawer(page);

    const option = page.locator(`#ntRepoList option[value="${dir}"]`);
    await expect(option).toHaveCount(1);
    expect(await option.getAttribute("label")).toBe(`${project.name} (${project.source})`);

    const title = unique("Project-picked repo task");
    await page.locator("#ntTitle").fill(title);
    await page.locator("#ntBody").fill("Created by selecting a registered project as the repo.");
    await page.locator("#ntRepo").fill(dir);

    const [createResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/tasks") && r.request().method() === "POST"),
      page.locator("#newTaskForm button[type=submit]").click(),
    ]);
    expect(createResponse.request().postDataJSON()).toMatchObject({ repo: dir });
  });
});

test.describe("Pipeline run tab", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/board");
    await openNewDrawer(page);
    await page.getByRole("tab", { name: "Pipeline run", exact: true }).click();
    await expect(page.locator("#newPipelinePanel")).toBeVisible();
  });

  test("lists saved pipelines from GET /pipelines and describes the one picked", async ({ page, request }) => {
    const pipeline = await createNoEntryPipeline(request, unique("Listed pipeline"));
    // Saved after the tab first opened: reopening the tab refetches.
    await page.getByRole("tab", { name: "Task", exact: true }).click();
    await page.getByRole("tab", { name: "Pipeline run", exact: true }).click();

    await page.locator("#prPipeline").selectOption(pipeline.id);
    await expect(page.locator("#prPipelineHint")).toHaveText("e2e: no entry step, fails instantly · 2 steps: Plan, Review");
  });

  test("submit stays disabled until pipeline, repo and input are all set", async ({ page, request }) => {
    const pipeline = await createNoEntryPipeline(request, unique("Gate pipeline"));
    await page.getByRole("tab", { name: "Task", exact: true }).click();
    await page.getByRole("tab", { name: "Pipeline run", exact: true }).click();
    const submit = page.locator("#prSubmit");
    await expect(submit).toBeDisabled();

    await page.locator("#prPipeline").selectOption(pipeline.id);
    await expect(submit).toBeDisabled();
    await page.locator("#prRepo").fill("/tmp/wissel-e2e-repo");
    await expect(submit).toBeDisabled();
    await page.locator("#prInput").fill("an input");
    await expect(submit).toBeEnabled();

    await page.locator("#prInput").fill("   ");
    await expect(submit).toBeDisabled();
  });

  test("Start run posts { repo, input } to the real POST /pipelines/:id/run and the run lands on the board", async ({ page, request }) => {
    const pipeline = await createNoEntryPipeline(request, unique("Drawer-run pipeline"));
    await page.getByRole("tab", { name: "Task", exact: true }).click();
    await page.getByRole("tab", { name: "Pipeline run", exact: true }).click();

    const input = unique("Drawer run input");
    await page.locator("#prPipeline").selectOption(pipeline.id);
    await page.locator("#prRepo").fill("/tmp/wissel-e2e-repo");
    await page.locator("#prInput").fill(input);

    const [runResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/pipelines/${pipeline.id}/run`) && r.request().method() === "POST"),
      page.locator("#prSubmit").click(),
    ]);
    expect(runResponse.request().postDataJSON()).toEqual({ repo: "/tmp/wissel-e2e-repo", input });
    expect(runResponse.status()).toBe(201);
    const root = (await runResponse.json()) as { id: string; title: string; status: string; pipelineId: string; body: string };
    expect(root).toMatchObject({ title: `Pipeline: ${pipeline.name}`, pipelineId: pipeline.id, body: input, status: "failed" });

    await expect(page.locator("#prStatus")).toHaveText(`“Pipeline: ${pipeline.name}” finished: Failed.`);
    // Sticky: pipeline and repo stay, input clears.
    await expect(page.locator("#prPipeline")).toHaveValue(pipeline.id);
    await expect(page.locator("#prRepo")).toHaveValue("/tmp/wissel-e2e-repo");
    await expect(page.locator("#prInput")).toHaveValue("");

    // A failed run needs a human: it's in Needs you, behind the drawer.
    await page.keyboard.press("Escape");
    await expect(page.locator(`#needsYouBody [data-task-id="${root.id}"]`)).toBeVisible();
  });

  test("a server error shows inline and re-enables submit", async ({ page, request }) => {
    const pipeline = await createNoEntryPipeline(request, unique("Deleted pipeline"));
    await page.getByRole("tab", { name: "Task", exact: true }).click();
    await page.getByRole("tab", { name: "Pipeline run", exact: true }).click();
    await page.locator("#prPipeline").selectOption(pipeline.id);
    await page.locator("#prRepo").fill("/tmp/wissel-e2e-repo");
    await page.locator("#prInput").fill("x");
    // Deleted after it was listed: the run 404s.
    await request.delete(`/pipelines/${pipeline.id}`);

    await page.locator("#prSubmit").click();
    await expect(page.locator("#prError")).toBeVisible();
    await expect(page.locator("#prStatus")).toBeHidden();
    await expect(page.locator("#prSubmit")).toBeEnabled();
  });
});

// docs/SDD-ui-cleanup.md §5: a 1440x900 screenshot per tab. Also checks
// the drawer costs the board nothing above its first card (T1, ≤ 120px).
test.describe("at 1440x900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("both tabs fit beside the board, and the board's first card stays within T1", async ({ page, request }) => {
    await request.post("/tasks", { data: { title: unique("A3 screenshot card"), body: "x", labels: [], repo: "/tmp/wissel-e2e-repo" } });
    await createNoEntryPipeline(request, unique("A3 screenshot pipeline"));
    await page.goto("/board");
    const first = page.locator("#boardPanel .kcard").first();
    await expect(first).toBeVisible();
    const top = (await first.boundingBox())!.y;
    console.log(`T1 with A3: first board card top = ${top}px (goal ≤ 120)`);
    expect(top).toBeLessThanOrEqual(120);

    await openNewDrawer(page);
    // Slid fully in: flush with the viewport's right edge (clientWidth
    // excludes any scrollbar), 560px wide, the board still visible left of it.
    const viewportWidth = await page.evaluate(() => document.documentElement.clientWidth);
    await expect(async () => {
      const box = (await page.locator("#newDrawer").boundingBox())!;
      expect(Math.round(box.x + box.width)).toBe(viewportWidth);
    }).toPass();
    const drawer = (await page.locator("#newDrawer").boundingBox())!;
    console.log(`A3: + New drawer width = ${drawer.width}px; board visible to its left = ${drawer.x}px`);
    expect(drawer.width).toBe(560);
    await page.screenshot({ path: "test-results/ui-a3/new-task-1440x900.png" });

    await page.getByRole("tab", { name: "Pipeline run", exact: true }).click();
    await expect(page.locator("#prPipeline option")).not.toHaveCount(1);
    await page.screenshot({ path: "test-results/ui-a3/new-pipeline-run-1440x900.png" });
  });
});
