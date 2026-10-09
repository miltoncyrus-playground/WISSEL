import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
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
          // A write-tier step, so the Run dialog asks for a repo
          // (docs/SDD-ai-news-podcast.md §3.4). Never runs: no entry step.
          { id: "b", name: "Implement", agentId: "implementer", transition: "all" },
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
    await expect(row.getByRole("link", { name: `Edit ${pipeline.name}` })).toHaveAttribute("href", `#/pipelines/edit/${pipeline.id}`);

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

    // Since B1 (docs/SDD-ui-cleanup.md §4.1) a run opens in the run
    // drawer, the same place its board card leads.
    await last.locator(".pl-last-open").click();
    await expect(page.locator("#runDrawer")).toBeVisible();
    await expect(page.locator("#rdTitle")).toHaveText(second.title);
    await expect(page.locator("#rdInput")).toHaveText("second");
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
    await expect(page.locator("#prPipelineHint")).toHaveText("e2e: no entry step, fails instantly · 2 steps: Plan, Implement");

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
  // job. Here the bundle is stubbed with a module that has the same
  // export (mountPipelineEditor), so this spec checks where the page
  // sends you and the board's side of the mount contract, and doesn't
  // depend on pipeline-editor/dist being built. Card B2 (§4.2): the
  // editor is a page inside the shell, so none of this leaves /board.
  const EDITOR_STUB = `
    export function mountPipelineEditor(el, opts) {
      const render = (o) => {
        window.__editorMounts = (window.__editorMounts || []).concat([{ route: o.route, key: o.key }]);
        window.__editorHost = o.host;
        el.innerHTML = "";
        const h = document.createElement("h1");
        h.className = "editor-stub";
        h.textContent = "editor stub: " + (o.route.mode === "edit" ? "edit " + o.route.pipelineId : "new");
        el.appendChild(h);
      };
      render(opts);
      return { update: render, unmount() {} };
    }`;

  async function stubEditor(page: Page) {
    const served: string[] = [];
    await page.route("**/pipelines/edit/pipeline-editor.js", (route) => {
      served.push(new URL(route.request().url()).pathname);
      return route.fulfill({ status: 200, contentType: "text/javascript", body: EDITOR_STUB });
    });
    return served;
  }

  async function expectEditorInShell(page: Page) {
    await expect(page.locator("#pipelineEditorPage")).toBeVisible();
    await expect(page.locator("#pipelinesPage")).toBeHidden();
    await expect(page.getByRole("link", { name: "Pipelines", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#newBtn")).toBeVisible(); // same top bar
  }

  test("Edit opens the editor inside the shell at #/pipelines/edit/<id>", async ({ page, request }) => {
    const pipeline = await createNoEntryPipeline(request, unique("Edit me"));
    const served = await stubEditor(page);
    await page.goto("/board#/pipelines");
    await page.evaluate(() => { (window as unknown as { __marker: number }).__marker = 1; });
    await pipelineRow(page, pipeline.id).getByRole("link", { name: `Edit ${pipeline.name}` }).click();
    await expect(page).toHaveURL(new RegExp(`/board#/pipelines/edit/${pipeline.id}$`));
    await expectEditorInShell(page);
    await expect(page.locator("#pipelineEditorRoot h1.editor-stub")).toHaveText(`editor stub: edit ${pipeline.id}`);
    expect(served).toEqual(["/pipelines/edit/pipeline-editor.js"]);
    // Never navigated: the marker set before the click survives.
    expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(1);
  });

  test("New pipeline opens the editor inside the shell at #/pipelines/new", async ({ page }) => {
    const served = await stubEditor(page);
    await page.goto("/board#/pipelines");
    await page.getByRole("link", { name: "New pipeline", exact: true }).click();
    await expect(page).toHaveURL(/\/board#\/pipelines\/new$/);
    await expectEditorInShell(page);
    await expect(page.locator("#pipelineEditorRoot h1.editor-stub")).toHaveText("editor stub: new");
    expect(served).toEqual(["/pipelines/edit/pipeline-editor.js"]);
  });

  test("the old /pipelines/edit page URLs redirect into the shell's editor routes", async ({ page, request }) => {
    const pipeline = await createNoEntryPipeline(request, unique("Old URL"));
    await stubEditor(page);
    await page.goto("/pipelines/edit");
    await expect(page).toHaveURL(/\/board#\/pipelines\/new$/);
    await expect(page.locator("#pipelineEditorRoot h1.editor-stub")).toHaveText("editor stub: new");
    await page.goto(`/pipelines/edit/${pipeline.id}`);
    await expect(page).toHaveURL(new RegExp(`/board#/pipelines/edit/${pipeline.id}$`));
    await expect(page.locator("#pipelineEditorRoot h1.editor-stub")).toHaveText(`editor stub: edit ${pipeline.id}`);
  });

  test("the board's side of the mount contract: fresh editor per visit, setRoute without a remount, Run opens the drawer", async ({ page, request }) => {
    const pipeline = await createNoEntryPipeline(request, unique("Contract"));
    const served = await stubEditor(page);
    await page.goto("/board#/pipelines/new");
    await expect(page.locator("#pipelineEditorRoot h1.editor-stub")).toHaveText("editor stub: new");

    type W = { __editorMounts: { route: unknown; key: string }[]; __editorHost: { setRoute(r: unknown): void; runPipeline(id: string): void } };
    const mounts = () => page.evaluate(() => (window as unknown as W).__editorMounts);

    // A first Save moves a new draft to its id: address bar only, no hashchange, no remount.
    await page.evaluate((id) => (window as unknown as W).__editorHost.setRoute({ mode: "edit", pipelineId: id }), pipeline.id);
    await expect(page).toHaveURL(new RegExp(`/board#/pipelines/edit/${pipeline.id}$`));
    expect(await mounts()).toHaveLength(1);
    await expect(page.getByRole("link", { name: "Pipelines", exact: true })).toHaveAttribute("aria-current", "page");

    // Run: the "+ New" drawer's Pipeline run tab with this pipeline picked.
    await page.evaluate((id) => (window as unknown as W).__editorHost.runPipeline(id), pipeline.id);
    await expect(page.locator("#newDrawer")).toBeVisible();
    await expect(page.locator("#newPipelinePanel")).toBeVisible();
    await expect(page.locator("#prPipeline")).toHaveValue(pipeline.id);
    await page.keyboard.press("Escape");

    // Leaving and coming back mounts a fresh editor (a new key), even on the same route.
    await page.getByRole("link", { name: "Pipelines", exact: true }).click();
    await page.getByRole("link", { name: "New pipeline", exact: true }).click();
    await expect(page.locator("#pipelineEditorRoot h1.editor-stub")).toHaveText("editor stub: new");
    await page.getByRole("link", { name: "Pipelines", exact: true }).click();
    await page.getByRole("link", { name: "New pipeline", exact: true }).click();
    await expect.poll(async () => (await mounts()).length).toBe(3);
    const all = await mounts();
    expect(all.map((m) => m.route)).toEqual([{ mode: "new" }, { mode: "new" }, { mode: "new" }]);
    expect(new Set(all.map((m) => m.key)).size).toBe(3);
    // The bundle is imported once per page load.
    expect(served).toEqual(["/pipelines/edit/pipeline-editor.js"]);
  });

  test("an unbuilt editor shows the build command in the shell instead of a blank page", async ({ page }) => {
    await page.route("**/pipelines/edit/pipeline-editor.js", (route) =>
      route.fulfill({ status: 503, contentType: "text/plain", body: "pipeline-editor not built" }),
    );
    await page.goto("/board#/pipelines/new");
    await expect(page.locator("#pipelineEditorPage")).toBeVisible();
    await expect(page.locator("#pipelineEditorError")).toBeVisible();
    await expect(page.locator("#pipelineEditorError")).toContainText("cd pipeline-editor && bun install && bun run build");
  });

  test("a GET /pipelines failure shows inline instead of an empty list", async ({ page }) => {
    await page.route("**/pipelines", (route) => route.fulfill({ status: 500, body: "boom" }));
    await page.goto("/board#/pipelines");
    await expect(page.locator("#pipelinesList")).toHaveText("Failed to load: GET /pipelines failed: HTTP 500");
  });
});

// docs/SDD-ui-cleanup.md §4.1 (card B1). Target T5 (§2): one board card
// per pipeline run, and clicking it shows the full run detail.

// Two entry steps whose agents don't exist, joined into a third: the
// real POST /pipelines/:id/run creates both step cards and fails each at
// once (runStepAndSuccessors, src/core/pipeline-runner.ts: "references
// unknown agent") without spawning anything, so the join never runs and
// the root fails. No paid call.
async function createTwoStepRunPipeline(request: APIRequestContext, name: string) {
  const res = await request.post("/pipelines", {
    data: {
      name, description: "e2e: two entry steps with unknown agents",
      graph: {
        steps: [
          { id: "a", name: "Plan", agentId: "e2e-no-such-planner", transition: "all" },
          { id: "b", name: "Notify", agentId: "e2e-no-such-notifier", transition: "all" },
          { id: "c", name: "Ship", agentId: "e2e-no-such-shipper", transition: "all", joinMode: "all" },
        ],
        edges: [{ id: "ac", from: "a", to: "c" }, { id: "bc", from: "b", to: "c" }],
      },
    },
  });
  expect(res.status()).toBe(201);
  return (await res.json()) as { id: string; name: string };
}

type ApiTask = { id: string; title: string; status: string; pipelineRunId?: string };

async function startTwoStepRun(request: APIRequestContext, label: string) {
  const pipeline = await createTwoStepRunPipeline(request, unique(label));
  const input = unique(`${label} input`);
  const root = await runViaApi(request, pipeline.id, "/tmp/wissel-e2e-repo", input);
  const tasks = (await (await request.get("/tasks")).json()) as ApiTask[];
  const steps = tasks.filter((t) => t.pipelineRunId === root.id);
  return { pipeline, input, root, steps };
}

const ids = (locator: Locator) => locator.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.taskId!));

test.describe("Pipeline runs on the board", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("T5: a real run is exactly one board card with step progress; its drawer lists every step and expands one into the full task detail", async ({ page, request }) => {
    const { root, steps, input } = await startTwoStepRun(request, "T5 run");
    expect(root.status).toBe("failed");
    expect(steps.map((s) => s.status)).toEqual(["failed", "failed"]);
    const [plan, notify] = steps as [ApiTask, ApiTask];

    await page.goto("/board");
    const card = page.locator(`#boardPage .kcard[data-task-id="${root.id}"]`);
    await expect(card).toHaveCount(1);
    for (const s of steps) await expect(page.locator(`#boardPage .kcard[data-task-id="${s.id}"]`), s.title).toHaveCount(0);
    const runCards = await page.locator("#boardPage .kcard").evaluateAll(
      (els, runIds) => els.filter((el) => runIds.includes((el as HTMLElement).dataset.taskId!)).length,
      [root.id, ...steps.map((s) => s.id)],
    );
    console.log(`T5: ${runCards} board card(s) for a run with ${steps.length} step cards (goal 1)`);
    expect(runCards).toBe(1);

    // A failed run needs a human: it's in Needs you, naming the step.
    await expect(page.locator(`#needsYou .kcard[data-task-id="${root.id}"]`)).toBeVisible();
    await expect(card.locator(".kreason")).toHaveText("step Plan: failed (+1 more)");
    await expect(card.locator(".run-progress")).toHaveText("0/3 steps · failed at: Plan");
    expect(await card.locator(".run-bar .run-seg").evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.status))).toEqual(["failed", "failed", "pending"]);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/t5-run-card-1440x900.png` });

    // The drawer: every step in order, the run's own card first, and it
    // opens on the step the Needs you card is there for.
    await card.click();
    const drawer = page.locator("#runDrawer");
    await expect(drawer).toBeVisible();
    await expect(page.locator("#taskDrawer")).toBeHidden();
    await expect(page.locator("#rdTitle")).toHaveText(root.title);
    await expect(page.locator("#rdInput")).toHaveText(input);
    await expect(page.locator("#rdProgress")).toHaveText("0/3 steps · failed at: Plan");
    expect(await ids(page.locator("#rdSteps .rd-step"))).toEqual([root.id, plan.id, notify.id]);
    const planRow = page.locator(`#rdSteps .rd-step[data-task-id="${plan.id}"]`);
    const notifyRow = page.locator(`#rdSteps .rd-step[data-task-id="${notify.id}"]`);
    await expect(planRow.locator(".rd-step-name")).toHaveText("Plan");
    await expect(planRow.locator(".status-pill")).toHaveText("Failed");
    await expect(planRow.locator('[data-fact="agent"] .mono')).toHaveText("e2e-no-such-planner");
    await expect(notifyRow.locator('[data-fact="agent"] .mono')).toHaveText("e2e-no-such-notifier");
    for (const fact of ["harness", "model", "duration", "cost"]) await expect(planRow.locator(`[data-fact="${fact}"] .mono`), fact).toHaveText("—");

    // Expanded: the task drawer's own sections, moved here, not copied.
    await expect(planRow).toHaveClass(/expanded/);
    await expect(planRow.locator("#tdDetail")).toHaveCount(1);
    await expect(page.locator("#tdDetail")).toHaveCount(1);
    await expect(planRow.locator("#tdDescription")).toHaveText(input);
    await expect(planRow.locator("#tdResult")).toContainText('references unknown agent "e2e-no-such-planner"');
    await expect(planRow.locator("#tdDecision")).toHaveText("No routing decision recorded for this task yet.");
    for (const name of ["Run now", "Archive", "View output", "View diff", "Delete"]) {
      await expect(planRow.getByRole("button", { name, exact: true }), name).toBeVisible();
    }
    await planRow.getByRole("button", { name: "View diff", exact: true }).click();
    await expect(planRow.locator("#tdDiffSection")).toBeVisible();
    await page.screenshot({ path: `${SCREENSHOT_DIR}/t5-run-drawer-1440x900.png` });

    // Another step takes the detail over; the first collapses.
    await notifyRow.locator(".rd-step-head").click();
    await expect(notifyRow.locator("#tdDetail")).toHaveCount(1);
    await expect(planRow).not.toHaveClass(/expanded/);
    await expect(notifyRow.locator("#tdResult")).toContainText('references unknown agent "e2e-no-such-notifier"');
    await expect(notifyRow.locator("#tdDiffSection")).toBeHidden();

    // The run's own row holds the root card's detail and actions.
    const rootRow = page.locator(`#rdSteps .rd-step[data-task-id="${root.id}"]`);
    await rootRow.locator(".rd-step-head").click();
    await expect(rootRow.locator("#tdDescription")).toHaveText(input);
    await expect(rootRow.getByRole("button", { name: "Archive", exact: true })).toBeVisible();
    await rootRow.locator(".rd-step-head").click();
    await expect(rootRow).not.toHaveClass(/expanded/);
    await expect(page.locator("#taskDrawer #tdDetail")).toHaveCount(1);

    // Escape closes it and hands the detail back to the task drawer.
    await notifyRow.locator(".rd-step-head").click();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(page.locator("#taskDrawer #tdDetail")).toHaveCount(1);
    await expect(page.locator("#taskDrawer")).toBeHidden();

    // A plain card still opens the plain task drawer, detail included.
    const plainRes = await request.post("/tasks", { data: { title: unique("B1 plain"), body: "plain body", labels: [], repo: "/tmp/wissel-e2e-repo" } });
    const plainCard = (await plainRes.json()) as { id: string };
    await page.locator(`#kanbanBody .kcard[data-task-id="${plainCard.id}"]`).click();
    await expect(page.locator("#taskDrawer")).toBeVisible();
    await expect(page.locator("#taskDrawer #tdDescription")).toHaveText("plain body");
  });

  test("Swimlanes and Archive group a run's steps under its root, and a step opens the run drawer on that step", async ({ page, request }) => {
    const { root, steps } = await startTwoStepRun(request, "Lanes run");
    const [, notify] = steps as [ApiTask, ApiTask];

    await page.goto("/board");
    await page.getByRole("button", { name: "By feature", exact: true }).click();
    const lane = page.locator(`#swimlanesBody .swimlane[data-run-id="${root.id}"]`);
    await expect(lane).toHaveCount(1);
    await expect(lane.locator(".swimlane-head .run-progress")).toHaveText("0/3 steps · failed at: Plan");
    await expect(lane.locator(".swimlane-head .run-seg")).toHaveCount(3);
    await expect(lane.locator(".slcard")).toHaveCount(3);
    await expect(lane).toContainText(`${notify.title}`);

    await lane.locator(".slcard", { hasText: notify.title }).click();
    await expect(page.locator("#runDrawer")).toBeVisible();
    await expect(page.locator(`#rdSteps .rd-step[data-task-id="${notify.id}"]`)).toHaveClass(/expanded/);
    await expect(page.locator(`#rdSteps .rd-step[data-task-id="${notify.id}"] #tdResult`)).toContainText("e2e-no-such-notifier");
    await page.keyboard.press("Escape");

    // Archiving the run cascades down parentTaskId to its steps
    // (Board.archive): the board drops the run, Archive groups it the same way.
    expect((await request.post(`/tasks/${root.id}/archive`)).status()).toBe(200);
    await page.getByRole("link", { name: "Archive", exact: true }).click();
    const archived = page.locator(`#archiveBody .swimlane[data-run-id="${root.id}"]`);
    await expect(archived).toHaveCount(1);
    await expect(archived.locator(".slcard")).toHaveCount(3);
    await expect(archived.locator(".swimlane-head .run-progress")).toHaveText("0/3 steps · failed at: Plan");
    await page.getByRole("link", { name: "Board", exact: true }).click();
    await page.getByRole("button", { name: "Lanes", exact: true }).click();
    for (const id of [root.id, ...steps.map((s) => s.id)]) await expect(page.locator(`#boardPage .kcard[data-task-id="${id}"]`)).toHaveCount(0);
  });

  // A pipeline step can't be parked on an MCP approval or escalated
  // without a live agent run, so this one serves a known board (GET
  // /tasks) and run summary, and intercepts the actions' endpoints.
  test("a running run with steps needing a human sits in its lane and in Needs you; MCP approve and Retry work from the expanded step", async ({ page }) => {
    const base = { body: "stub input", labels: [], repo: "/tmp/wissel-e2e-repo", pipelineId: "p-b1-stub" };
    const step = (id: string, name: string, status: string, extra: Record<string, unknown> = {}) => ({
      ...base, id, title: `B1 stub: ${name}`, status, parentTaskId: "r-b1", pipelineRunId: "r-b1", pipelineStepId: id, ...extra,
    });
    const board = [
      { ...base, id: "r-b1", title: "Pipeline: B1 stub", status: "running" },
      step("s-plan", "Plan", "done", { harness: "e2e-fixture-harness" }),
      step("s-notify", "Notify", "review", { pendingMcpApproval: { server: "slack", tool: "send_message", args: { text: "hi" }, reason: "tell the team" } }),
      step("s-fix", "Fix", "escalated", { pushbackCount: 5, escalationContext: "Attempt 1: still wrong" }),
    ];
    await page.route((url) => url.pathname === "/tasks", (route) => (route.request().method() === "GET" ? route.fulfill({ json: board }) : route.fallback()));
    const summaryStep = (taskId: string, stepName: string, status: string, extra: Record<string, unknown> = {}) => ({
      taskId, stepId: taskId, stepName, attempt: 1, agentId: null, harness: null, model: null, modelSource: null, status, durationMs: null, cost: null, ...extra,
    });
    await page.route("**/pipeline-runs/r-b1", (route) => route.fulfill({
      json: {
        root: board[0], pipeline: null, totalCost: 0.1234,
        steps: [
          summaryStep("s-plan", "Plan", "done", { agentId: "planner", harness: "e2e-fixture-harness", model: "claude-opus-5-5", modelSource: "output", durationMs: 65000, cost: 0.1234 }),
          summaryStep("s-notify", "Notify", "review", { agentId: "triager", model: "claude-sonnet-5", modelSource: "config" }),
          summaryStep("s-fix", "Fix", "escalated"),
        ],
      },
    }));
    const posted: { url: string; body: unknown }[] = [];
    await page.route(/\/tasks\/s-(notify|fix)\/(mcp-approval\/approve|escalation\/retry)$/, (route) => {
      posted.push({ url: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
      return route.fulfill({ json: {} });
    });

    await page.goto("/board");
    const laneCard = page.locator('#kanbanBody .kcol[data-lane="working"] .kcard[data-task-id="r-b1"]');
    const needsCard = page.locator('#needsYou .kcard[data-task-id="r-b1"]');
    await expect(laneCard).toHaveCount(1);
    await expect(needsCard).toHaveCount(1);
    await expect(page.locator("#boardPage .kcard[data-task-id^='s-']")).toHaveCount(0);
    await expect(laneCard.locator(".run-progress")).toHaveText("1/3 steps · now: Fix");
    await expect(needsCard.locator(".kreason")).toHaveText("step Notify: MCP approval: slack · send_message (+1 more)");
    expect(await laneCard.locator(".run-seg").evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.status))).toEqual(["done", "review", "escalated"]);

    // Needs you opens the run on the step waiting for the approval.
    await needsCard.click();
    const notifyRow = page.locator('#rdSteps .rd-step[data-task-id="s-notify"]');
    await expect(notifyRow).toHaveClass(/expanded/);
    await expect(page.locator("#rdTotal")).toHaveText("Total cost $0.1234");
    const planRow = page.locator('#rdSteps .rd-step[data-task-id="s-plan"]');
    await expect(planRow.locator('[data-fact="agent"] .mono')).toHaveText("planner");
    await expect(planRow.locator('[data-fact="harness"] .mono')).toHaveText("e2e-fixture-harness");
    await expect(planRow.locator('[data-fact="model"] .mono')).toHaveText("claude-opus-5-5");
    await expect(planRow.locator('[data-fact="duration"] .mono')).toHaveText("1m 5s");
    await expect(planRow.locator('[data-fact="cost"] .mono')).toHaveText("$0.1234");
    await expect(notifyRow.locator('[data-fact="model"] .mono')).toHaveText("claude-sonnet-5 (config)");

    await expect(notifyRow.locator("#tdMcpApproval")).toContainText("send_message");
    page.on("dialog", (dialog) => dialog.accept());
    await notifyRow.getByRole("button", { name: "Approve call", exact: true }).click();
    await expect.poll(() => posted.map((p) => p.url)).toEqual(["/tasks/s-notify/mcp-approval/approve"]);

    // Retry on the escalated step: the existing inline form, from here.
    const fixRow = page.locator('#rdSteps .rd-step[data-task-id="s-fix"]');
    await fixRow.locator(".rd-step-head").click();
    await expect(fixRow.locator("#tdEscalation")).toContainText("still wrong");
    await fixRow.getByRole("button", { name: "Retry", exact: true }).click();
    await fixRow.locator("#tdRetryBody").fill("try the other approach");
    await fixRow.locator("#tdRetrySend").click();
    await expect.poll(() => posted.map((p) => p.url)).toEqual(["/tasks/s-notify/mcp-approval/approve", "/tasks/s-fix/escalation/retry"]);
    expect(posted[1]!.body).toEqual({ body: "try the other approach" });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/t5-run-drawer-actions-1440x900.png` });
  });

  test("the page's own run logic agrees with what it drew (page globals, no import)", async ({ page, request }) => {
    const { root, steps } = await startTwoStepRun(request, "Globals run");
    await page.goto("/board");
    await expect(page.locator(`#needsYou .kcard[data-task-id="${root.id}"]`)).toBeVisible();
    const folded = await page.evaluate((runId) => {
      const w = window as unknown as { indexRuns(t: unknown[]): unknown; foldsIntoRun(t: unknown, i: unknown): boolean };
      return fetch("/tasks").then((r) => r.json()).then((all: { id: string; pipelineRunId?: string }[]) => {
        const index = w.indexRuns(all);
        return all.filter((t) => t.pipelineRunId === runId).map((t) => w.foldsIntoRun(t, index));
      });
    }, root.id);
    expect(folded).toEqual(steps.map(() => true));
  });
});

// docs/SDD-ui-cleanup.md §4.3 (card B3): "View on canvas" in the run
// drawer shows the run's pipeline graph, each step coloured by its live
// status over the SSE stream; clicking a step opens B1's step detail.

type CanvasNode = { stepId: string; status: string; taskId: string | null; taskStatus: string | null; disabled: boolean };

const canvasNodes = (page: Page): Promise<CanvasNode[]> => page.locator("#rcNodes .rc-node").evaluateAll((els) => els.map((el) => {
  const b = el as HTMLButtonElement;
  return { stepId: b.dataset.stepId!, status: b.dataset.status!, taskId: b.dataset.taskId ?? null, taskStatus: b.dataset.taskStatus ?? null, disabled: b.disabled };
}));

// What GET /tasks says about each step of `runId`: its latest card (a
// step activated twice has two) and that card's status.
async function stepStatusesFromApi(request: APIRequestContext, runId: string) {
  const all = (await (await request.get("/tasks")).json()) as (ApiTask & { pipelineStepId?: string })[];
  const latest: Record<string, { taskId: string; taskStatus: string }> = {};
  for (const t of all) if (t.pipelineRunId === runId) latest[t.pipelineStepId!] = { taskId: t.id, taskStatus: t.status };
  return latest;
}

// Every node with a card names that step's latest card and its exact
// status; every other node is a step the run hasn't reached.
async function expectCanvasMatchesApi(page: Page, request: APIRequestContext, runId: string, stepIds: string[]) {
  const api = await stepStatusesFromApi(request, runId);
  const want = stepIds.map((id) => [id, api[id]?.taskId ?? null, api[id]?.taskStatus ?? null]);
  await expect.poll(async () => (await canvasNodes(page)).map((n) => [n.stepId, n.taskId, n.taskStatus])).toEqual(want);
  for (const n of await canvasNodes(page)) {
    if (n.taskId) expect(n.disabled, n.stepId).toBe(false);
    else expect([n.status, n.disabled], n.stepId).toEqual(["pending", true]);
  }
  return want;
}

test.describe("A run on its pipeline canvas", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("View on canvas shows the run's graph with every step's status matching GET /tasks, live over SSE, and a step opens its B1 detail", async ({ page, request }) => {
    const { root, steps } = await startTwoStepRun(request, "Canvas run");
    const [plan, notify] = steps as [ApiTask, ApiTask];
    const nodeA = page.locator('#rcNodes .rc-node[data-step-id="a"]');

    await page.goto("/board");
    await page.locator(`#boardPage .kcard[data-task-id="${root.id}"]`).first().click();
    await expect(page.locator("#runDrawer")).toBeVisible();
    await page.getByRole("link", { name: "View on canvas", exact: true }).click();

    await expect(page).toHaveURL(new RegExp(`#/pipelines/run/${encodeURIComponent(root.id)}$`));
    await expect(page.locator("#runDrawer")).toBeHidden();
    await expect(page.locator("#runCanvasPage")).toBeVisible();
    await expect(page.locator('#sidebar [data-route="pipelines"]')).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#rcTitle")).toHaveText(root.title);
    await expect(page.locator("#rcProgress")).toHaveText("0/3 steps · failed at: Plan");
    await expect(page.locator("#rcMessage")).toBeHidden();

    // Plan and Notify failed (unknown agents); Ship, the join, never ran.
    const first = await expectCanvasMatchesApi(page, request, root.id, ["a", "b", "c"]);
    console.log(`B3: canvas vs GET /tasks for run ${root.id}: ${JSON.stringify(first)}`);
    expect((await canvasNodes(page)).map((n) => n.status)).toEqual(["failed", "failed", "pending"]);
    await expect(nodeA.locator(".rc-name")).toHaveText("Plan");
    await expect(page.locator('#rcNodes .rc-node[data-step-id="c"]')).toContainText("Not started");
    expect(await page.locator("#rcEdgeLayer path.rc-edge").evaluateAll((els) => els.map((el) => el.getAttribute("data-edge-id")))).toEqual(["ac", "bc"]);

    // The page's own model, through its globals (no import), agrees with what it drew.
    const modelStatuses = await page.evaluate((runId) => {
      const w = window as unknown as {
        indexRuns(t: unknown[]): unknown;
        runStepsOf(i: unknown, id: string): unknown[];
        runCanvasModel(root: unknown, steps: unknown[], def: unknown): { nodes: { id: string; status: string }[] };
      };
      return Promise.all([fetch("/tasks").then((r) => r.json()), fetch("/pipelines").then((r) => r.json())]).then(([all, defs]) => {
        const root = (all as { id: string; pipelineId: string }[]).find((t) => t.id === runId)!;
        const def = (defs as { id: string }[]).find((p) => p.id === root.pipelineId);
        return w.runCanvasModel(root, w.runStepsOf(w.indexRuns(all), runId), def).nodes.map((n) => [n.id, n.status]);
      });
    }, root.id);
    expect(modelStatuses).toEqual((await canvasNodes(page)).map((n) => [n.stepId, n.status]));

    // Live: moving a step's card fires the real SSE stream; the canvas follows.
    expect((await request.post(`/tasks/${plan.id}/move`, { data: { status: "running" } })).status()).toBe(200);
    await expect(nodeA).toHaveAttribute("data-status", "running");
    await expect(nodeA.locator('[title="actively working"]')).toHaveCount(1);
    await expectCanvasMatchesApi(page, request, root.id, ["a", "b", "c"]);
    expect((await request.post(`/tasks/${plan.id}/move`, { data: { status: "done" } })).status()).toBe(200);
    await expect(nodeA).toHaveAttribute("data-status", "done");
    await expect(nodeA.locator('[title="actively working"]')).toHaveCount(0);
    await expect(page.locator("#rcProgress")).toHaveText("1/3 steps · failed at: Notify");
    await expectCanvasMatchesApi(page, request, root.id, ["a", "b", "c"]);
    await expect(page.locator('#rcEdgeLayer path[data-edge-id="ac"]')).not.toHaveClass(/reached/);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/b3-run-canvas-1440x900.png` });

    // A step opens the run drawer on that step, with B1's full task detail.
    await page.locator('#rcNodes .rc-node[data-step-id="b"]').click();
    const notifyRow = page.locator(`#rdSteps .rd-step[data-task-id="${notify.id}"]`);
    await expect(page.locator("#runDrawer")).toBeVisible();
    await expect(notifyRow).toHaveClass(/expanded/);
    await expect(notifyRow.locator("#tdResult")).toContainText('references unknown agent "e2e-no-such-notifier"');
    await expect(notifyRow.getByRole("button", { name: "Run now", exact: true })).toBeVisible();
    // Past the slide-in, so the screenshot shows the drawer where it rests.
    await expect.poll(async () => { const b = await page.locator("#runDrawer").boundingBox(); return b && b.x + b.width; }).toBe(1440);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/b3-run-canvas-step-1440x900.png` });
    await page.keyboard.press("Escape");
    await expect(page.locator("#runDrawer")).toBeHidden();
    await expect(page.locator("#runCanvasPage")).toBeVisible();

    // A step the run hasn't reached has no card to open.
    await expect(page.locator('#rcNodes .rc-node[data-step-id="c"]')).toBeDisabled();
    // Run details opens the drawer on the run itself.
    await page.getByRole("button", { name: "Run details", exact: true }).click();
    await expect(page.locator("#runDrawer")).toBeVisible();
    await expect(page.locator("#rdSteps .rd-step.expanded")).toHaveCount(0);
    await page.keyboard.press("Escape");

    // The canvas is a real URL: a reload lands back on it.
    await page.reload();
    await expect(page.locator("#runCanvasPage")).toBeVisible();
    await expectCanvasMatchesApi(page, request, root.id, ["a", "b", "c"]);
  });

  test("a re-run step shows its latest card, a reviewer's running card reads Reviewing, and loop-back edges are drawn (served board)", async ({ page }) => {
    const base = { body: "stub input", labels: [], repo: "/tmp/wissel-e2e-repo", pipelineId: "p-b3-stub" };
    const step = (id: string, stepId: string, status: string, extra: Record<string, unknown> = {}) => ({
      ...base, id, title: `B3 stub: ${stepId}`, status, parentTaskId: "r-b3", pipelineRunId: "r-b3", pipelineStepId: stepId, ...extra,
    });
    const board = [
      { ...base, id: "r-b3", title: "Pipeline: B3 stub", status: "running" },
      step("t-impl-1", "impl", "done"),
      step("t-rev-1", "rev", "done", { routedTo: "reviewer" }),
      step("t-impl-2", "impl", "done"),
      step("t-rev-2", "rev", "running", { routedTo: "reviewer" }),
    ];
    const def = {
      id: "p-b3-stub", name: "B3 stub", description: "",
      graph: {
        steps: [
          { id: "impl", name: "Implementer", agentId: "implementer", transition: "all" },
          { id: "rev", name: "Reviewer", agentId: "reviewer", transition: "choose" },
          { id: "ship", name: "Ship", agentId: "shipper", transition: "all" },
        ],
        edges: [{ id: "ir", from: "impl", to: "rev" }, { id: "ri", from: "rev", to: "impl", label: "changes" }, { id: "rs", from: "rev", to: "ship", label: "approved" }],
      },
    };
    await page.route((url) => url.pathname === "/tasks", (route) => (route.request().method() === "GET" ? route.fulfill({ json: board }) : route.fallback()));
    await page.route((url) => url.pathname === "/pipelines", (route) => (route.request().method() === "GET" ? route.fulfill({ json: [def] }) : route.fallback()));

    await page.goto("/board#/pipelines/run/r-b3");
    await expect(page.locator("#runCanvasPage")).toBeVisible();
    await expect.poll(() => canvasNodes(page)).toEqual([
      { stepId: "impl", status: "done", taskId: "t-impl-2", taskStatus: "done", disabled: false },
      { stepId: "rev", status: "reviewing", taskId: "t-rev-2", taskStatus: "running", disabled: false },
      { stepId: "ship", status: "pending", taskId: null, taskStatus: null, disabled: true },
    ]);
    await expect(page.locator('#rcNodes .rc-node[data-step-id="rev"] .rc-name')).toHaveText("Reviewer (attempt 2)");
    await expect(page.locator('#rcEdgeLayer path[data-edge-id="ri"]')).toHaveClass(/back/);
    await expect(page.locator("#rcEdgeLayer text.rc-edge-label")).toHaveText(["changes", "approved"]);
  });

  test("a canvas URL for a run that isn't on the board says so instead of drawing nothing", async ({ page }) => {
    await page.goto("/board#/pipelines/run/no-such-run");
    await expect(page.locator("#runCanvasPage")).toBeVisible();
    await expect(page.locator("#rcMessage")).toHaveText("No pipeline run no-such-run on the board. It may have been deleted.");
    await expect(page.locator("#rcScroll")).toBeHidden();
    await expect(page.locator("#rcDetails")).toBeHidden();
  });
});

// docs/SDD-ai-news-podcast.md §3.5, §3.6 (card 2): an AI news run's
// drawer shows a Quick read (headline, one line, source link; a source
// the gather step never handed off is flagged) and a Listen tab that
// reads the script aloud through speechSynthesis, one utterance per
// paragraph. Served board: the run, its pipeline and each step's result
// are fixtures (the recorded handoffs in test/fixtures/ai-news), so no
// paid call. board-news.js is reached through the page's globals, never
// imported (test/e2e-public-imports.test.ts).

const NEWS_FIXTURES = join(process.cwd(), "test", "fixtures", "ai-news");
const NEWS_GATHER = readFileSync(join(NEWS_FIXTURES, "gather-summary.md"), "utf8");
const NEWS_SCRIPT = readFileSync(join(NEWS_FIXTURES, "script-summary.md"), "utf8");
const NEWS_INVENTED = "https://invented.example.net/chip";
// The third story's source swapped for one the gather step never found.
const NEWS_SCRIPT_FLAGGED = NEWS_SCRIPT.replace("https://chips.example.com/news/inference-x1", NEWS_INVENTED);

type SpeechLog = { calls: string[]; spoken: { text: string; lang: string }[] };

// Replaces speechSynthesis with a recorder before the board's scripts
// run. The real SpeechSynthesisUtterance stays, so the board builds
// genuine utterances. getVoices is empty, as in headless Chromium.
function stubSpeech(page: Page) {
  return page.addInitScript(() => {
    const log = { calls: [] as string[], spoken: [] as { text: string; lang: string }[], utterances: [] as SpeechSynthesisUtterance[] };
    (window as unknown as { __speech: typeof log }).__speech = log;
    const fake = {
      paused: false,
      speak(u: SpeechSynthesisUtterance) { log.calls.push("speak"); log.spoken.push({ text: u.text, lang: u.lang }); log.utterances.push(u); },
      cancel() { log.calls.push("cancel"); },
      pause() { log.calls.push("pause"); this.paused = true; },
      resume() { log.calls.push("resume"); this.paused = false; },
      getVoices() { return []; },
      addEventListener() {}, removeEventListener() {},
    };
    Object.defineProperty(window, "speechSynthesis", { value: fake, configurable: true });
  });
}

const speechLog = (page: Page) => page.evaluate(() => {
  const { calls, spoken } = (window as unknown as { __speech: SpeechLog }).__speech;
  return { calls: [...calls], spoken: [...spoken] };
});

// A finished three-step "AI news podcast" run, served on GET /tasks.
async function serveNewsRun(page: Page, scriptSummary: string) {
  const base = { body: "focus on open models", labels: [], pipelineId: "p-news-stub" };
  const step = (id: string, stepId: string, agent: string) => ({
    ...base, id, title: `News stub: ${stepId}`, status: "done", parentTaskId: "r-news", pipelineRunId: "r-news", pipelineStepId: stepId, routedTo: agent,
  });
  const board = [
    { ...base, id: "r-news", title: "Pipeline: AI news podcast", status: "done" },
    step("s-gather", "gather", "ai-news-gatherer"),
    step("s-explain", "explain", "eli5-explainer"),
    step("s-script", "script", "podcast-scriptwriter"),
  ];
  const def = {
    id: "p-news-stub", name: "AI news podcast", description: "",
    graph: {
      steps: [
        { id: "gather", name: "Gather news", agentId: "ai-news-gatherer", transition: "all" },
        { id: "explain", name: "Explain simply", agentId: "eli5-explainer", transition: "all" },
        { id: "script", name: "Write podcast script", agentId: "podcast-scriptwriter", transition: "all" },
      ],
      edges: [{ id: "ge", from: "gather", to: "explain" }, { id: "es", from: "explain", to: "script" }],
    },
  };
  const summaries: Record<string, string> = { "s-gather": NEWS_GATHER, "s-explain": "explained", "s-script": scriptSummary };
  await page.route((url) => url.pathname === "/tasks", (route) => (route.request().method() === "GET" ? route.fulfill({ json: board }) : route.fallback()));
  await page.route((url) => url.pathname === "/pipelines", (route) => (route.request().method() === "GET" ? route.fulfill({ json: [def] }) : route.fallback()));
  await page.route("**/pipeline-runs/r-news", (route) => route.fulfill({ json: { root: board[0], pipeline: def, totalCost: null, steps: [] } }));
  await page.route(/\/tasks\/s-(gather|explain|script)\/result$/, (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[2]!;
    return route.fulfill({ json: { taskId: id, ok: true, summary: summaries[id] } });
  });
}

async function openNewsRun(page: Page) {
  await page.goto("/board");
  await page.locator('#boardPage .kcard[data-task-id="r-news"]').first().click();
  await expect(page.locator("#runDrawer")).toBeVisible();
  await expect(page.locator("#rdNews")).toBeVisible();
}

test.describe("AI news run: Quick read and Read aloud", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Quick read is the default tab: headline, one line and a new-tab source link per story, the invented source flagged", async ({ page }) => {
    await stubSpeech(page);
    await serveNewsRun(page, NEWS_SCRIPT_FLAGGED);
    await openNewsRun(page);

    await expect(page.getByRole("tab", { name: "Quick read", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#rdNewsQuick")).toBeVisible();
    await expect(page.locator("#rdNewsListen")).toBeHidden();
    const items = page.locator("#rdNewsList .rd-news-item");
    await expect(items).toHaveCount(3);
    await expect(items.locator(".rd-news-headline")).toHaveText(["Open coding model catches up", "Draft rules for AI in hiring", "A faster, cheaper AI chip"]);
    await expect(items.nth(1).locator(".rd-news-line")).toHaveText("Job seekers may soon have to be told when an AI reads their application.");

    const links = await items.locator(".rd-news-source a").evaluateAll((els) => els.map((a) => [a.getAttribute("href"), a.getAttribute("target"), a.getAttribute("rel")]));
    expect(links).toEqual([
      ["https://lab.example.com/blog/open-coder-2", "_blank", "noopener"],
      ["https://regulator.example.gov/press/ai-hiring-draft", "_blank", "noopener"],
      [NEWS_INVENTED, "_blank", "noopener"],
    ]);

    // §3.6: only the source the gather step never handed off is marked.
    expect(await items.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.flagged))).toEqual(["false", "false", "true"]);
    await expect(items.nth(2).locator(".rd-news-flag")).toHaveText("⚠ source not from the gather step");
    await expect(items.locator(".rd-news-flag")).toHaveCount(1);
    await expect(page.locator("#rdNewsFlagNote")).toHaveText("1 of 3 stories have a source that can't be trusted. Check it before relying on it.");

    // The page's own board-news.js (a global, no import) agrees with what it drew.
    const fromModule = await page.evaluate(([finalSummary, gatherSummary]) => {
      const w = window as unknown as { newsView(f: string, g: string, e: boolean): { rows: { flag: string | null; href: string | null }[] } };
      return w.newsView(finalSummary!, gatherSummary!, true).rows.map((r) => [r.href, r.flag !== null]);
    }, [NEWS_SCRIPT_FLAGGED, NEWS_GATHER]);
    expect(fromModule).toEqual(links.map(([href], i) => [href, i === 2]));
    await page.screenshot({ path: `${SCREENSHOT_DIR}/news-quick-read-1440x900.png` });
  });

  test("Listen: Read aloud speaks one utterance per paragraph; Pause, Resume, Stop drive speechSynthesis; closing the drawer or changing route stops it", async ({ page }) => {
    await stubSpeech(page);
    await serveNewsRun(page, NEWS_SCRIPT);
    await openNewsRun(page);

    await page.getByRole("tab", { name: "Listen", exact: true }).click();
    await expect(page.locator("#rdNewsListen")).toBeVisible();
    await expect(page.locator("#rdNewsQuick")).toBeHidden();
    const paragraphs = await page.locator("#rdNewsScript p").allTextContents();
    expect(paragraphs).toHaveLength(5);
    expect(paragraphs[0]).toBe("Welcome to this week in AI. Three stories, plain words, about five minutes.");
    const fromModule = await page.evaluate((summary) => {
      const w = window as unknown as { newsView(f: string, g: undefined, e: boolean): { paragraphs: string[] } };
      return w.newsView(summary, undefined, true).paragraphs;
    }, NEWS_SCRIPT);
    expect(paragraphs).toEqual(fromModule);

    const play = page.getByRole("button", { name: "Read aloud", exact: true });
    const pause = page.getByRole("button", { name: "Pause", exact: true });
    const stop = page.getByRole("button", { name: "Stop", exact: true });
    await expect(pause).toBeDisabled();
    await expect(stop).toBeDisabled();

    await play.click();
    let log = await speechLog(page);
    expect(log.spoken.map((s) => s.text)).toEqual(paragraphs);
    expect(log.spoken.every((s) => s.lang === "en-US")).toBe(true);
    expect(log.calls).toEqual(paragraphs.map(() => "speak"));
    await expect(play).toBeDisabled();
    await expect(pause).toBeEnabled();
    await expect(stop).toBeEnabled();

    // The utterance being read is highlighted.
    await page.evaluate(() => {
      const u = (window as unknown as { __speech: { utterances: SpeechSynthesisUtterance[] } }).__speech.utterances[2]!;
      u.onstart!.call(u, new Event("start") as SpeechSynthesisEvent);
    });
    await expect(page.locator("#rdNewsScript p.speaking")).toHaveText(paragraphs[2]!);

    await pause.click();
    const resume = page.getByRole("button", { name: "Resume", exact: true });
    await expect(resume).toBeEnabled();
    await resume.click();
    log = await speechLog(page);
    expect(log.calls.slice(-2)).toEqual(["pause", "resume"]);
    expect(log.spoken).toHaveLength(paragraphs.length); // resumed, not re-queued

    await stop.click();
    log = await speechLog(page);
    expect(log.calls.at(-1)).toBe("cancel");
    await expect(play).toBeEnabled();
    await expect(stop).toBeDisabled();
    await expect(page.locator("#rdNewsScript p.speaking")).toHaveCount(0);

    // Closing the drawer mid-read stops the speech.
    await play.click();
    const beforeClose = (await speechLog(page)).calls.length;
    await page.locator("#rdClose").click();
    await expect(page.locator("#runDrawer")).toBeHidden();
    expect((await speechLog(page)).calls.slice(beforeClose)).toEqual(["cancel"]);

    // So does a route change with the drawer still open.
    await page.locator('#boardPage .kcard[data-task-id="r-news"]').first().click();
    // The result refetches on reopen; its render resets to Quick read.
    await expect(page.locator("#rdNews")).toBeVisible();
    await page.getByRole("tab", { name: "Listen", exact: true }).click();
    await page.getByRole("button", { name: "Read aloud", exact: true }).click();
    const beforeRoute = (await speechLog(page)).calls.length;
    await page.evaluate(() => { location.hash = "#/pipelines"; });
    await expect(page.locator("#pipelinesPage")).toBeVisible();
    expect((await speechLog(page)).calls.slice(beforeRoute)).toEqual(["cancel"]);
  });

  test("without speechSynthesis the Read aloud buttons are hidden and the drawer says so; the script is still there", async ({ page }) => {
    await page.addInitScript(() => { Object.defineProperty(window, "speechSynthesis", { value: undefined, configurable: true }); });
    await serveNewsRun(page, NEWS_SCRIPT);
    await openNewsRun(page);
    await page.getByRole("tab", { name: "Listen", exact: true }).click();
    await expect(page.locator("#rdNewsControls")).toBeHidden();
    await expect(page.getByRole("button", { name: "Read aloud", exact: true })).toBeHidden();
    await expect(page.locator("#rdNewsNoSpeech")).toBeVisible();
    await expect(page.locator("#rdNewsNoSpeech")).toContainText("Read aloud isn't available in this browser");
    await expect(page.locator("#rdNewsScript p")).toHaveCount(5);
  });

  test("a malformed final handoff shows the step's raw output instead of breaking the drawer", async ({ page }) => {
    await stubSpeech(page);
    const broken = "Here you go.\n\n```pipeline-handoff\n" + JSON.stringify({ data: { quickRead: "not a list", script: "Hello." } }) + "\n```\n";
    await serveNewsRun(page, broken);
    await openNewsRun(page);
    await expect(page.locator("#rdNewsShaped")).toBeHidden();
    await expect(page.locator("#rdNewsRawReason")).toHaveText("Couldn't show the quick read: quickRead is missing or not a list. Raw output below.");
    expect(await page.locator("#rdNewsRaw").textContent()).toBe(broken);
    // The rest of the drawer still works.
    await expect(page.locator("#rdSteps .rd-step")).toHaveCount(4);
  });
});

test.describe("AI news run on a 390px phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("neither tab scrolls the drawer sideways", async ({ page }) => {
    await stubSpeech(page);
    await serveNewsRun(page, NEWS_SCRIPT_FLAGGED);
    await openNewsRun(page);
    await expect.poll(async () => { const b = await page.locator("#runDrawer").boundingBox(); return b && Math.round(b.x); }).toBe(0);
    const overflow = () => page.evaluate(() => {
      const drawer = document.getElementById("runDrawer")!;
      const body = drawer.querySelector(".drawer-body")!;
      return { drawer: drawer.scrollWidth - drawer.clientWidth, body: body.scrollWidth - body.clientWidth, page: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    expect(await overflow()).toEqual({ drawer: 0, body: 0, page: 0 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/news-quick-read-390.png` });
    await page.getByRole("tab", { name: "Listen", exact: true }).click();
    await expect(page.locator("#rdNewsControls")).toBeVisible();
    expect(await overflow()).toEqual({ drawer: 0, body: 0, page: 0 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/news-listen-390.png` });
  });
});
