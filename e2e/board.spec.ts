import { test, expect, type APIRequestContext } from "@playwright/test";

/**
 * Drives one implementer task through 6 straight reviewer rejections to
 * `escalated`, purely over HTTP — no orchestrator sweep, no real `claude`
 * process. `POST /tasks/:id/result` runs the exact same `finishResult`/
 * `handleReviewVerdict` logic a live reviewer's report would (see
 * src/core/orchestrator.ts), so this reaches the real escalation state,
 * not a hand-rolled stand-in for it. Mirrors the unit-tested lineage in
 * test/orchestrator-review-lifecycle.test.ts's "6 consecutive rejections
 * escalate..." case — same agent ids, same round count, same feedback
 * shape — so `escalationContext`'s exact wire format ("Attempt N: ...",
 * joined by blank lines) is guaranteed to match what this UI parses.
 * `routedTo` on each reviewer task has to be set explicitly via
 * `POST .../decision` — buildEscalationContext only counts a round whose
 * card has `routedTo === "reviewer"` recorded, which a live orchestrator
 * sweep sets automatically but a direct `/result` post does not.
 */
async function driveToEscalated(request: APIRequestContext, title: string, repo: string) {
  const created = await request.post("/tasks", { data: { title, body: "x", labels: ["code"], repo } });
  let implementerId = (await created.json()).id as string;

  for (let round = 1; round <= 6; round++) {
    await request.post(`/tasks/${implementerId}/result`, { data: { agentId: "implementer", ok: true, summary: `attempt ${round}` } });

    const afterImpl = await (await request.get("/tasks")).json();
    const reviewer = afterImpl.find((t: { parentTaskId?: string }) => t.parentTaskId === implementerId);
    await request.post(`/tasks/${reviewer.id}/decision`, {
      data: {
        matchedTags: ["review"],
        candidates: [{ agentId: "reviewer", score: 1, reason: "tag overlap 1/1" }],
        selected: "reviewer", confident: true, strategy: "rule", reason: "tag overlap 1/1",
        decidedAt: new Date().toISOString(),
      },
    });
    await request.post(`/tasks/${reviewer.id}/result`, {
      data: { agentId: "reviewer", ok: true, summary: `round ${round}: changes requested`, verdict: "changes_requested", reviewFeedback: `round ${round}: still not right` },
    });

    if (round < 6) {
      const afterVerdict = await (await request.get("/tasks")).json();
      const nextAttempt = afterVerdict.find((t: { title: string; pushbackCount?: number }) => t.title === title && t.pushbackCount === round);
      implementerId = nextAttempt.id;
    }
  }

  const finalTasks = await (await request.get("/tasks")).json();
  return finalTasks.find((t: { title: string; status: string }) => t.title === title && t.status === "escalated");
}

test.describe("Memory tab", () => {
  test("switches from Board, shows the empty state (no curation has run in this fixture server), and back", async ({ page }) => {
    await page.goto("/board");

    await page.getByRole("button", { name: "Memory", exact: true }).click();
    await expect(page.getByRole("button", { name: "Memory", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#memoryPanel")).toBeVisible();
    await expect(page.locator("#boardPanel")).toBeHidden();
    await expect(page.locator("#newTaskPanel")).toBeHidden();

    // WISSEL_MEMORY_CURATION is unset in this fixture server (see
    // playwright.config.ts) — memory/lessons.md has never been written,
    // exactly the state a fresh install is in.
    await expect(page.locator("#memoryContent")).toHaveText(/hasn't run, or WISSEL_MEMORY_CURATION is off/);
    // The exact path is env-configured (WISSEL_MEMORY_PATH, see
    // playwright.config.ts) so this fixture never touches the real
    // project's own memory/lessons.md — assert it's shown, not a
    // literal value this test would otherwise have to keep in sync.
    await expect(page.locator("#memoryPath")).not.toBeEmpty();
    await expect(page.locator("#memoryHistory")).toContainText("No curation runs yet.");
    await expect(page.locator("#memoryHistory details")).toHaveCount(0);

    await page.getByRole("button", { name: "Board" }).click();
    await expect(page.locator("#boardPanel")).toBeVisible();
    await expect(page.locator("#memoryPanel")).toBeHidden();
  });

  test("a real curation run shows up with its content, expanded by default", async ({ page, request }) => {
    // Simulates what a real memory-curator pass leaves behind, purely
    // over HTTP — same principle as driveToEscalated above: exercise the
    // UI against real recorded state, not a hand-rolled stand-in for it.
    const created = await request.post("/tasks", { data: { title: "Curate session memory", body: "x", labels: ["memory", "housekeeping"], repo: "." } });
    const taskId = (await created.json()).id as string;
    await request.post(`/tasks/${taskId}/result`, {
      data: { agentId: "memory-curator", ok: true, summary: "# Lessons\n\nA real curated lesson from this test.", actualCost: 0.05, harnessId: "claude" },
    });

    await page.goto("/board");
    await page.getByRole("button", { name: "Memory", exact: true }).click();

    await expect(page.locator("#memoryHistory details")).toHaveCount(1);
    const entry = page.locator("#memoryHistory details").first();
    await expect(entry).toHaveJSProperty("open", true);
    await expect(entry.locator("summary")).toContainText("·"); // timestamp/cost/harness separator
    await expect(entry).toContainText("A real curated lesson from this test.");
  });

  test("content following the topic contract renders one drilldown per topic, detail collapsed until expanded", async ({ page, request }) => {
    const created = await request.post("/tasks", { data: { title: "Curate session memory", body: "x", labels: ["memory", "housekeeping"], repo: "." } });
    const taskId = (await created.json()).id as string;
    const content = [
      "# Wissel engineering lessons",
      "",
      "## Worktree isolation",
      "Write-tier work happens in its own copy of the repo, so it never messes with what you're already looking at.",
      "",
      "Mechanism: git worktree add off HEAD, under ~/.wissel/worktrees/<key>. See src/services/worktree.ts.",
      "",
      "## Output contracts",
      "Agents whose reply becomes data, not just words on a screen, need a strict format so a stray sentence can't corrupt it.",
    ].join("\n");
    await request.post(`/tasks/${taskId}/result`, { data: { agentId: "memory-curator", ok: true, summary: content } });

    await page.goto("/board");
    await page.getByRole("button", { name: "Memory", exact: true }).click();

    const topics = page.locator("#memoryContent details.memory-topic");
    await expect(topics).toHaveCount(2);

    const first = topics.first();
    await expect(first.locator(".mt-title")).toHaveText("Worktree isolation");
    await expect(first.locator(".mt-eli5")).toContainText("never messes with what you're already looking at");
    // Detail exists but is collapsed by default — scanning topics means
    // reading ELI5 lines, not implementation detail, until asked for it.
    await expect(first).toHaveJSProperty("open", false);
    await expect(first.locator(".mt-detail")).toContainText("src/services/worktree.ts");
    await expect(first.locator(".mt-detail")).toBeHidden();

    await first.locator("summary").click();
    await expect(first).toHaveJSProperty("open", true);
    await expect(first.locator(".mt-detail")).toBeVisible();

    await expect(page.locator("#memoryContent .memory-lede")).toHaveText("Wissel engineering lessons");
  });
});

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

    // Status stat strip covers every real status, in order — including
    // pending-review/escalated (the automated-reviewer review lifecycle;
    // see orchestrator.ts's finishResult/handleReviewVerdict).
    const statLabels = page.locator("#stats .l");
    await expect(statLabels).toHaveText([
      "Inbox", "Ready", "Running", "Dispatched", "Pending review", "Review", "Escalated", "Done", "Failed", "No match", "Superseded",
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

  test("a pending-review task shows a read-only attempt indicator, never Merge/Discard/Mark-done", async ({ page, request }) => {
    // pushbackCount: 2 set directly at creation (board.create passes it
    // through untouched — see src/services/board.ts) so this exercises
    // attempt N for N > 1, not just the trivial first-attempt case.
    const created = await request.post("/tasks", {
      data: { title: `Pending review test ${Date.now()}`, body: "x", labels: ["code"], repo: "/tmp/wissel-e2e-repo", pushbackCount: 2 },
    });
    const task = await created.json();
    await request.post(`/tasks/${task.id}/result`, { data: { agentId: "implementer", ok: true, summary: "did the thing" } });

    await page.goto("/board");
    await page.locator("#kanbanBody").getByText(task.title).click();

    const drawer = page.locator("#taskDrawer");
    await expect(drawer.locator("#tdMeta")).toContainText("Pending review");
    await expect(drawer.locator("#tdActions")).toContainText("Automated review in progress (attempt 3 of 6).");
    await expect(drawer.getByRole("button", { name: "Merge" })).toHaveCount(0);
    await expect(drawer.getByRole("button", { name: "Discard" })).toHaveCount(0);
    await expect(drawer.getByRole("button", { name: "Mark done" })).toHaveCount(0);
    await expect(drawer.getByRole("button", { name: "Mark failed" })).toHaveCount(0);

    // Regression: an unrelated SSE event (another task appearing) must
    // not flicker the indicator or reveal a review-gate button — see the
    // 1363de5/35ab0a5 drawerLastResult fix this reuses (renderDrawerActions
    // reads this branch straight off `task`, never off the cached result,
    // so there's no async window for it to render wrong in).
    await request.post("/tasks", { data: { title: `Unrelated ${Date.now()}`, body: "x", labels: [], repo: "/tmp/wissel-e2e-repo" } });
    await page.waitForTimeout(500);
    await expect(drawer.locator("#tdActions")).toContainText("Automated review in progress (attempt 3 of 6).");
    await expect(drawer.getByRole("button", { name: "Mark done" })).toHaveCount(0);
  });

  // Real bug, fixed live: a superseded card (a pushback re-attempt
  // replaced it) keeps its old `pending-review` status forever by
  // design (TaskCard.supersededBy), but nothing used to exclude it from
  // the kanban/stats — a lineage that had already moved on still showed
  // a stale duplicate sitting in "Pending review" next to whatever
  // attempt actually succeeded it.
  test("a superseded card never shows in the kanban board or the stat counts, even though its status is untouched", async ({ page, request }) => {
    const title = `Superseded test ${Date.now()}`;
    const created = await request.post("/tasks", { data: { title, body: "x", labels: ["code"], repo: "/tmp/wissel-e2e-repo" } });
    const originalId = (await created.json()).id as string;
    await request.post(`/tasks/${originalId}/result`, { data: { agentId: "implementer", ok: true, summary: "attempt 1" } });

    const afterImpl = await (await request.get("/tasks")).json();
    const reviewer = afterImpl.find((t: { parentTaskId?: string }) => t.parentTaskId === originalId);
    await request.post(`/tasks/${reviewer.id}/decision`, {
      data: {
        matchedTags: ["review"], candidates: [{ agentId: "reviewer", score: 1, reason: "tag overlap 1/1" }],
        selected: "reviewer", confident: true, strategy: "rule", reason: "tag overlap 1/1", decidedAt: new Date().toISOString(),
      },
    });
    // changes_requested, under the pushback limit — spawns a fresh
    // attempt and marks `originalId` supersededBy, status left untouched
    // (still "pending-review") per handleReviewVerdict's own contract.
    await request.post(`/tasks/${reviewer.id}/result`, {
      data: { agentId: "reviewer", ok: true, summary: "requested changes", verdict: "changes_requested", reviewFeedback: "not quite right" },
    });

    const original = await (await request.get(`/tasks/${originalId}`)).json();
    expect(original.status).toBe("pending-review");
    const pushbackId = original.supersededBy as string;
    expect(pushbackId).toBeDefined();
    // The pushback attempt itself isn't auto-dispatched in this fixture
    // (no sweep loop running) — it sits in "inbox" until routed, which
    // is fine: this test is about the *original* never cluttering its
    // old column, not about driving the whole lineage further.
    const pushback = await (await request.get(`/tasks/${pushbackId}`)).json();
    expect(pushback.status).toBe("inbox");

    await page.goto("/board");

    // The superseded original's own exact title never shows up in the
    // "Pending review" column specifically — not "zero matches anywhere
    // on the board" (the live pushback attempt and its own "Review: ..."
    // follow-up legitimately share the substring and sit in other
    // columns), just excluded from the one column its stale status
    // would otherwise place it in.
    const pendingReviewCol = page.locator("#kanbanBody .kcol", { has: page.locator("h3", { hasText: "Pending review" }) });
    await expect(pendingReviewCol.locator(".kcard", { hasText: title })).toHaveCount(0);

    // The stat tile agrees — its count excludes the superseded original
    // too, matching what the API itself reports once filtered the same way.
    const allTasks = await (await request.get("/tasks")).json();
    const realPendingReviewCount = allTasks.filter((t: { status: string; supersededBy?: string }) => t.status === "pending-review" && !t.supersededBy).length;
    const statTile = page.locator("#stats .stat", { has: page.locator(".l", { hasText: "Pending review" }) });
    await expect(statTile.locator(".n")).toHaveText(String(realPendingReviewCount));

    // It isn't hidden entirely, though — it has a dedicated home: the
    // "Superseded" bucket, styled distinctly (dashed border, struck
    // through title) so it reads as history, not a live card.
    const supersededCol = page.locator("#kanbanBody .kcol", { has: page.locator("h3", { hasText: "Superseded" }) });
    const supersededCard = supersededCol.locator(".kcard", { hasText: title });
    await expect(supersededCard).toHaveCount(1);
    await expect(supersededCard).toHaveClass(/superseded/);
  });

  test("an escalated task renders its full round-by-round timeline and the three resolution actions", async ({ page, request }) => {
    const escalated = await driveToEscalated(request, `Escalation test ${Date.now()}`, "/tmp/wissel-e2e-repo");
    expect(escalated).toBeDefined();

    await page.goto("/board");
    await page.locator("#kanbanBody").getByText(escalated.title).click();

    const drawer = page.locator("#taskDrawer");
    await expect(drawer.locator("#tdMeta")).toContainText("Escalated");

    // All 6 rounds present, in order, each with its own feedback text —
    // the "scrollable round-by-round timeline" the card asks for, not
    // just the raw joined string dumped into one block.
    const timeline = drawer.locator("#tdEscalation");
    await expect(timeline).toBeVisible();
    const rounds = timeline.locator(".escalation-round");
    await expect(rounds).toHaveCount(6);
    for (let i = 1; i <= 6; i++) {
      await expect(rounds.nth(i - 1).locator(".er-head")).toHaveText(`Attempt ${i}`);
      await expect(rounds.nth(i - 1).locator(".er-feedback")).toHaveText(`round ${i}: still not right`);
    }

    // The three human-resolution actions, replacing Merge/Discard/Mark-
    // done for this status — see renderDrawerActions' escalated branch
    // for the Subtask D endpoint contract these call.
    await expect(drawer.getByRole("button", { name: "Approve anyway" })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Abandon" })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Mark done" })).toHaveCount(0);
    await expect(drawer.getByRole("button", { name: "Mark failed" })).toHaveCount(0);

    // Regression: unrelated board activity must not disturb the timeline
    // or the action buttons — same flicker hazard the worktree
    // Merge/Discard test above guards, for these new states.
    await request.post("/tasks", { data: { title: `Unrelated ${Date.now()}`, body: "x", labels: [], repo: "/tmp/wissel-e2e-repo" } });
    await page.waitForTimeout(500);
    await expect(rounds).toHaveCount(6);
    await expect(drawer.getByRole("button", { name: "Approve anyway" })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Abandon" })).toBeVisible();
  });

  // Regression coverage for the bug found reading Subtask D's and E's
  // diffs side by side: escalationAction() used to fire `fetch(url, {
  // method: "POST" })` with no body at all, but POST
  // /tasks/:id/escalation/approve 400s without a real { actor, reason }
  // JSON body (see server.ts). This drives a real click through the real
  // browser dialogs (window.confirm, then two window.prompt calls) and
  // asserts against the real server response, not just that the button
  // is visible.
  test("Approve anyway collects actor/reason via dialogs, POSTs them, and moves the task to review", async ({ page, request }) => {
    const escalated = await driveToEscalated(request, `Approve test ${Date.now()}`, "/tmp/wissel-e2e-repo");
    expect(escalated).toBeDefined();

    await page.goto("/board");
    await page.locator("#kanbanBody").getByText(escalated.title).click();

    const drawer = page.locator("#taskDrawer");
    await expect(drawer.getByRole("button", { name: "Approve anyway" })).toBeVisible();

    const dialogTypes: string[] = [];
    page.on("dialog", async (dialog) => {
      dialogTypes.push(dialog.type());
      if (dialog.type() === "confirm") await dialog.accept();
      else if (dialogTypes.length === 2) await dialog.accept("QA Human");
      else await dialog.accept("Looks fine despite the rejected rounds, shipping as-is.");
    });

    await drawer.getByRole("button", { name: "Approve anyway" }).click();

    // Proves all three dialogs actually fired (confirm, then the two
    // prompts) rather than the click short-circuiting somewhere.
    await expect.poll(() => dialogTypes).toEqual(["confirm", "prompt", "prompt"]);

    await expect(drawer.locator("#tdMeta")).toContainText("Review");
    await expect(drawer.locator("#tdActionError")).toBeHidden();

    const tasksAfter = await (await request.get("/tasks")).json();
    const approved = tasksAfter.find((t: { id: string }) => t.id === escalated.id);
    expect(approved.status).toBe("review");
  });

  // Cancelling either prompt must abort the request entirely — never a
  // partial POST with a missing actor or reason.
  test("Approve anyway sends nothing if the reason prompt is cancelled", async ({ page, request }) => {
    const escalated = await driveToEscalated(request, `Approve cancel test ${Date.now()}`, "/tmp/wissel-e2e-repo");
    expect(escalated).toBeDefined();

    await page.goto("/board");
    await page.locator("#kanbanBody").getByText(escalated.title).click();

    const drawer = page.locator("#taskDrawer");
    let promptCount = 0;
    page.on("dialog", async (dialog) => {
      if (dialog.type() === "confirm") { await dialog.accept(); return; }
      promptCount++;
      if (promptCount === 1) await dialog.accept("QA Human");
      else await dialog.dismiss(); // cancel the reason prompt
    });

    await drawer.getByRole("button", { name: "Approve anyway" }).click();
    await expect.poll(() => promptCount).toBe(2);
    await page.waitForTimeout(300);

    await expect(drawer.locator("#tdMeta")).toContainText("Escalated");
    const tasksAfter = await (await request.get("/tasks")).json();
    const stillEscalated = tasksAfter.find((t: { id: string }) => t.id === escalated.id);
    expect(stillEscalated.status).toBe("escalated");
  });

  // Same underlying bug, the Retry button: POST
  // /tasks/:id/escalation/retry 400s without a real { body } — the
  // human-edited restart instructions. This exercises the inline
  // textarea board.html now shows instead of a single-line window.prompt
  // (multi-line restart instructions don't fit a prompt() well), a real
  // click into it, and asserts against the real server response.
  test("Retry collects the restart body from the inline form and starts a fresh lineage", async ({ page, request }) => {
    const escalated = await driveToEscalated(request, `Retry test ${Date.now()}`, "/tmp/wissel-e2e-repo");
    expect(escalated).toBeDefined();

    await page.goto("/board");
    await page.locator("#kanbanBody").getByText(escalated.title).click();

    const drawer = page.locator("#taskDrawer");
    const retryForm = drawer.locator("#tdRetryForm");
    await expect(retryForm).toBeHidden();

    await drawer.getByRole("button", { name: "Retry" }).click();
    await expect(retryForm).toBeVisible();

    const restartBody = "Try a narrower fix this time: only touch the parser, not the renderer.";
    await retryForm.locator("#tdRetryBody").fill(restartBody);
    await retryForm.getByRole("button", { name: "Send retry" }).click();

    await expect(retryForm).toBeHidden();
    await expect(drawer.locator("#tdActionError")).toBeHidden();

    const tasksAfter = await (await request.get("/tasks")).json();
    const oldTask = tasksAfter.find((t: { id: string }) => t.id === escalated.id);
    expect(oldTask.supersededBy).toBeTruthy();

    const nextAttempt = tasksAfter.find((t: { id: string }) => t.id === oldTask.supersededBy);
    expect(nextAttempt).toBeDefined();
    expect(nextAttempt.title).toBe(escalated.title);
    expect(nextAttempt.body).toBe(restartBody);
    expect(nextAttempt.pushbackCount).toBe(0);
    expect(nextAttempt.reviewLineageId).toBeTruthy();
    expect(nextAttempt.reviewLineageId).not.toBe(escalated.reviewLineageId);
  });

  // Empty/whitespace-only restart instructions must never reach the
  // server as a truthy-looking body — mirrors the 400 server.ts returns
  // for a missing body, caught client-side instead of round-tripping.
  test("Retry refuses to send an empty restart body", async ({ page, request }) => {
    const escalated = await driveToEscalated(request, `Retry empty test ${Date.now()}`, "/tmp/wissel-e2e-repo");
    expect(escalated).toBeDefined();

    await page.goto("/board");
    await page.locator("#kanbanBody").getByText(escalated.title).click();

    const drawer = page.locator("#taskDrawer");
    await drawer.getByRole("button", { name: "Retry" }).click();

    const retryForm = drawer.locator("#tdRetryForm");
    await retryForm.locator("#tdRetryBody").fill("   ");
    await retryForm.getByRole("button", { name: "Send retry" }).click();

    await expect(drawer.locator("#tdActionError")).toContainText("Restart instructions are required.");
    await expect(retryForm).toBeVisible();

    const tasksAfter = await (await request.get("/tasks")).json();
    const stillEscalated = tasksAfter.find((t: { id: string }) => t.id === escalated.id);
    expect(stillEscalated.status).toBe("escalated");
    expect(stillEscalated.supersededBy).toBeFalsy();
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

  test("an empty column collapses to just its header instead of reserving full card space", async ({ page }) => {
    await page.goto("/board");
    // "No match" is reliably empty in a fresh fixture board — nothing in
    // this file's other tests routes a task there without a human/sweep
    // step this fixture never runs.
    const noMatchCol = page.locator("#kanbanBody .kcol", { has: page.locator("h3", { hasText: "No match" }) });
    await expect(noMatchCol).toHaveClass(/kcol-empty/);
    await expect(noMatchCol.locator(".kcard")).toHaveCount(0);

    // A column that does have cards (Board view's own default state
    // always has at least one, per the earlier "is the default view..."
    // test) never gets the collapsed treatment.
    const doneCol = page.locator("#kanbanBody .kcol", { has: page.locator("h3", { hasText: /^Done/ }) });
    await expect(doneCol).not.toHaveClass(/kcol-empty/);
  });
});

test.describe("Swimlanes view", () => {
  test("switches from Board and back, showing a lane per standalone task with no relations to tag", async ({ page, request }) => {
    const title = `Standalone swimlane test ${Date.now()}`;
    await request.post("/tasks", { data: { title, body: "x", labels: [], repo: "/tmp/wissel-e2e-repo" } });

    await page.goto("/board");
    await page.getByRole("button", { name: "Swimlanes", exact: true }).click();
    await expect(page.getByRole("button", { name: "Swimlanes", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#swimlanesPanel")).toBeVisible();
    await expect(page.locator("#boardPanel")).toBeHidden();

    const lane = page.locator(".swimlane", { has: page.locator(".swimlane-head", { hasText: title }) });
    await expect(lane).toBeVisible();
    await expect(lane.locator(".swimlane-head .sl-count")).toHaveText("1 card");
    await expect(lane.locator(".slcard")).toHaveCount(1);
    await expect(lane.locator(".slcard .sl-relations")).toHaveCount(0); // nothing to tag — no parent, no dependsOn

    await page.getByRole("button", { name: "Board", exact: true }).click();
    await expect(page.locator("#boardPanel")).toBeVisible();
    await expect(page.locator("#swimlanesPanel")).toBeHidden();
  });

  test("a follow-up lineage (implementer + auto-created reviewer) shares one lane, tagged with the relationship", async ({ page, request }) => {
    const title = `Lineage swimlane test ${Date.now()}`;
    const created = await request.post("/tasks", { data: { title, body: "x", labels: ["code"], repo: "/tmp/wissel-e2e-repo" } });
    const originalId = (await created.json()).id as string;
    await request.post(`/tasks/${originalId}/result`, { data: { agentId: "implementer", ok: true, summary: "did the thing" } });

    await page.goto("/board");
    await page.getByRole("button", { name: "Swimlanes", exact: true }).click();

    const lane = page.locator(".swimlane", { has: page.locator(".swimlane-head", { hasText: title }) });
    await expect(lane.locator(".swimlane-head .sl-count")).toHaveText("2 cards");
    await expect(lane.locator(".slcard")).toHaveCount(2);
    // The reviewer follow-up's own card carries the "follows up on"
    // relation tag pointing back at the implementer card that spawned it.
    const reviewerCard = lane.locator(".slcard", { hasText: `Review: ${title}` });
    await expect(reviewerCard.locator(".sl-tag")).toContainText(title);
  });

  test("dependsOn renders as a relation tag naming the depended-on task's title and status", async ({ page, request }) => {
    const depTitle = `Dependency target ${Date.now()}`;
    const dep = await request.post("/tasks", { data: { title: depTitle, body: "x", labels: [], repo: "/tmp/wissel-e2e-repo" } });
    const depId = (await dep.json()).id as string;

    const title = `Blocked task ${Date.now()}`;
    await request.post("/tasks", { data: { title, body: "x", labels: [], repo: "/tmp/wissel-e2e-repo", dependsOn: [depId] } });

    await page.goto("/board");
    await page.getByRole("button", { name: "Swimlanes", exact: true }).click();

    // Two separate lanes — dependsOn is a blocking relationship, not a
    // lineage one, so it doesn't merge the two into the same lane.
    const blockedLane = page.locator(".swimlane", { has: page.locator(".swimlane-head", { hasText: title }) });
    await expect(blockedLane.locator(".slcard .sl-tag")).toContainText(depTitle);
    await expect(blockedLane.locator(".slcard .sl-tag")).toHaveAttribute("title", new RegExp(depTitle));
  });
});
