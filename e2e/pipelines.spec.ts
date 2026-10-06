import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// docs/SDD-ui-cleanup.md §3.4 (card A4): the Pipelines page under Work.
// Target T3 (§2): start a pipeline run from the board in ≤ 3 clicks,
// never leaving the page.

// test-results/ is gitignored; screenshot evidence for the T3 measure.
const SCREENSHOT_DIR = "test-results/pipelines-page";

function unique(label: string): string {
  return `${label} ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// Every step has an incoming edge, so the run has no entry point:
// startPipelineRun (src/core/pipeline-runner.ts) fails the root at once
// without spawning an agent. Real POST /pipelines/:id/run, no paid call.
// Same fixture as e2e/new-task.spec.ts's Pipeline run tab.
async function createNoEntryPipeline(request: APIRequestContext, name: string, description = "e2e: no entry step, fails instantly") {
  const res = await request.post("/pipelines", {
    data: {
      name, description,
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

async function runViaApi(request: APIRequestContext, pipelineId: string, repo: string, input: string) {
  const res = await request.post(`/pipelines/${pipelineId}/run`, { data: { repo, input } });
  expect(res.status()).toBe(201);
  return (await res.json()) as { id: string; title: string; status: string };
}

function pipelineRow(page: Page, id: string): Locator {
  return page.locator(`#pipelinesList [data-pipeline-id="${id}"]`);
}

test.describe("Pipelines page", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("lists each saved pipeline from GET /pipelines: name, description, step count, and no runs yet", async ({ page, request }) => {
    const pipeline = await createNoEntryPipeline(request, unique("Listed pipeline"));
    await page.goto("/board#/pipelines");
    await expect(page.locator("#pipelinesPage")).toBeVisible();

    const row = pipelineRow(page, pipeline.id);
    await expect(row.locator(".pl-name")).toHaveText(pipeline.name);
    await expect(row.locator(".pl-desc")).toHaveText("e2e: no entry step, fails instantly");
    await expect(row.locator(".pl-steps")).toHaveText("2 steps");
    await expect(row.locator(".pl-last")).toHaveText("No runs yet");
    await expect(row.getByRole("link", { name: `Edit ${pipeline.name}` })).toHaveAttribute("href", `/pipelines/edit/${pipeline.id}`);

    const listed = (await (await request.get("/pipelines")).json()) as unknown[];
    await expect(page.locator("#pipelinesCount")).toHaveText(String(listed.length));
    await expect(page.locator("#pipelinesList .pl-row")).toHaveCount(listed.length);
  });

  test("a pipeline saved after the page loaded shows up on the next visit", async ({ page, request }) => {
    await page.goto("/board#/pipelines");
    await expect(page.locator("#pipelinesPage")).toBeVisible();
    const pipeline = await createNoEntryPipeline(request, unique("Saved later"));
    await page.getByRole("link", { name: "Board", exact: true }).click();
    await page.getByRole("link", { name: "Pipelines", exact: true }).click();
    await expect(pipelineRow(page, pipeline.id)).toBeVisible();
  });

  test("the last run shows the newest run's outcome, follows new runs live, and opens the run's card", async ({ page, request }) => {
    const pipeline = await createNoEntryPipeline(request, unique("Run history"));
    await runViaApi(request, pipeline.id, "/tmp/wissel-e2e-repo", "first");
    await page.goto("/board#/pipelines");
    const last = pipelineRow(page, pipeline.id).locator(".pl-last");
    await expect(last.locator(".status-pill")).toHaveText("Failed");
    await expect(last.locator(".pl-last-input")).toHaveText("first");

    // A run started elsewhere lands over SSE, no reload.
    const second = await runViaApi(request, pipeline.id, "/tmp/wissel-e2e-repo", "second");
    await expect(last.locator(".pl-last-input")).toHaveText("second");
    await expect(last.locator(".pl-last-open")).toHaveAttribute("title", `Open the last run: ${second.title}`);

    await last.locator(".pl-last-open").click();
    await expect(page.locator("#taskDrawer")).toBeVisible();
    await expect(page.locator("#tdTitle")).toHaveText(second.title);
    await expect(page.locator("#tdDescription")).toHaveText("second");
  });

  // T3: Pipelines (1), Run (2), Start run (3). Repo and input are typed,
  // not clicked. "Never leaving the page": a marker on window survives,
  // so the document never navigated.
  test("T3: from the board, a pipeline run starts in 3 clicks without leaving the page, posting { repo, input }", async ({ page, request }) => {
    const pipeline = await createNoEntryPipeline(request, unique("T3 pipeline"));
    await page.goto("/board");
    await expect(page.locator("#boardPanel")).toBeVisible();
    await page.evaluate(() => { (window as unknown as { __a4SamePage: boolean }).__a4SamePage = true; });

    let clicks = 0;
    const click = async (target: Locator) => { clicks++; await target.click(); };

    await click(page.getByRole("link", { name: "Pipelines", exact: true }));
    await expect(page.locator("#pipelinesPage")).toBeVisible();
    await click(pipelineRow(page, pipeline.id).getByRole("button", { name: `Run ${pipeline.name}` }));

    await expect(page.locator("#newDrawer")).toBeVisible();
    await expect(page.getByRole("tab", { name: "Pipeline run", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#newPipelinePanel")).toBeVisible();
    await expect(page.locator("#prPipeline")).toHaveValue(pipeline.id);
    await expect(page.locator("#prPipelineHint")).toHaveText("e2e: no entry step, fails instantly · 2 steps: Plan, Review");

    const input = unique("T3 input");
    await page.locator("#prRepo").fill("/tmp/wissel-e2e-repo");
    await page.locator("#prInput").fill(input);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/t3-run-drawer-1440x900.png` });

    const [runResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/pipelines/${pipeline.id}/run`) && r.request().method() === "POST"),
      click(page.locator("#prSubmit")),
    ]);
    expect(runResponse.request().postDataJSON()).toEqual({ repo: "/tmp/wissel-e2e-repo", input });
    expect(runResponse.status()).toBe(201);
    const root = (await runResponse.json()) as { id: string; title: string };

    expect(clicks).toBeLessThanOrEqual(3);
    expect(await page.evaluate(() => (window as unknown as { __a4SamePage?: boolean }).__a4SamePage)).toBe(true);
    await expect(page).toHaveURL(/\/board#\/pipelines$/);

    // The page behind the drawer already shows the run it just started.
    await page.keyboard.press("Escape");
    await expect(page.locator("#newDrawer")).toBeHidden();
    await expect(pipelineRow(page, pipeline.id).locator(".pl-last-open")).toHaveAttribute("title", `Open the last run: ${root.title}`);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/t3-after-run-1440x900.png` });
  });

  test("Run fills an empty Repo from the pipeline's last run, but never overwrites a repo already typed", async ({ page, request }) => {
    const dir = await mkdtemp(join(tmpdir(), "wissel-e2e-a4-"));
    const pipeline = await createNoEntryPipeline(request, unique("Prefill pipeline"));
    await runViaApi(request, pipeline.id, dir, "earlier run");
    await page.goto("/board#/pipelines");
    const run = pipelineRow(page, pipeline.id).getByRole("button", { name: `Run ${pipeline.name}` });
    await expect(pipelineRow(page, pipeline.id).locator(".pl-last")).toContainText("Failed");

    await run.click();
    await expect(page.locator("#prRepo")).toHaveValue(dir);

    await page.locator("#prRepo").fill("/tmp/wissel-e2e-repo");
    await page.keyboard.press("Escape");
    await run.click();
    await expect(page.locator("#prRepo")).toHaveValue("/tmp/wissel-e2e-repo");
  });

  test("Run on a second pipeline switches the drawer's pick to it", async ({ page, request }) => {
    const first = await createNoEntryPipeline(request, unique("First pick"));
    const second = await createNoEntryPipeline(request, unique("Second pick"));
    await page.goto("/board#/pipelines");
    await pipelineRow(page, first.id).getByRole("button", { name: `Run ${first.name}` }).click();
    await expect(page.locator("#prPipeline")).toHaveValue(first.id);
    await page.keyboard.press("Escape");
    await pipelineRow(page, second.id).getByRole("button", { name: `Run ${second.name}` }).click();
    await expect(page.locator("#prPipeline")).toHaveValue(second.id);
  });

  // The editor itself (its own Vite bundle) is pipeline-editor.spec.ts's
  // job, including loading /pipelines/edit/<id>. Here it's stubbed, so
  // this spec checks only where the page sends you and doesn't depend on
  // pipeline-editor/dist being built.
  async function stubEditor(page: Page) {
    const served: string[] = [];
    await page.route("**/pipelines/edit**", (route) => {
      served.push(new URL(route.request().url()).pathname);
      return route.fulfill({ status: 200, contentType: "text/html", body: "<h1>editor stub</h1>" });
    });
    return served;
  }

  test("Edit opens the existing editor at /pipelines/edit/<id>", async ({ page, request }) => {
    const pipeline = await createNoEntryPipeline(request, unique("Edit me"));
    const served = await stubEditor(page);
    await page.goto("/board#/pipelines");
    await pipelineRow(page, pipeline.id).getByRole("link", { name: `Edit ${pipeline.name}` }).click();
    await expect(page).toHaveURL(new RegExp(`/pipelines/edit/${pipeline.id}$`));
    await expect(page.locator("h1")).toHaveText("editor stub");
    expect(served).toEqual([`/pipelines/edit/${pipeline.id}`]);
  });

  test("New pipeline opens the editor at /pipelines/edit", async ({ page }) => {
    const served = await stubEditor(page);
    await page.goto("/board#/pipelines");
    await page.getByRole("link", { name: "New pipeline", exact: true }).click();
    await expect(page).toHaveURL(/\/pipelines\/edit$/);
    await expect(page.locator("h1")).toHaveText("editor stub");
    expect(served).toEqual(["/pipelines/edit"]);
  });

  test("a GET /pipelines failure shows inline instead of an empty list", async ({ page }) => {
    await page.route("**/pipelines", (route) => route.fulfill({ status: 500, body: "boom" }));
    await page.goto("/board#/pipelines");
    await expect(page.locator("#pipelinesList")).toHaveText("Failed to load: GET /pipelines failed: HTTP 500");
  });
});
