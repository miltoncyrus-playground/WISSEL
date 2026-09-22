import { test, expect } from "@playwright/test";

test.describe("Board view", () => {
  test("shows a version badge populated from GET /version", async ({ page }) => {
    await page.goto("/board");

    const badge = page.locator("#versionBadge");
    await expect(badge).toBeVisible();
    await expect(badge).toContainText("wissel ");
    await expect(badge).toHaveAttribute("title", /pkg 0\.0\.0/);
  });

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
    await expect(page.locator("#skillsCount")).toContainText("5 skills");

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
    // "fixer" (not "implementer") deliberately — implementer now declares
    // handoffs: [reviewer] and lands on pending-review instead, see
    // orchestrator-review-lifecycle.test.ts. This test is about the
    // generic write-tier review UI, not implementer's auto-handoff.
    await request.post(`/tasks/${task.id}/result`, { data: { agentId: "fixer", ok: true, summary: "opened a PR" } });

    await page.goto("/board");
    await page.locator("#kanbanBody").getByText(task.title).click();

    const drawer = page.locator("#taskDrawer");
    await expect(drawer.locator("#tdMeta")).toContainText("Review");
    await expect(drawer.locator("#tdResult")).toContainText("opened a PR");

    await drawer.getByRole("button", { name: "Mark done" }).click();
    await expect(drawer.locator("#tdMeta")).toContainText("Done");
    await expect(drawer.getByRole("button", { name: "Mark done" })).toHaveCount(0);
  });

  // Covers a gap the original review-gate test (above) never touched: a
  // worktree-carrying result should render Merge/Discard, not Mark
  // done/Mark failed, and that has to survive board activity elsewhere
  // (an unrelated task appearing triggers the same SSE-driven
  // refreshOpenDrawer() path a second real task would). NOTE: this does
  // NOT conclusively prove which exact code path a user-reported "no
  // Discard button" symptom came from — confirmed by testing directly
  // that this assertion passes against both the pre- and post-fix
  // board.html (the race window, if real, is apparently too narrow for
  // a local Playwright run to catch reliably). The code fix (caching the
  // last-known result instead of rendering with none on every SSE
  // refresh, plus a request-sequencing guard against out-of-order
  // fetches) is real and correct on its own merits regardless.
  test("Merge/Discard for a worktree-run task render correctly and survive unrelated board activity", async ({ page, request }) => {
    const created = await request.post("/tasks", {
      data: { title: `Worktree review test ${Date.now()}`, body: "x", labels: [], repo: "/tmp/wissel-e2e-repo" },
    });
    const task = await created.json();
    // "fixer" (not "implementer") — see the review-gate test above.
    await request.post(`/tasks/${task.id}/result`, {
      data: { agentId: "fixer", ok: true, summary: "did the thing", worktree: { path: "/tmp/wissel-e2e-wt", branch: "wissel/" + task.id } },
    });

    await page.goto("/board");
    await page.locator("#kanbanBody").getByText(task.title).click();

    const drawer = page.locator("#taskDrawer");
    await expect(drawer.getByRole("button", { name: "Merge" })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Discard" })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Mark done" })).toHaveCount(0);

    await request.post("/tasks", { data: { title: `Unrelated ${Date.now()}`, body: "x", labels: [], repo: "/tmp/wissel-e2e-repo" } });
    await page.waitForTimeout(500);

    await expect(drawer.getByRole("button", { name: "Merge" })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Discard" })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Mark done" })).toHaveCount(0);
  });

  // Coverage for a hazard found by reading the code, not by reproducing
  // it here: an earlier fix guarded loadDrawerResult against
  // out-of-order fetch resolution by comparing against a counter bumped
  // when each request *started* — under real, sustained SSE traffic,
  // new requests can start before old ones resolve, so a response could
  // fail that check and never render. Removed rather than tuned,
  // because the failure mode it risked (a permanently blank result
  // section) is worse than the one it guarded against (briefly
  // re-rendering identical data). NOTE: over localhost with near-zero
  // fetch latency this test passes against both the guarded and
  // unguarded code — it does not deterministically prove the race,
  // it's regression coverage for "a burst of concurrent events doesn't
  // leave the result section blank," which is true either way here.
  test("result content (including subagent info) still renders after a burst of rapid unrelated SSE events", async ({ page, request }) => {
    const created = await request.post("/tasks", {
      data: { title: `Burst test ${Date.now()}`, body: "x", labels: [], repo: "/tmp/wissel-e2e-repo" },
    });
    const task = await created.json();
    // "fixer" (not "implementer") — see the review-gate test above.
    await request.post(`/tasks/${task.id}/result`, {
      data: { agentId: "fixer", ok: true, summary: "spawned some helpers", subagents: { count: 2, failed: 0, byType: { "general-purpose": 2 } } },
    });

    await page.goto("/board");
    await page.locator("#kanbanBody").getByText(task.title).click();

    const drawer = page.locator("#taskDrawer");
    await expect(drawer.locator("#tdResult")).toContainText("Spawned 2 subagents");

    // Fire a burst of unrelated task creations without awaiting each one
    // — the point is overlap, not sequence.
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => request.post("/tasks", { data: { title: `Burst ${Date.now()}-${i}`, body: "x", labels: [], repo: "/tmp/wissel-e2e-repo" } })),
    );

    // The result content must still be there once the dust settles —
    // this is exactly what went permanently blank under the regression.
    await expect(drawer.locator("#tdResult")).toContainText("Spawned 2 subagents", { timeout: 5000 });
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

  // Deliberately never calls the mutating /enable or /disable endpoints
  // here — the e2e server boots against this repo's real harnesses.yaml
  // (see playwright.config.ts), and which harnesses exist/authenticate
  // is genuinely machine-dependent, unlike the static agents/manifest.yaml
  // every other test in this file reads from. This test only exercises
  // open/close/render — real DOM wiring a syntax check can't catch —
  // without asserting on, or mutating, machine-specific harness content.
  test("Manage harnesses panel opens from the strip, renders coherently, and closes via X/Escape/overlay", async ({ page }) => {
    await page.goto("/board");

    const panel = page.locator("#harnessPanel");
    await expect(panel).toBeHidden();

    await page.locator("#hmOpenBtn").click();
    await expect(panel).toBeVisible();
    // Whatever this machine's real harnesses.yaml/auth state produces,
    // the panel renders either real rows or the explicit empty state —
    // never a blank list, which would mean rendering silently failed.
    const rowCount = await panel.locator(".hm-row").count();
    const emptyCount = await panel.locator(".hm-empty").count();
    expect(rowCount + emptyCount).toBeGreaterThan(0);
    // Every row's toggle button says exactly one of these two things —
    // proves renderHarnessPanel's enabled/disabled branch actually ran,
    // not just that some button exists.
    for (const label of await panel.locator(".hm-toggle").allTextContents()) {
      expect(["Enable", "Disable"]).toContain(label);
    }

    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();

    await page.locator("#hmOpenBtn").click();
    await expect(panel).toBeVisible();
    await page.locator("#hmClose").click();
    await expect(panel).toBeHidden();

    await page.locator("#hmOpenBtn").click();
    await expect(panel).toBeVisible();
    await page.locator("#hmOverlay").click({ position: { x: 5, y: 5 } });
    await expect(panel).toBeHidden();
  });
});
