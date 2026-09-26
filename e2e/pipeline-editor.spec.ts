import { test, expect, type Page } from "@playwright/test";

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

interface StepSnapshot {
  name: string;
  agentId: string;
  transition: string;
  joinMode: string | null;
}

async function readStepSnapshots(page: Page, count: number): Promise<StepSnapshot[]> {
  const out: StepSnapshot[] = [];
  for (let i = 0; i < count; i++) {
    const node = page.locator(".react-flow__node").nth(i);
    const name = await node.locator("input.step-node-name").inputValue();
    const agentId = await node.locator('select[aria-label="Agent"]').inputValue();
    const transition = await node.locator('select[aria-label="Transition type"]').inputValue();
    const joinModeSelect = node.locator('select[aria-label="Join mode"]');
    const joinMode = (await joinModeSelect.count()) > 0 ? await joinModeSelect.inputValue() : null;
    out.push({ name, agentId, transition, joinMode });
  }
  return out;
}

test.describe("pipeline-editor canvas app", () => {
  // Default 1280x720 leaves the 3rd step's card (and its connection
  // handles) partially off-screen at 260px-per-step spacing — confirmed
  // live: boundingBox() still resolves a handle's layout position even
  // when it's outside the viewport, so the drag coordinates looked
  // valid but landed nowhere, and react-flow silently read the
  // mousedown as a canvas pan instead of a connection attempt (0 edges
  // created, no error). A wider viewport keeps all 3 steps on-screen so
  // the drag actually lands on the handles, matching how a real browser
  // window (not a real usability constraint of the app itself) would
  // normally have room to show this.
  test.use({ viewport: { width: 1600, height: 900 } });

  test("author a 3-step join graph, save, reload identically, run it for real, and see it land on the board", async ({ page }) => {
    test.setTimeout(120_000);

    // --- board.html's nav link out to the editor ------------------------
    await page.goto("/board");
    const editorLink = page.locator('a[href="/pipelines/edit"]');
    await expect(editorLink).toHaveCount(1);
    await expect(editorLink).toHaveText("Pipeline editor ↗");
    await editorLink.click();
    await expect(page).toHaveURL(/\/pipelines\/edit$/);

    await expect(page.locator("h1")).toHaveText("Pipeline editor");
    await page.screenshot({ path: `${SCREENSHOT_DIR}/01-empty-canvas.png` });

    // --- author 3 steps: two entry steps fanning out ("all") into a
    // join step (joinMode "all") — exercises the agent picker, the
    // transition toggle, and the join-mode toggle together. -------------
    const addStep = page.getByRole("button", { name: "+ Add step" });
    await addStep.click();
    await addStep.click();
    await addStep.click();
    await expect(page.locator(".react-flow__node")).toHaveCount(3);

    // A new step's default agent is agents[0]?.id (App.tsx) -- whichever
    // agent happens to be declared first in agents/manifest.yaml
    // (triager, as it happens). Select it explicitly on each step rather
    // than relying on that default -- it isn't a documented contract, and
    // asserting on an implicit ordering would break the moment the
    // manifest gets reordered. See the Run section below for why
    // triager, not quick-answer, is the right real-dispatch agent here.
    for (let i = 0; i < 3; i++) {
      const node = page.locator(".react-flow__node").nth(i);
      await node.locator('select[aria-label="Agent"]').selectOption("triager");
      await expect(node.locator('select[aria-label="Agent"]')).toHaveValue("triager");
    }

    // Transition-type toggle: both entry steps fan out unconditionally,
    // so the join step activates deterministically regardless of what
    // triager's free-text output looks like.
    await page.locator(".react-flow__node").nth(0).locator('select[aria-label="Transition type"]').selectOption("all");
    await page.locator(".react-flow__node").nth(1).locator('select[aria-label="Transition type"]').selectOption("all");

    // No join-mode selector until a step actually has >1 incoming edge.
    await expect(page.locator(".react-flow__node").nth(2).locator('select[aria-label="Join mode"]')).toHaveCount(0);

    // `fitView` (App.tsx) only runs on initial mount, when there are zero
    // nodes — adding steps afterward never re-fits, so by 3 steps the
    // 3rd step's handles render past the viewport edge even at a wide
    // 1600px window. boundingBox() still resolves a real layout
    // position for an off-screen handle, so the drag coordinates look
    // valid but land nowhere — confirmed live: react-flow silently reads
    // the mousedown as a canvas pan instead of a connection attempt (0
    // edges, no error). The app already ships a "Fit View" control for
    // exactly this — click it before connecting, same as a real user
    // would once they can't see all their steps.
    await page.getByRole("button", { name: "Fit View" }).click();
    await page.waitForTimeout(200);

    await connectNodes(page, 0, 2);
    await connectNodes(page, 1, 2);
    await expect(page.locator(".react-flow__edge")).toHaveCount(2);

    const joinModeSelect = page.locator(".react-flow__node").nth(2).locator('select[aria-label="Join mode"]');
    await expect(joinModeSelect).toBeVisible();
    await expect(joinModeSelect).toHaveValue("any"); // default
    await joinModeSelect.selectOption("all");
    await expect(joinModeSelect).toHaveValue("all");

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
    await expect(page).toHaveURL(/\/pipelines\/edit\/.+/);
    const pipelineId = new URL(page.url()).pathname.split("/").pop()!;
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

    // --- Run button -> real POST /pipelines/:id/run ----------------------
    // Real agent (triager, executor: readonly, cheapest CLI-executor
    // agent in the manifest at ~$0.03/task) — this is a genuine
    // end-to-end dispatch, not a mock. NOT quick-answer: its `executor:
    // api` calls anthropic-api.ts directly, which needs real Anthropic
    // API credentials. The e2e fixture harness (e2e/fixtures/
    // harnesses.yaml) deliberately reports `enabled: true` for
    // discovery/UI purposes without ever promising a *real* call
    // authenticates — confirmed live: quick-answer failed here with
    // "Could not resolve authentication method." triager's readonly/CLI
    // executor instead authenticates via the already-logged-in local
    // `claude` CLI session, the same real auth every other agent
    // dispatch in this project already depends on.
    await page.locator('input[placeholder="/path/to/repo"]').fill("/tmp/wissel-e2e-repo");
    await page.locator('input[placeholder="What should this run do?"]').fill("Playwright smoke run: what is 2+2?");

    const [runResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/pipelines/${pipelineId}/run`) && r.request().method() === "POST", { timeout: 90_000 }),
      page.getByRole("button", { name: "Run", exact: true }).click(),
    ]);
    expect(runResponse.status()).toBe(201);
    const rootTask = (await runResponse.json()) as { id: string; status: string; title: string };
    expect(rootTask.title).toBe(`Pipeline: ${pipelineName}`);

    await expect(page.locator(".pe-status")).toContainText(`Pipeline run created: task ${rootTask.id}`);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/05-run-complete.png` });

    // --- the resulting task really is on the board, in its Swimlanes lane
    await page.locator(".pe-run-link").click();
    await expect(page).toHaveURL(/\/board$/);

    await page.getByRole("button", { name: "Swimlanes" }).click();
    const lane = page.locator(".swimlane", { hasText: rootTask.title });
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
});
