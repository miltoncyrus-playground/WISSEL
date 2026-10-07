import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

// docs/SDD-ui-cleanup.md §4.2 (card B2): the pipeline editor runs inside
// the board shell (#/pipelines/new, #/pipelines/edit/<id>), uses the
// board's theme, offers "start blank" or "start from" a saved pipeline,
// and edits a step in a side panel instead of dropdowns inside the node.
//
// Needs pipeline-editor/dist (gitignored): `cd pipeline-editor && bun
// install && bun run build`. Without it the editor page shows that
// command (see e2e/pipelines.spec.ts) and these tests fail at the canvas.

// test-results/ is already gitignored (see .gitignore) — this sandbox
// only allows writes inside the worktree, not /tmp, so screenshot
// evidence for manual browser verification lives here instead.
const SCREENSHOT_DIR = "test-results/pipeline-editor-manual";

function unique(label: string): string {
  return `${label} ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Drags from a source handle (Position.Bottom, class `.source`) to a
 *  target handle (Position.Top, class `.target`) — react-flow reacts to
 *  plain mouse down/move/up on its own document-level listeners, no
 *  HTML5 drag-and-drop API involved, so a manual mouse sequence with
 *  several intermediate steps is enough to trigger a real connection. */
async function connectNodes(page: Page, sourceNodeIndex: number, targetNodeIndex: number): Promise<void> {
  const source = page.locator(".react-flow__node").nth(sourceNodeIndex).locator(".react-flow__handle-bottom.source");
  const target = page.locator(".react-flow__node").nth(targetNodeIndex).locator(".react-flow__handle-top.target");
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error("handle not visible — cannot compute drag coordinates");

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 15 });
  await page.mouse.up();
}

function stepPanel(page: Page) {
  return page.locator('#pipelineEditorRoot aside.pe-step-panel[aria-label="Step settings"]');
}

/** Clicks step `index` on the canvas; the side panel then edits it. */
async function selectStep(page: Page, index: number): Promise<void> {
  const node = page.locator(".react-flow__node").nth(index);
  await node.click();
  await expect(node).toHaveClass(/selected/);
  await expect(stepPanel(page).getByLabel("Step name")).toBeVisible();
}

/** Opens the editor the way a human does: sidebar Pipelines, then New
 *  pipeline, then one of the two starts. Never leaves /board. */
async function openNewPipeline(page: Page): Promise<void> {
  await page.goto("/board");
  await page.getByRole("link", { name: "Pipelines", exact: true }).click();
  await expect(page.locator("#pipelinesPage")).toBeVisible();
  await page.getByRole("link", { name: "New pipeline", exact: true }).click();
  await expect(page).toHaveURL(/\/board#\/pipelines\/new$/);
  await expect(page.getByRole("heading", { name: "New pipeline" })).toBeVisible();
}

interface StepSnapshot {
  name: string;
  agentId: string;
  transition: string;
  joinMode: string | null;
}

async function readStepSnapshots(page: Page, count: number): Promise<StepSnapshot[]> {
  const out: StepSnapshot[] = [];
  for (let i = 0; i < count; i++) {
    await selectStep(page, i);
    const panel = stepPanel(page);
    const name = await panel.locator('input[aria-label="Step name"]').inputValue();
    const agentId = await panel.locator('select[aria-label="Agent"]').inputValue();
    const transition = await panel.locator('select[aria-label="Transition type"]').inputValue();
    const joinModeSelect = panel.locator('select[aria-label="Join mode"]');
    const joinMode = (await joinModeSelect.count()) > 0 ? await joinModeSelect.inputValue() : null;
    out.push({ name, agentId, transition, joinMode });
  }
  return out;
}

async function createPipeline(request: APIRequestContext, name: string) {
  const res = await request.post("/pipelines", {
    data: {
      name,
      description: "e2e: a template to start from",
      graph: {
        steps: [
          { id: "plan", name: "Plan", agentId: "planner", transition: "choose" },
          { id: "review", name: "Review", agentId: "reviewer", transition: "all" },
        ],
        edges: [{ id: "plan-review", from: "plan", to: "review", label: "ready" }],
      },
    },
  });
  expect(res.status()).toBe(201);
  return (await res.json()) as { id: string; name: string; description: string; graph: unknown };
}

test.describe("pipeline editor in the board shell", () => {
  // The SDD's measuring viewport (§2). The step panel always holds its
  // 300px column, so selecting a step never resizes the canvas under a
  // drag, and three steps at 260px spacing fit beside it after Fit View.
  test.use({ viewport: { width: 1440, height: 900 } });

  test("author a 3-step join graph, save, reload identically, run it for real, and see it land on the board", async ({ page }) => {
    test.setTimeout(120_000);

    // --- board shell into the editor: sidebar Pipelines, New pipeline,
    // Start blank. Pipelines stays highlighted, the top bar stays.
    await openNewPipeline(page);
    await page.getByRole("button", { name: "Start blank", exact: true }).click();
    await expect(page.locator("#pipelineEditorRoot .react-flow")).toBeVisible();
    await expect(page.getByRole("link", { name: "Pipelines", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#newBtn")).toBeVisible();
    await page.screenshot({ path: `${SCREENSHOT_DIR}/01-empty-canvas.png` });

    // --- author 3 steps: two entry steps fanning out ("all") into a
    // join step (joinMode "all") — exercises the agent picker, the
    // transition toggle, and the join-mode toggle together, all in the
    // step side panel. ---------------------------------------------------
    const addStep = page.getByRole("button", { name: "+ Add step" });
    await addStep.click();
    await addStep.click();
    await addStep.click();
    await expect(page.locator(".react-flow__node")).toHaveCount(3);
    // The nodes are summaries now; the fields live in the panel.
    await expect(page.locator(".react-flow__node select")).toHaveCount(0);

    // A new step's default agent is agents[0]?.id (App.tsx) -- whichever
    // agent happens to be declared first in agents/manifest.yaml.
    // Select triager explicitly on each step rather than relying on that
    // default -- it isn't a documented contract. See the Run section
    // below for why triager, not quick-answer, is the right
    // real-dispatch agent here.
    const agentList = (await (await page.request.get("/agents")).json()) as { id: string; name: string }[];
    const triagerName = agentList.find((a) => a.id === "triager")!.name;
    for (let i = 0; i < 3; i++) {
      await selectStep(page, i);
      const agent = stepPanel(page).locator('select[aria-label="Agent"]');
      await agent.selectOption("triager");
      await expect(agent).toHaveValue("triager");
      // The node's summary follows the panel.
      await expect(page.locator(".react-flow__node").nth(i).locator(".step-node-agent")).toHaveText(triagerName);
    }

    // Transition-type toggle: both entry steps fan out unconditionally,
    // so the join step activates deterministically regardless of what
    // triager's free-text output looks like.
    for (const i of [0, 1]) {
      await selectStep(page, i);
      await stepPanel(page).locator('select[aria-label="Transition type"]').selectOption("all");
    }

    // No join-mode selector until a step actually has >1 incoming edge.
    await selectStep(page, 2);
    await expect(stepPanel(page).locator('select[aria-label="Join mode"]')).toHaveCount(0);

    // `fitView` only runs on mount, when there are zero nodes, so click
    // the canvas's own "Fit View" control before dragging between
    // handles, same as a real user would once steps go off-screen.
    // boundingBox() still resolves an off-screen handle's position, and
    // react-flow silently reads a drag that lands nowhere as a pan.
    await page.getByRole("button", { name: "Fit View" }).click();
    await page.waitForTimeout(200);

    await connectNodes(page, 0, 2);
    await connectNodes(page, 1, 2);
    await expect(page.locator(".react-flow__edge")).toHaveCount(2);

    await selectStep(page, 2);
    const joinModeSelect = stepPanel(page).locator('select[aria-label="Join mode"]');
    await expect(joinModeSelect).toBeVisible();
    await expect(joinModeSelect).toHaveValue("any"); // default
    await joinModeSelect.selectOption("all");
    await expect(joinModeSelect).toHaveValue("all");
    await expect(page.locator(".react-flow__node").nth(2).locator(".step-node-tags")).toContainText("join: all");

    const pipelineName = unique("Playwright pipeline smoke");
    await page.locator('input[placeholder="Pipeline name"]').fill(pipelineName);
    await page.locator('input[placeholder="Optional"]').fill("Authored end-to-end by the pipeline-editor e2e smoke test.");

    await page.screenshot({ path: `${SCREENSHOT_DIR}/02-graph-authored.png` });

    const beforeSave = await readStepSnapshots(page, 3);
    expect(beforeSave.map((s) => s.transition)).toEqual(["all", "all", "choose"]);
    expect(beforeSave[2]!.joinMode).toBe("all");

    // --- Save/load against the real /pipelines API -----------------------
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator(".pe-status")).toContainText("Saved", { timeout: 10_000 });
    await expect(page).toHaveURL(/\/board#\/pipelines\/edit\/.+/);
    const pipelineId = decodeURIComponent(new URL(page.url()).hash.split("/").pop()!);
    expect(pipelineId.length).toBeGreaterThan(0);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/03-saved.png` });

    // --- reload the page and confirm it loads back identically -----------
    await page.reload();
    await expect(page.locator(".react-flow__node")).toHaveCount(3);
    await expect(page.locator('input[placeholder="Pipeline name"]')).toHaveValue(pipelineName);
    await expect(page.locator(".react-flow__edge")).toHaveCount(2);

    const afterReload = await readStepSnapshots(page, 3);
    expect(afterReload).toEqual(beforeSave);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/04-reloaded-identical.png` });

    // --- Run -> the "+ New" drawer -> real POST /pipelines/:id/run --------
    // Real agent (triager, executor: readonly, cheapest CLI-executor
    // agent in the manifest at ~$0.03/task) — a genuine end-to-end
    // dispatch, not a mock. NOT quick-answer: its `executor: api` calls
    // anthropic-api.ts directly, which needs real Anthropic API
    // credentials the e2e fixture harness never promises. triager's
    // readonly/CLI executor authenticates via the already-logged-in
    // local `claude` CLI session.
    await page.locator("#pipelineEditorRoot").getByRole("button", { name: "Run", exact: true }).click();
    await expect(page.locator("#newPipelinePanel")).toBeVisible();
    await expect(page.locator("#prPipeline")).toHaveValue(pipelineId);
    // Every step is triager (readonly, read only), so the run needs no
    // repo: the field is hidden and each step gets a scratch workspace
    // (docs/SDD-ai-news-podcast.md §3.4).
    await expect(page.locator("#prRepoField")).toBeHidden();
    await expect(page.locator("#prNoRepoHint")).toBeVisible();
    await page.locator("#prInput").fill("Playwright smoke run: what is 2+2?");

    const [runResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/pipelines/${pipelineId}/run`) && r.request().method() === "POST", { timeout: 90_000 }),
      page.getByRole("button", { name: "Start run", exact: true }).click(),
    ]);
    expect(runResponse.request().postDataJSON()).toEqual({ input: "Playwright smoke run: what is 2+2?" });
    expect(runResponse.status()).toBe(201);
    const rootTask = (await runResponse.json()) as { id: string; status: string; title: string };
    expect(rootTask.title).toBe(`Pipeline: ${pipelineName}`);
    await expect(page.locator("#prStatus")).toContainText(`“${rootTask.title}” finished`);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/05-run-complete.png` });
    await page.keyboard.press("Escape");

    // --- the run really is on the board, grouped under its root in
    // Swimlanes (card B1 folds a run's steps into the root's lane)
    await page.getByRole("link", { name: "Board", exact: true }).click();
    await page.getByRole("button", { name: "By feature", exact: true }).click();
    const lane = page.locator(`#swimlanesBody .swimlane[data-run-id="${rootTask.id}"]`);
    await expect(lane).toHaveCount(1);
    // The joined step's own card ("<pipeline>: Step 3") proves the whole
    // graph — both entry steps and the join step — actually ran, not
    // just the root.
    await expect(lane).toContainText(`${pipelineName}: Step 3`);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/06-board-swimlanes.png` });

    // Confirm via the real API too, not just the DOM.
    const taskRes = await page.request.get(`/tasks/${rootTask.id}`);
    const task = await taskRes.json();
    expect(task.pipelineId).toBe(pipelineId);
    expect(["done", "failed"]).toContain(task.status); // settled either way — see isJoinSatisfied's done-or-failed rule
  });

  // Regression: the board is normally opened over plain HTTP on a LAN IP
  // (http://192.168.10.25:8787), an insecure context where
  // crypto.randomUUID doesn't exist. App.tsx called it directly for new
  // step and edge ids, so "+ Add step" threw "crypto.randomUUID is not a
  // function" and nothing appeared. This suite runs on localhost (a
  // secure context), so the bug was invisible here; removing randomUUID
  // before the app loads reproduces the LAN case. Entered through the
  // old /pipelines/edit URL, which now redirects into the shell.
  test("adding and connecting steps works without crypto.randomUUID (plain-HTTP LAN access)", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Crypto.prototype, "randomUUID", { value: undefined, configurable: true });
    });
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await page.goto("/pipelines/edit");
    await expect(page).toHaveURL(/\/board#\/pipelines\/new$/);
    expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe("undefined");
    await page.getByRole("button", { name: "Start blank", exact: true }).click();

    const addStep = page.getByRole("button", { name: "+ Add step" });
    await addStep.click();
    await addStep.click();
    await expect(page.locator(".react-flow__node")).toHaveCount(2);

    await page.getByRole("button", { name: "Fit View" }).click();
    await page.waitForTimeout(200);
    await connectNodes(page, 0, 1);
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);

    expect(pageErrors).toEqual([]);
  });

  test("start from a saved pipeline: the copy keeps its graph, saves as a new pipeline, and the original is untouched", async ({ page, request }) => {
    const source = await createPipeline(request, unique("Template source"));
    await openNewPipeline(page);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/07-new-pipeline-choice.png` });

    await page.getByRole("button", { name: `Start from ${source.name}`, exact: true }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(2);
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    await expect(page.locator('input[placeholder="Pipeline name"]')).toHaveValue(`${source.name} (copy)`);
    await expect(page.locator('input[placeholder="Optional"]')).toHaveValue("e2e: a template to start from");
    expect(await readStepSnapshots(page, 2)).toEqual([
      { name: "Plan", agentId: "planner", transition: "choose", joinMode: null },
      { name: "Review", agentId: "reviewer", transition: "all", joinMode: null },
    ]);

    // Not saved yet: Run is off until there's a pipeline to run.
    await expect(page.locator("#pipelineEditorRoot").getByRole("button", { name: "Run", exact: true })).toBeDisabled();

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator(".pe-status")).toContainText("Saved", { timeout: 10_000 });
    await expect(page).toHaveURL(/\/board#\/pipelines\/edit\/.+/);
    const copyId = decodeURIComponent(new URL(page.url()).hash.split("/").pop()!);
    expect(copyId).not.toBe(source.id);

    const copy = await (await request.get(`/pipelines/${copyId}`)).json();
    expect(copy.name).toBe(`${source.name} (copy)`);
    expect(copy.graph).toEqual(source.graph);
    const original = await (await request.get(`/pipelines/${source.id}`)).json();
    expect(original.name).toBe(source.name);
    expect(original.graph).toEqual(source.graph);
  });

  // docs/SDD-ai-news-podcast.md §3.3: the AI news podcast is offered as
  // a built-in template under New pipeline. Not saved here, so nothing
  // is left on the Pipelines page.
  test("start from the AI news podcast template: three steps in a line with the news agents", async ({ page }) => {
    await openNewPipeline(page);
    await page.getByRole("button", { name: "Start from template AI news podcast", exact: true }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(3);
    await expect(page.locator(".react-flow__edge")).toHaveCount(2);
    await expect(page.locator('input[placeholder="Pipeline name"]')).toHaveValue("AI news podcast");
    expect(await readStepSnapshots(page, 3)).toEqual([
      { name: "Gather news", agentId: "ai-news-gatherer", transition: "all", joinMode: null },
      { name: "Explain simply", agentId: "eli5-explainer", transition: "all", joinMode: null },
      { name: "Write podcast script", agentId: "podcast-scriptwriter", transition: "all", joinMode: null },
    ]);
  });

  test("the editor uses the board's colour tokens and follows its light/dark setting", async ({ page }) => {
    // Resolves a board token the same way the board's own CSS does.
    const token = (name: string) =>
      page.evaluate((n) => {
        const probe = document.createElement("div");
        probe.style.background = `var(${n})`;
        document.body.appendChild(probe);
        const value = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return value;
      }, name);
    const canvasBg = () => page.locator("#pipelineEditorRoot .react-flow").evaluate((el) => getComputedStyle(el).backgroundColor);
    const appBg = () => page.locator("#pipelineEditorRoot .pe-app").evaluate((el) => getComputedStyle(el).backgroundColor);

    const seen: Record<string, string> = {};
    for (const theme of ["Dark", "Light"] as const) {
      await page.goto("/board#/setup/settings");
      await page.getByRole("button", { name: theme, exact: true }).click();
      await page.getByRole("link", { name: "Pipelines", exact: true }).click();
      await page.getByRole("link", { name: "New pipeline", exact: true }).click();
      await page.getByRole("button", { name: "Start blank", exact: true }).click();
      await expect(page.locator("#pipelineEditorRoot .react-flow")).toHaveClass(new RegExp(`\\b${theme.toLowerCase()}\\b`));
      expect(await canvasBg()).toBe(await token("--page"));
      expect(await appBg()).toBe(await token("--surface"));
      seen[theme] = await canvasBg();
      await page.screenshot({ path: `${SCREENSHOT_DIR}/08-theme-${theme.toLowerCase()}.png` });
    }
    expect(seen.Dark).not.toBe(seen.Light);

    // A theme change while the editor is open applies straight away.
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await expect(page.locator("#pipelineEditorRoot .react-flow")).toHaveClass(/\bdark\b/);
    expect(await canvasBg()).toBe(seen.Dark);
    await page.evaluate(() => { try { localStorage.removeItem("wissel-theme"); } catch {} });
  });
});
