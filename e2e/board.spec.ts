import { readFile } from "node:fs/promises";
import { test, expect, type APIRequestContext } from "@playwright/test";

/** Same disposable tmp path playwright.config.ts's webServer.command
 *  seeds from e2e/fixtures/harnesses.yaml before every run — read
 *  directly off disk here (not via any API) so the model-selection
 *  tests below can assert on the real persisted YAML, not just the
 *  in-memory pool's view of it. */
const HARNESSES_FIXTURE_PATH = "/tmp/wissel-e2e-harnesses.yaml";

/** Same disposable tmp path for the MCP-servers fixture
 *  (e2e/fixtures/mcp-servers.yaml), seeded the same way by
 *  playwright.config.ts's webServer.command. */
const MCP_SERVERS_FIXTURE_PATH = "/tmp/wissel-e2e-mcp-servers.yaml";

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

    await page.getByRole("link", { name: "Memory", exact: true }).click();
    await expect(page.getByRole("link", { name: "Memory", exact: true })).toHaveAttribute("aria-current", "page");
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

    await page.getByRole("link", { name: "Board", exact: true }).click();
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
    await page.getByRole("link", { name: "Memory", exact: true }).click();

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
    await page.getByRole("link", { name: "Memory", exact: true }).click();

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

  test("is the default view and shows task-by-status and status stats; both fleet boxes are on Agents & skills", async ({ page }) => {
    await page.goto("/board");

    await expect(page.getByRole("link", { name: "Board", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("button", { name: "Lanes", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#boardPanel")).toBeVisible();
    await expect(page.locator("#newTaskPanel")).toBeHidden();

    // Status stat strip covers every real status, in order — including
    // pending-review/escalated (the automated-reviewer review lifecycle;
    // see orchestrator.ts's finishResult/handleReviewVerdict).
    const statLabels = page.locator("#stats .l");
    await expect(statLabels).toHaveText([
      "Inbox", "Ready", "Running", "Dispatched", "Pending review", "Reviewing", "Review", "Escalated", "Done", "Failed", "No match", "Superseded",
    ]);

    // Task-by-status comes first; the fleet is setup, not work, so it's
    // off the Board view entirely (docs/SDD-ui-cleanup.md §3.1, T6).
    const kanbanTop = await page.locator("#kanbanBody").boundingBox();
    const statsTop = await page.locator("#stats").boundingBox();
    expect(kanbanTop!.y).toBeLessThan(statsTop!.y);
    await expect(page.locator("#agentsBox")).toBeHidden();
    await expect(page.locator("#skillsBox")).toBeHidden();

    await page.getByRole("link", { name: "Agents & skills", exact: true }).click();
    await expect(page).toHaveURL(/#\/setup\/agents$/);
    await expect(page.locator("#boardPanel")).toBeHidden();

    // Fleet boxes are populated from the real manifest, not a mock.
    await expect(page.locator("#agentsBox")).toContainText("triager");
    await expect(page.locator("#agentsBox")).toContainText("implementer");
    await expect(page.locator("#agentsBox .tier-chip.write").first()).toContainText("handed off");
    await expect(page.locator("#skillsBox")).toContainText("lint-fixer");
    await expect(page.locator("#agentsCount")).toContainText("10 agents");
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

    await page.goto("/board#/setup/agents");
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
    await page.locator(`#kanbanBody .kcard[data-task-id="${task.id}"]`).click();

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
    await page.locator(`#kanbanBody .kcard[data-task-id="${task.id}"]`).click();

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
    await page.locator(`#kanbanBody .kcard[data-task-id="${task.id}"]`).click();

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
    await page.locator(`#kanbanBody .kcard[data-task-id="${task.id}"]`).click();

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
    await page.locator(`#kanbanBody .kcard[data-task-id="${task.id}"]`).click();

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
    await page.locator(`#kanbanBody .kcard[data-task-id="${escalated.id}"]`).click();

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
    await page.locator(`#kanbanBody .kcard[data-task-id="${escalated.id}"]`).click();

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
    await page.locator(`#kanbanBody .kcard[data-task-id="${escalated.id}"]`).click();

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
    await page.locator(`#kanbanBody .kcard[data-task-id="${escalated.id}"]`).click();

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
    await page.locator(`#kanbanBody .kcard[data-task-id="${escalated.id}"]`).click();

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

  // Drives a task straight to `review` with a `pendingMcpApproval` set,
  // purely over HTTP — `POST /tasks/:id/result` runs the exact same
  // `finishResult` logic a live agent's report carrying
  // `mcpApprovalRequest` would (see src/core/orchestrator.ts), so this
  // reaches the real state, not a hand-rolled stand-in for it. Mirrors
  // driveToEscalated's own approach immediately above.
  async function driveToPendingMcpApproval(request: APIRequestContext, title: string, repo: string) {
    const created = await request.post("/tasks", { data: { title, body: "x", labels: ["intake"], repo } });
    const taskId = (await created.json()).id as string;
    await request.post(`/tasks/${taskId}/result`, {
      data: {
        agentId: "triager",
        ok: true,
        summary: "described the call instead of making it",
        mcpApprovalRequest: { server: "slack", tool: "send_message", args: { text: "deploy finished" }, reason: "the team asked to be notified" },
      },
    });
    const tasks = await (await request.get("/tasks")).json();
    return tasks.find((t: { id: string }) => t.id === taskId);
  }

  test("a task with a pending MCP approval request shows the requested call and Approve/Deny instead of Merge/Discard/Mark-done", async ({ page, request }) => {
    const pending = await driveToPendingMcpApproval(request, `MCP approval test ${Date.now()}`, "/tmp/wissel-e2e-repo");
    expect(pending).toBeDefined();
    expect(pending.status).toBe("review");

    await page.goto("/board");
    await page.locator(`#kanbanBody .kcard[data-task-id="${pending.id}"]`).click();

    const drawer = page.locator("#taskDrawer");
    await expect(drawer.locator("#tdMeta")).toContainText("Review");

    const section = drawer.locator("#tdMcpApproval");
    await expect(section).toBeVisible();
    await expect(section).toContainText("slack");
    await expect(section).toContainText("send_message");
    await expect(section).toContainText("deploy finished");
    await expect(section).toContainText("the team asked to be notified");

    await expect(drawer.getByRole("button", { name: "Approve call" })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Deny" })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Merge" })).toHaveCount(0);
    await expect(drawer.getByRole("button", { name: "Discard" })).toHaveCount(0);
    await expect(drawer.getByRole("button", { name: "Mark done" })).toHaveCount(0);
    await expect(drawer.getByRole("button", { name: "Mark failed" })).toHaveCount(0);
  });

  test("Approve call creates a real follow-up task scoped to exactly the one call, and resolves the panel", async ({ page, request }) => {
    const pending = await driveToPendingMcpApproval(request, `MCP approve test ${Date.now()}`, "/tmp/wissel-e2e-repo");
    expect(pending).toBeDefined();

    await page.goto("/board");
    await page.locator(`#kanbanBody .kcard[data-task-id="${pending.id}"]`).click();
    const drawer = page.locator("#taskDrawer");

    page.on("dialog", (dialog) => dialog.accept());
    await drawer.getByRole("button", { name: "Approve call" }).click();

    await expect(drawer.locator("#tdMcpApprovalSection")).toBeHidden();
    await expect(drawer.locator("#tdActionError")).toBeHidden();

    const tasksAfter = await (await request.get("/tasks")).json();
    const original = tasksAfter.find((t: { id: string }) => t.id === pending.id);
    expect(original.status).toBe("done");
    expect(original.supersededBy).toBeTruthy();

    // Assert the actual created task's grant, not just that a request
    // fired — scoped to exactly the one approved server+tool.
    const followUp = tasksAfter.find((t: { id: string }) => t.id === original.supersededBy);
    expect(followUp).toBeDefined();
    expect(followUp.mcpAccessOverride).toEqual([{ server: "slack", tools: ["send_message"] }]);
  });

  test("Deny moves the task to failed with no follow-up task created", async ({ page, request }) => {
    const pending = await driveToPendingMcpApproval(request, `MCP deny test ${Date.now()}`, "/tmp/wissel-e2e-repo");
    expect(pending).toBeDefined();

    const before = await (await request.get("/tasks")).json();

    await page.goto("/board");
    await page.locator(`#kanbanBody .kcard[data-task-id="${pending.id}"]`).click();
    const drawer = page.locator("#taskDrawer");

    page.on("dialog", (dialog) => dialog.accept());
    await drawer.getByRole("button", { name: "Deny" }).click();

    await expect(drawer.locator("#tdMcpApprovalSection")).toBeHidden();
    await expect(drawer.locator("#tdActionError")).toBeHidden();

    const after = await (await request.get("/tasks")).json();
    expect(after.length).toBe(before.length); // no follow-up task created
    const original = after.find((t: { id: string }) => t.id === pending.id);
    expect(original.status).toBe("failed");
  });

  test("View diff reports a non-git repo honestly instead of an empty diff", async ({ page, request }) => {
    const created = await request.post("/tasks", {
      data: { title: `Diff test ${Date.now()}`, body: "x", labels: [], repo: "/tmp" },
    });
    const task = await created.json();

    await page.goto("/board");
    await page.locator(`#kanbanBody .kcard[data-task-id="${task.id}"]`).click();

    const drawer = page.locator("#taskDrawer");
    await drawer.getByRole("button", { name: "View diff" }).click();
    await expect(drawer.locator("#tdDiffSection")).toContainText("isn't a git working tree");
  });

  // Regression test: "View diff" used to be gated on `result.worktree`
  // (see docs/SDD-mcp-orchestration.md §6 Subtask 4's revision callout),
  // which false-negatived on a reviewer task — its own TaskResult
  // (ReadOnlyExecutor) never carries `worktree`, even though its `repo`
  // points at the implementer's worktree/repo and GET /tasks/:id/diff's
  // own fallback (`result?.worktree?.path ?? task.repo`) can diff it.
  test("View diff stays visible on a reviewer task whose own result has no worktree", async ({ page, request }) => {
    const created = await request.post("/tasks", {
      data: { title: `Reviewer diff test ${Date.now()}`, body: "x", labels: ["code"], repo: "/tmp" },
    });
    const implementerId = (await created.json()).id as string;

    await request.post(`/tasks/${implementerId}/result`, { data: { agentId: "implementer", ok: true, summary: "attempt 1" } });

    const afterImpl = await (await request.get("/tasks")).json();
    const reviewer = afterImpl.find((t: { parentTaskId?: string }) => t.parentTaskId === implementerId);
    expect(reviewer).toBeDefined();

    // Mirrors the real shape a reviewer's own result carries: no
    // `worktree` field at all.
    await request.post(`/tasks/${reviewer.id}/result`, {
      data: { agentId: "reviewer", ok: true, summary: "looks fine", verdict: "approve" },
    });

    await page.goto("/board");
    await page.locator(`#kanbanBody .kcard[data-task-id="${reviewer.id}"]`).click();

    const drawer = page.locator("#taskDrawer");
    await expect(drawer.getByRole("button", { name: "View diff" })).toBeVisible();
  });

  // Deliberately never calls the mutating /enable or /disable endpoints
  // here — the e2e server boots against this repo's real harnesses.yaml
  // (see playwright.config.ts), and which harnesses exist/authenticate
  // is genuinely machine-dependent, unlike the static agents/manifest.yaml
  // every other test in this file reads from. This test only exercises
  // open/close/render — real DOM wiring a syntax check can't catch —
  // without asserting on, or mutating, machine-specific harness content.
  // Was a slide-in panel opened from the board header; it's now the
  // Harnesses setup page (docs/SDD-ui-cleanup.md §3.1), so "closes" means
  // navigating away (sidebar or Back), not X/Escape/overlay.
  test("Harnesses page opens from the sidebar, renders coherently, and hides when you navigate away or go Back", async ({ page }) => {
    await page.goto("/board");

    const panel = page.locator("#harnessPanel");
    await expect(panel).toBeHidden();

    await page.getByRole("link", { name: "Harnesses", exact: true }).click();
    await expect(page).toHaveURL(/#\/setup\/harnesses$/);
    await expect(panel).toBeVisible();
    // The "Available now" strip moved here with it: either real pills or
    // its explicit empty state.
    const pillCount = await page.locator("#harnessStrip .harness-pill").count();
    const stripEmptyCount = await page.locator("#harnessStrip .harness-strip-empty").count();
    expect(pillCount + stripEmptyCount).toBeGreaterThan(0);
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

    await page.getByRole("link", { name: "Board", exact: true }).click();
    await expect(panel).toBeHidden();
    await expect(page.locator("#boardPanel")).toBeVisible();

    await page.goBack();
    await expect(panel).toBeVisible();
    await page.goBack();
    await expect(panel).toBeHidden();
    await expect(page.locator("#boardPanel")).toBeVisible();
  });

  // Unlike the panel-render test above, this one *does* mutate the real
  // file — safely, because playwright.config.ts points WISSEL_HARNESSES_PATH
  // at a disposable tmp copy of e2e/fixtures/harnesses.yaml
  // (e2e-fixture-harness) rather than this repo's own real
  // harnesses.yaml. Drives the actual <select> the real change listener
  // is wired to (renderHarnessPanel), not a route-intercepted stand-in,
  // so this proves the whole client -> POST /harnesses/:id/model ->
  // harness-manifest.ts round trip, including that the fixture's leading
  // comment block survives the yaml Document-API rewrite.
  test("selecting a model for a harness persists it to harnesses.yaml (comments preserved) and reflects after refetch", async ({ page }) => {
    await page.goto("/board#/setup/harnesses");

    const panel = page.locator("#harnessPanel");
    await expect(panel).toBeVisible();

    const select = page.locator("#hmModel-e2e-fixture-harness");
    await expect(select).toBeVisible();
    await expect(select).toHaveValue("");
    await expect(select.locator("option")).toHaveText(["Default (agent's own)", "fixture-model-a", "fixture-model-b"]);

    await select.selectOption("fixture-model-a");
    await expect(select).toHaveValue("fixture-model-a");
    await expect(panel.locator(".hm-error")).toHaveCount(0);

    const written = await readFile(HARNESSES_FIXTURE_PATH, "utf8");
    expect(written).toContain("id: e2e-fixture-harness");
    expect(written).toContain("model: fixture-model-a");
    // The fixture's own explanatory header comment, byte-preserved by
    // setHarnessModel's yaml Document-API round trip (see
    // src/core/harness-manifest.ts) — a plain parse+stringify would have
    // dropped this.
    expect(written).toContain("e2e fixture — playwright.config.ts's webServer.command copies this");

    // Reload — a fresh GET /harnesses on page load, not the optimistic
    // client-side render from the fetch above — still shows the
    // persisted value. The hash keeps the reload on this page.
    await page.reload();
    await expect(page.locator("#harnessPanel")).toBeVisible();
    await expect(page.locator("#hmModel-e2e-fixture-harness")).toHaveValue("fixture-model-a");
  });

  // docs/SDD-agent-harness-preference.md §3.7 (card 2). Every agent row's
  // harness line must match what GET /agents + GET /harnesses say, run
  // through the same render-harness-preference.js the page loads, and the
  // fixture harness's maxConcurrent (e2e/fixtures/harnesses.yaml) must show
  // as active/max in the panel. The expected text is computed inside the
  // page, from the globals the board's own <script> tag defined: importing
  // the module here fails under Playwright, because package.json's
  // "type": "module" makes Node load it as ESM, where its module.exports
  // guard exports nothing.
  test("fleet rows show each agent's harness list from GET /agents + GET /harnesses; the panel shows active/max", async ({ page, request }) => {
    const agents = (await (await request.get("/agents")).json()) as { id: string; kind: string; harnesses?: string[] }[];
    const harnesses = await (await request.get("/harnesses")).json();
    const fixture = harnesses.find((h: { id: string }) => h.id === "e2e-fixture-harness");
    expect(fixture).toMatchObject({ maxConcurrent: 2 });

    await page.goto("/board#/setup/agents");
    const rows = page.locator("#agentsBox .fleet-row");
    await expect(rows.first()).toBeVisible();
    const agentRows = agents.filter((a) => a.kind === "agent");
    expect(agentRows.length).toBeGreaterThan(0);
    const escapeRegExp = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const a of agentRows) {
      const expected = await page.evaluate(
        ([agent, pool]) => (window as unknown as { describeAgentHarnesses: (a: unknown, h: unknown) => { text: string } }).describeAgentHarnesses(agent, pool).text,
        [a, harnesses] as const,
      );
      const row = rows.filter({ has: page.locator(".fleet-id", { hasText: new RegExp("^" + escapeRegExp(a.id) + "$") }) });
      await expect(row.locator(".fleet-harnesses")).toHaveText(expected);
    }

    await page.getByRole("link", { name: "Harnesses", exact: true }).click();
    const fixtureRow = page.locator("#harnessPanel .hm-row").filter({ has: page.locator("#hmModel-e2e-fixture-harness") });
    const capacity = await page.evaluate(
      (h) => (window as unknown as { formatHarnessCapacity: (h: unknown) => string }).formatHarnessCapacity(h),
      fixture,
    );
    await expect(fixtureRow.locator(".hm-row-meta").first()).toHaveText("anthropic-api · " + capacity);
    await expect(fixtureRow.locator(".hm-row-meta").first()).toContainText(/\d+\/2 active/);
  });

  // Real invalid-model rejection, not a route-intercepted stand-in: the
  // dropdown itself can only ever offer options from the harness's own
  // cached availableModels, so an actually-invalid attempt has to come
  // from a stale option outstaying its welcome (e.g. the cache changed
  // out from under an already-rendered panel) — simulated here by
  // appending one extra <option> and selecting it, which fires the exact
  // same real change listener/fetch/server round trip a live race would.
  test("an invalid model attempt surfaces the inline error and leaves harnesses.yaml untouched", async ({ page }) => {
    await page.goto("/board#/setup/harnesses");

    const panel = page.locator("#harnessPanel");
    await expect(panel).toBeVisible();

    const select = page.locator("#hmModel-e2e-fixture-harness");
    await expect(select).toBeVisible();
    // Whatever's actually persisted right now (the prior test in this
    // file already set it to "fixture-model-a") — captured rather than
    // assumed, since this test's own point is that a rejected attempt
    // never changes it, not what its starting value happens to be.
    const originalValue = await select.inputValue();

    const before = await readFile(HARNESSES_FIXTURE_PATH, "utf8");

    await select.evaluate((el: HTMLSelectElement) => {
      const opt = document.createElement("option");
      opt.value = "stale-invalid-model";
      opt.textContent = "stale-invalid-model";
      el.appendChild(opt);
    });
    await select.selectOption("stale-invalid-model");

    await expect(panel.locator(".hm-error")).toContainText(
      'model "stale-invalid-model" is not in the known model list for harness "e2e-fixture-harness"',
    );
    // The select snaps back to whatever's actually persisted (never the
    // rejected stale value) once the error re-render runs.
    await expect(select).toHaveValue(originalValue);

    const after = await readFile(HARNESSES_FIXTURE_PATH, "utf8");
    expect(after).toBe(before);
  });

  // Mirrors the Harnesses page open/render/navigate-away smoke test
  // above, but for the sibling MCP servers page — this one *can* assert
  // on specific content, unlike the harness page's own deliberate
  // abstention, because e2e/fixtures/mcp-servers.yaml is a disposable
  // fixture this suite fully controls, not a developer's real
  // machine-dependent harnesses.yaml.
  test("MCP servers page opens from the sidebar, renders the fixture server and its tools, and hides when you navigate away or go Back", async ({ page }) => {
    await page.goto("/board");

    const panel = page.locator("#mcpPanel");
    await expect(panel).toBeHidden();

    await page.getByRole("link", { name: "MCP servers", exact: true }).click();
    await expect(page).toHaveURL(/#\/setup\/mcp$/);
    await expect(panel).toBeVisible();

    const serverRow = panel.locator(".hm-row", { hasText: "E2E Fixture MCP Server" });
    await expect(serverRow).toBeVisible();
    await expect(serverRow.locator(".hm-toggle")).toHaveText("Disable");

    // Both declared tools render as their own rows with a trust toggle
    // whose label reflects the fixture's own starting trust tier.
    await expect(panel.getByText("read_thing")).toBeVisible();
    await expect(panel.getByText("write_thing")).toBeVisible();
    await expect(panel.locator(".hm-row", { hasText: "read_thing" }).locator(".hm-toggle")).toHaveText("Require approval");
    await expect(panel.locator(".hm-row", { hasText: "write_thing" }).locator(".hm-toggle")).toHaveText("Allow auto");

    await page.getByRole("link", { name: "Harnesses", exact: true }).click();
    await expect(panel).toBeHidden();
    await expect(page.locator("#harnessPanel")).toBeVisible();

    await page.goBack();
    await expect(panel).toBeVisible();
    await page.goBack();
    await expect(panel).toBeHidden();
    await expect(page.locator("#boardPanel")).toBeVisible();
  });

  // Unlike the render-only test above, this one mutates real state —
  // safely, because playwright.config.ts points WISSEL_MCP_SERVERS_PATH
  // at a disposable tmp copy of e2e/fixtures/mcp-servers.yaml rather
  // than any checked-in original. Drives the actual toggle button the
  // real click listener is wired to (not a route-intercepted stand-in),
  // asserting on the real outgoing request — same discipline the
  // harness/project-panel e2e tests already hold, named explicitly in
  // this project's own lessons after a past bug shipped a button wired
  // to nothing.
  test("disabling the fixture MCP server fires the real POST /mcp-servers/:id/disable request and persists", async ({ page }) => {
    await page.goto("/board#/setup/mcp");

    const panel = page.locator("#mcpPanel");
    await expect(panel).toBeVisible();

    const serverRow = panel.locator(".hm-row", { hasText: "E2E Fixture MCP Server" });
    const toggle = serverRow.locator(".hm-toggle");
    await expect(toggle).toHaveText("Disable");

    const [disableResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/mcp-servers/e2e-fixture-mcp/disable") && r.request().method() === "POST"),
      toggle.click(),
    ]);
    expect(disableResponse.status()).toBe(200);

    await expect(toggle).toHaveText("Enable");
    await expect(serverRow).toContainText("disabled by you");

    const onDisk = await readFile(MCP_SERVERS_FIXTURE_PATH, "utf8");
    expect(onDisk).toContain("enabled: false");

    // Re-enable so this test doesn't leave the fixture disabled for
    // whatever e2e test runs after it in the same server lifetime.
    const [enableResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/mcp-servers/e2e-fixture-mcp/enable") && r.request().method() === "POST"),
      toggle.click(),
    ]);
    expect(enableResponse.status()).toBe(200);
    await expect(toggle).toHaveText("Disable");
  });

  // Same real-request discipline as the disable test above, but for the
  // new per-tool trust endpoint this subtask adds — asserts the actual
  // request body (not just that the button is clickable), and asserts
  // the change survives a full page reload reading back from a fresh
  // GET /mcp-servers (i.e. it actually persisted to mcp-servers.yaml,
  // not just an optimistic client-side render).
  test("changing a tool's trust fires the real POST .../tools/:tool/trust request with the right body, and persists across reload", async ({ page }) => {
    await page.goto("/board#/setup/mcp");

    const panel = page.locator("#mcpPanel");
    const toolRow = panel.locator(".hm-row", { hasText: "read_thing" });
    const trustToggle = toolRow.locator(".hm-toggle");
    await expect(trustToggle).toHaveText("Require approval");

    const [trustResponse] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith("/mcp-servers/e2e-fixture-mcp/tools/read_thing/trust") && r.request().method() === "POST",
      ),
      trustToggle.click(),
    ]);
    expect(trustResponse.request().postDataJSON()).toEqual({ trust: "approval-required" });
    expect(trustResponse.status()).toBe(200);

    await expect(trustToggle).toHaveText("Allow auto");

    const onDisk = await readFile(MCP_SERVERS_FIXTURE_PATH, "utf8");
    expect(onDisk).toContain("name: read_thing");
    expect(onDisk).toContain("trust: approval-required");

    // Reload — a fresh GET /mcp-servers on page load, not the optimistic
    // client-side render from the click above — still shows the
    // persisted value.
    await page.reload();
    await expect(page.locator("#mcpPanel")).toBeVisible();
    await expect(page.locator("#mcpPanel .hm-row", { hasText: "read_thing" }).locator(".hm-toggle")).toHaveText("Allow auto");

    // Flip it back so this test doesn't leave the fixture mutated for
    // whatever e2e test runs after it in the same server lifetime.
    const toolRowAfterReload = page.locator("#mcpPanel .hm-row", { hasText: "read_thing" });
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith("/mcp-servers/e2e-fixture-mcp/tools/read_thing/trust") && r.request().method() === "POST",
      ),
      toolRowAfterReload.locator(".hm-toggle").click(),
    ]);
    await expect(toolRowAfterReload.locator(".hm-toggle")).toHaveText("Require approval");
  });

  // The new "Add MCP server" form (docs/SDD-mcp-server-registration.md)
  // — same real-request discipline as every other form-to-endpoint test
  // in this project: asserts the actual outgoing POST /mcp-servers body,
  // not just that the button is clickable (see e2e/projects.spec.ts's
  // own local-folder test for the established convention this mirrors).
  // `/bin/true` is used as the stdio command for the same reason the
  // fixture server does (see e2e/fixtures/mcp-servers.yaml's own
  // comment) — deterministically reachable on every machine and in CI.
  test("adding a new MCP server via the panel's form posts the exact request body and shows the new row", async ({ page }) => {
    await page.goto("/board#/setup/mcp");

    const panel = page.locator("#mcpPanel");
    await expect(panel).toBeVisible();

    await panel.locator("#mcpAddId").fill("e2e-new-stdio");
    await panel.locator("#mcpAddLabel").fill("E2E New Stdio Server");
    await panel.locator("#mcpAddCommand").fill("/bin/true");
    await panel.locator("#mcpAddArgs").fill("--flag, value");
    await panel.locator("#mcpAddToolRowBtn").click();
    await panel.locator(".mcp-add-tool-row .mcp-add-tool-name").fill("do_thing");

    const [addResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/mcp-servers") && r.request().method() === "POST"),
      panel.locator("#mcpAddForm button[type=submit]").click(),
    ]);
    expect(addResponse.request().postDataJSON()).toEqual({
      id: "e2e-new-stdio",
      label: "E2E New Stdio Server",
      transport: { kind: "stdio", command: "/bin/true", args: ["--flag", "value"] },
      tools: [{ name: "do_thing", trust: "approval-required" }],
    });
    expect(addResponse.status()).toBe(201);

    const newRow = panel.locator(".hm-row", { hasText: "E2E New Stdio Server" });
    await expect(newRow).toBeVisible();
    await expect(panel.getByText("do_thing")).toBeVisible();

    // Reload and confirm the new server survives a real GET
    // /mcp-servers, not just the optimistic client-side render.
    await page.reload();
    await expect(page.locator("#mcpPanel")).toBeVisible();
    await expect(page.locator("#mcpPanel .hm-row", { hasText: "E2E New Stdio Server" })).toBeVisible();

    const onDisk = await readFile(MCP_SERVERS_FIXTURE_PATH, "utf8");
    expect(onDisk).toContain("id: e2e-new-stdio");
  });

  test("submitting the add-server form with a blank required field shows an inline error and sends no request", async ({ page }) => {
    await page.goto("/board#/setup/mcp");

    const panel = page.locator("#mcpPanel");
    await panel.locator("#mcpAddId").fill("e2e-incomplete");
    // Label deliberately left blank.

    let sawRequest = false;
    page.on("request", (r) => {
      if (r.url().endsWith("/mcp-servers") && r.method() === "POST") sawRequest = true;
    });

    await panel.locator("#mcpAddForm button[type=submit]").click();
    await expect(panel.locator("#mcpAddError")).toBeVisible();
    await expect(panel.locator("#mcpAddError")).toHaveText("Label is required.");
    expect(sawRequest).toBe(false);
  });

  test("submitting the add-server form with an id that's already registered renders the endpoint's error inline", async ({ page }) => {
    await page.goto("/board#/setup/mcp");

    const panel = page.locator("#mcpPanel");
    await panel.locator("#mcpAddId").fill("e2e-fixture-mcp");
    await panel.locator("#mcpAddLabel").fill("Duplicate Attempt");
    await panel.locator("#mcpAddCommand").fill("/bin/true");

    await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/mcp-servers") && r.request().method() === "POST"),
      panel.locator("#mcpAddForm button[type=submit]").click(),
    ]);

    await expect(panel.locator("#mcpAddError")).toBeVisible();
    await expect(panel.locator("#mcpAddError")).toContainText("already registered");
  });

  test("an empty column collapses to just its header instead of reserving full card space", async ({ page, request }) => {
    // Drives its own task to "done" rather than relying on some earlier
    // test in this file happening to have left one behind — the server
    // backing this whole spec file shares one long-lived in-memory DB
    // (see playwright.config.ts's WISSEL_DB_PATH), so state really does
    // accumulate across tests, but asserting against that accumulation
    // makes this test's pass/fail depend on execution order instead of
    // on the thing it's actually testing. Reported by review as
    // reproducing in total isolation (run alone, no earlier test's
    // leftover Done task to lean on) — this branch's sandbox has no
    // Chromium/subprocess access to re-run that isolation check directly.
    const created = await request.post("/tasks", {
      data: { title: `Done column test ${Date.now()}`, body: "x", labels: [], repo: "/tmp/wissel-e2e-repo" },
    });
    const task = await created.json();
    await request.post(`/tasks/${task.id}/move`, { data: { status: "done" } });

    await page.goto("/board");
    // "No match" is reliably empty in a fresh fixture board — nothing in
    // this file's other tests routes a task there without a human/sweep
    // step this fixture never runs.
    const noMatchCol = page.locator("#kanbanBody .kcol", { has: page.locator("h3", { hasText: "No match" }) });
    await expect(noMatchCol).toHaveClass(/kcol-empty/);
    await expect(noMatchCol.locator(".kcard")).toHaveCount(0);

    // A column that does have cards never gets the collapsed treatment.
    const doneCol = page.locator("#kanbanBody .kcol", { has: page.locator("h3", { hasText: /^Done/ }) });
    await expect(doneCol).not.toHaveClass(/kcol-empty/);
  });

  test("a reviewer task actually running lands in its own Reviewing column, not the generic Running one", async ({ page, request }) => {
    const title = `Reviewing column test ${Date.now()}`;
    const created = await request.post("/tasks", { data: { title, body: "x", labels: ["code"], repo: "/tmp/wissel-e2e-repo" } });
    const implementerId = (await created.json()).id as string;
    await request.post(`/tasks/${implementerId}/result`, { data: { agentId: "implementer", ok: true, summary: "did the thing" } });

    const afterImpl = await (await request.get("/tasks")).json();
    const reviewer = afterImpl.find((t: { parentTaskId?: string }) => t.parentTaskId === implementerId);
    await request.post(`/tasks/${reviewer.id}/decision`, {
      data: {
        matchedTags: ["review"], candidates: [{ agentId: "reviewer", score: 1, reason: "tag overlap 1/1" }],
        selected: "reviewer", confident: true, strategy: "rule", reason: "tag overlap 1/1", decidedAt: new Date().toISOString(),
      },
    });
    // Its raw status is "running" the whole time it's actually being
    // worked — same as any other agent's in-flight task. The Reviewing
    // column exists purely to tell this apart from those at a glance.
    await request.post(`/tasks/${reviewer.id}/move`, { data: { status: "running" } });

    await page.goto("/board");

    const reviewingCol = page.locator("#kanbanBody .kcol", { has: page.locator("h3", { hasText: "Reviewing" }) });
    await expect(reviewingCol.locator(".kcard", { hasText: `Review: ${title}` })).toHaveCount(1);

    // Not double-counted in the generic Running column.
    const runningCol = page.locator("#kanbanBody .kcol", { has: page.locator("h3", { hasText: /^Running/ }) });
    await expect(runningCol.locator(".kcard", { hasText: `Review: ${title}` })).toHaveCount(0);

    const statTile = page.locator("#stats .stat", { has: page.locator(".l", { hasText: "Reviewing" }) });
    await expect(statTile.locator(".n")).toHaveText("1");
  });
});

test.describe("Swimlanes view", () => {
  test("switches from Board and back, showing a lane per standalone task with no relations to tag", async ({ page, request }) => {
    const title = `Standalone swimlane test ${Date.now()}`;
    await request.post("/tasks", { data: { title, body: "x", labels: [], repo: "/tmp/wissel-e2e-repo" } });

    await page.goto("/board");
    // Swimlanes is the Board page's "By feature" view (docs/SDD-ui-cleanup.md §3.1).
    await page.getByRole("button", { name: "By feature", exact: true }).click();
    await expect(page.getByRole("button", { name: "By feature", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Lanes", exact: true })).toHaveAttribute("aria-pressed", "false");
    await expect(page).toHaveURL(/#\/board\/features$/);
    await expect(page.getByRole("link", { name: "Board", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#swimlanesPanel")).toBeVisible();
    await expect(page.locator("#boardPanel")).toBeHidden();

    const lane = page.locator(".swimlane", { has: page.locator(".swimlane-head", { hasText: title }) });
    await expect(lane).toBeVisible();
    await expect(lane.locator(".swimlane-head .sl-count")).toHaveText("1 card");
    await expect(lane.locator(".slcard")).toHaveCount(1);
    await expect(lane.locator(".slcard .sl-relations")).toHaveCount(0); // nothing to tag — no parent, no dependsOn

    // Reload keeps the By feature view (it's in the hash), then Lanes goes back.
    await page.reload();
    await expect(page.locator("#swimlanesPanel")).toBeVisible();
    await page.getByRole("button", { name: "Lanes", exact: true }).click();
    await expect(page.locator("#boardPanel")).toBeVisible();
    await expect(page.locator("#swimlanesPanel")).toBeHidden();
  });

  test("a follow-up lineage (implementer + auto-created reviewer) shares one lane, tagged with the relationship", async ({ page, request }) => {
    const title = `Lineage swimlane test ${Date.now()}`;
    const created = await request.post("/tasks", { data: { title, body: "x", labels: ["code"], repo: "/tmp/wissel-e2e-repo" } });
    const originalId = (await created.json()).id as string;
    await request.post(`/tasks/${originalId}/result`, { data: { agentId: "implementer", ok: true, summary: "did the thing" } });

    await page.goto("/board");
    await page.getByRole("button", { name: "By feature", exact: true }).click();

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
    await page.getByRole("button", { name: "By feature", exact: true }).click();

    // Two separate lanes — dependsOn is a blocking relationship, not a
    // lineage one, so it doesn't merge the two into the same lane.
    const blockedLane = page.locator(".swimlane", { has: page.locator(".swimlane-head", { hasText: title }) });
    await expect(blockedLane.locator(".slcard .sl-tag")).toContainText(depTitle);
    await expect(blockedLane.locator(".slcard .sl-tag")).toHaveAttribute("title", new RegExp(depTitle));
  });

  test("a lane with an actively-running card sorts above an all-idle lane", async ({ page, request }) => {
    // Created first, so without active-first sorting it would naturally
    // render above the active one below (insertion/creation order).
    const idleTitle = `Idle lane ${Date.now()}`;
    await request.post("/tasks", { data: { title: idleTitle, body: "x", labels: [], repo: "/tmp/wissel-e2e-repo" } });

    const activeTitle = `Active lane ${Date.now()}`;
    const created = await request.post("/tasks", { data: { title: activeTitle, body: "x", labels: ["code"], repo: "/tmp/wissel-e2e-repo" } });
    const implementerId = (await created.json()).id as string;
    await request.post(`/tasks/${implementerId}/result`, { data: { agentId: "implementer", ok: true, summary: "did the thing" } });
    const afterImpl = await (await request.get("/tasks")).json();
    const reviewer = afterImpl.find((t: { parentTaskId?: string }) => t.parentTaskId === implementerId);
    await request.post(`/tasks/${reviewer.id}/decision`, {
      data: {
        matchedTags: ["review"], candidates: [{ agentId: "reviewer", score: 1, reason: "tag overlap 1/1" }],
        selected: "reviewer", confident: true, strategy: "rule", reason: "tag overlap 1/1", decidedAt: new Date().toISOString(),
      },
    });
    await request.post(`/tasks/${reviewer.id}/move`, { data: { status: "running" } });

    await page.goto("/board");
    await page.getByRole("button", { name: "By feature", exact: true }).click();

    const laneHeads = page.locator("#swimlanesBody .swimlane-head");
    const idleIndex = await laneHeads.filter({ hasText: idleTitle }).evaluate((el) =>
      Array.prototype.indexOf.call(el.closest("#swimlanesBody")!.querySelectorAll(".swimlane-head"), el),
    );
    const activeIndex = await laneHeads.filter({ hasText: activeTitle }).evaluate((el) =>
      Array.prototype.indexOf.call(el.closest("#swimlanesBody")!.querySelectorAll(".swimlane-head"), el),
    );
    expect(activeIndex).toBeLessThan(idleIndex);
  });
});

test.describe("Archive tab", () => {
  test("archiving a task from its drawer removes it from Board and Swimlanes, and it shows up in the Archive tab", async ({ page, request }) => {
    const title = `Drawer archive test ${Date.now()}`;
    const created = await request.post("/tasks", { data: { title, body: "x", labels: [], repo: "/tmp/wissel-e2e-repo" } });
    const task = await created.json();

    await page.goto("/board");
    await page.locator(`#kanbanBody .kcard[data-task-id="${task.id}"]`).click();

    const drawer = page.locator("#taskDrawer");
    await expect(drawer.getByRole("button", { name: "Archive", exact: true })).toBeVisible();

    page.once("dialog", (dialog) => dialog.accept());
    await drawer.getByRole("button", { name: "Archive", exact: true }).click();

    // The drawer stays open on the same task (archiving never closes
    // it) and now offers Unarchive instead, tagged "archived" in the
    // meta row.
    await expect(drawer.getByRole("button", { name: "Unarchive", exact: true })).toBeVisible();
    await expect(drawer.locator("#tdMeta")).toContainText("archived");
    await page.locator("#tdClose").click();

    // Gone from Board (kanban card count), the stat tile agrees, and
    // it's gone from Swimlanes membership too.
    await expect(page.locator(`#kanbanBody .kcard[data-task-id="${task.id}"]`)).toHaveCount(0);

    const allTasks = await (await request.get("/tasks")).json();
    const realInboxCount = allTasks.filter(
      (t: { status: string; supersededBy?: string; archivedAt?: string }) => t.status === "inbox" && !t.supersededBy && !t.archivedAt,
    ).length;
    const inboxStatTile = page.locator("#stats .stat", { has: page.locator(".l", { hasText: "Inbox" }) });
    await expect(inboxStatTile.locator(".n")).toHaveText(String(realInboxCount));

    await page.getByRole("button", { name: "By feature", exact: true }).click();
    await expect(page.locator("#swimlanesBody").getByText(title, { exact: true })).toHaveCount(0);

    // Present in the Archive tab, grouped into its own lane.
    await page.getByRole("link", { name: "Archive", exact: true }).click();
    await expect(page.getByRole("link", { name: "Archive", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#archivePanel")).toBeVisible();
    const archiveLane = page.locator("#archiveBody .swimlane", { has: page.locator(".swimlane-head", { hasText: title }) });
    await expect(archiveLane).toBeVisible();
    await expect(archiveLane.locator(".slcard")).toHaveCount(1);
    await expect(archiveLane.locator(".slcard .card-action")).toHaveText("Unarchive");
  });

  test("archiving a lane from its Swimlanes header cascades to every card in that lane, confirmed via the Archive tab afterward", async ({ page, request }) => {
    const title = `Lane archive test ${Date.now()}`;
    const created = await request.post("/tasks", { data: { title, body: "x", labels: ["code"], repo: "/tmp/wissel-e2e-repo" } });
    const originalId = (await created.json()).id as string;
    // Auto-creates a "Review: <title>" follow-up — a real 2-card lineage,
    // same setup the plain Swimlanes lineage test above uses.
    await request.post(`/tasks/${originalId}/result`, { data: { agentId: "implementer", ok: true, summary: "did the thing" } });

    await page.goto("/board");
    await page.getByRole("button", { name: "By feature", exact: true }).click();

    const lane = page.locator(".swimlane", { has: page.locator(".swimlane-head", { hasText: title }) });
    await expect(lane.locator(".slcard")).toHaveCount(2);

    page.once("dialog", (dialog) => dialog.accept());
    await lane.locator(".lane-action", { hasText: "Archive this lane" }).click();

    // The whole lane disappears from the live Swimlanes view — scoped to
    // #swimlanesBody specifically, since the same-titled lane now exists
    // (hidden) in the Archive tab's own #archiveBody.
    await expect(page.locator("#swimlanesBody .swimlane", { has: page.locator(".swimlane-head", { hasText: title }) })).toHaveCount(0);

    await page.getByRole("link", { name: "Archive", exact: true }).click();
    const archiveLane = page.locator("#archiveBody .swimlane", { has: page.locator(".swimlane-head", { hasText: title }) });
    await expect(archiveLane).toBeVisible();
    await expect(archiveLane.locator(".slcard")).toHaveCount(2);
    // The Archive tab's own lanes never get a lane-wide action — only
    // the per-card Unarchive (§3.6: unarchiving a whole lane isn't a
    // thing).
    await expect(archiveLane.locator(".lane-action")).toHaveCount(0);
  });

  test("unarchiving one card from the Archive tab restores exactly that card to Swimlanes, not its former lane-mate", async ({ page, request }) => {
    const title = `Partial unarchive test ${Date.now()}`;
    const created = await request.post("/tasks", { data: { title, body: "x", labels: ["code"], repo: "/tmp/wissel-e2e-repo" } });
    const originalId = (await created.json()).id as string;
    await request.post(`/tasks/${originalId}/result`, { data: { agentId: "implementer", ok: true, summary: "did the thing" } });

    // Archive the whole lineage via the API directly (equivalent to the
    // lane-header action already covered above) — this test is about
    // unarchive's single-row behavior, not re-proving the cascade.
    await request.post(`/tasks/${originalId}/archive`);

    await page.goto("/board");
    await page.getByRole("link", { name: "Archive", exact: true }).click();
    const archiveLane = page.locator("#archiveBody .swimlane", { has: page.locator(".swimlane-head", { hasText: title }) });
    await expect(archiveLane.locator(".slcard")).toHaveCount(2);

    const reviewerCard = archiveLane.locator(".slcard", { hasText: `Review: ${title}` });
    await reviewerCard.locator(".card-action").click(); // Unarchive — no confirm dialog for this one (§3.6)

    // Exactly one card left behind in the Archive tab — the implementer,
    // never the reviewer that was just restored.
    await expect(archiveLane.locator(".slcard")).toHaveCount(1);
    await expect(archiveLane.locator(".slcard", { hasText: `Review: ${title}` })).toHaveCount(0);

    // The restored reviewer card is live again in Swimlanes — its own
    // lane, since its lineage root (the implementer) is still archived.
    // The Lanes / By feature switch lives on the Board page only.
    await page.getByRole("link", { name: "Board", exact: true }).click();
    await page.getByRole("button", { name: "By feature", exact: true }).click();
    await expect(page.locator("#swimlanesBody").getByText(`Review: ${title}`, { exact: true })).toBeVisible();
  });
});

// docs/SDD-ui-cleanup.md §3.1 (card A1): sidebar + top bar + Setup pages.
// Targets T1 (≤ 120px of controls above the first board card) and T6 (no
// setup items on the Board view), both measured at 1440x900 as §2 asks.
test.describe("Shell and navigation", () => {
  const SIDEBAR_PAGES: { name: string; hash: string; page: string }[] = [
    { name: "Archive", hash: "#/archive", page: "#archivePanel" },
    { name: "Agents & skills", hash: "#/setup/agents", page: "#agentsPage" },
    { name: "Harnesses", hash: "#/setup/harnesses", page: "#harnessPanel" },
    { name: "MCP servers", hash: "#/setup/mcp", page: "#mcpPanel" },
    { name: "Projects", hash: "#/setup/projects", page: "#projectsPanel" },
    { name: "Memory", hash: "#/setup/memory", page: "#memoryPanel" },
    { name: "Settings", hash: "#/setup/settings", page: "#settingsPage" },
    { name: "Board", hash: "#/board", page: "#boardPage" },
  ];

  test.describe("at 1440x900", () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test("T1: the first board card starts within 120px of the top of the page", async ({ page, request }) => {
      await request.post("/tasks", { data: { title: `T1 measure ${Date.now()}`, body: "x", labels: [], repo: "/tmp/wissel-e2e-repo" } });
      await page.goto("/board");
      const first = page.locator("#kanbanBody .kcard").first();
      await expect(first).toBeVisible();
      const box = await first.boundingBox();
      // Logged so the measured value shows up in the run output, not
      // just pass/fail.
      console.log(`T1: first board card top = ${box!.y}px (goal ≤ 120)`);
      expect(box!.y).toBeLessThanOrEqual(120);
      await page.screenshot({ path: "test-results/ui-a1/board-1440x900.png" });
    });

    test("T6: no setup items on the Board view", async ({ page }) => {
      await page.goto("/board");
      await expect(page.locator("#boardPanel")).toBeVisible();
      // Agents, Skills, Projects summary, harness chips (SDD §2 T6), plus
      // the theme toggle and the MCP list the old header also carried.
      for (const sel of ["#agentsBox", "#skillsBox", "#projectSummaryBox", "#harnessStrip", "#hmList", "#mcpList", "#themeToggle"]) {
        await expect(page.locator(sel), sel).toBeHidden();
      }
      // The old header buttons and page title are gone, not just hidden.
      await expect(page.locator("#hmOpenBtn")).toHaveCount(0);
      await expect(page.locator("#mcpOpenBtn")).toHaveCount(0);
      await expect(page.locator("h1")).toHaveCount(0);
    });

    test("every sidebar link shows exactly its page, marks itself current, and updates the hash", async ({ page }) => {
      await page.goto("/board");
      for (const { name, hash, page: pageSel } of SIDEBAR_PAGES) {
        const link = page.getByRole("link", { name, exact: true });
        await link.click();
        await expect(page).toHaveURL(new RegExp(hash.replace(/[/]/g, "\\/") + "$"));
        await expect(page.locator(pageSel)).toBeVisible();
        await expect(page.locator("main [data-page]:visible")).toHaveCount(1);
        await expect(link).toHaveAttribute("aria-current", "page");
        await expect(page.locator('#sidebar [aria-current="page"]')).toHaveCount(1);
        // The Lanes / By feature switch only belongs to the Board page.
        await expect(page.locator("#boardViewToggle")).toBeVisible({ visible: name === "Board" });
      }
    });
  });

  test("reload keeps the page, and back/forward walk the visited pages", async ({ page }) => {
    await page.goto("/board#/setup/memory");
    await expect(page.locator("#memoryPanel")).toBeVisible();
    await page.reload();
    await expect(page.locator("#memoryPanel")).toBeVisible();

    await page.getByRole("link", { name: "Harnesses", exact: true }).click();
    await page.getByRole("button", { name: "+ New", exact: true }).click();
    await expect(page.locator("#newTaskPanel")).toBeVisible();
    await expect(page.getByRole("button", { name: "+ New", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.locator('#sidebar [aria-current="page"]')).toHaveCount(0);

    await page.goBack();
    await expect(page.locator("#harnessPanel")).toBeVisible();
    await page.goBack();
    await expect(page.locator("#memoryPanel")).toBeVisible();
    await page.goForward();
    await expect(page.locator("#harnessPanel")).toBeVisible();
  });

  test("an unknown hash lands on the board and rewrites the URL", async ({ page }) => {
    await page.goto("/board#/no-such-page");
    await expect(page.locator("#boardPanel")).toBeVisible();
    await expect(page).toHaveURL(/\/board#\/board$/);
    await expect(page.getByRole("link", { name: "Board", exact: true })).toHaveAttribute("aria-current", "page");
  });

  test("Pipelines in the sidebar links out to the editor until it gets its own page", async ({ page }) => {
    await page.goto("/board");
    await expect(page.getByRole("link", { name: "Pipelines", exact: true })).toHaveAttribute("href", "/pipelines/edit");
  });

  test("below 1100px the sidebar collapses to icons, and its links keep their names", async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.goto("/board");
    const sidebar = await page.locator("#sidebar").boundingBox();
    expect(sidebar!.width).toBeLessThanOrEqual(64);
    const label = await page.locator('#sidebar a[data-route="setup/harnesses"] .nav-label').boundingBox();
    expect(label!.width).toBeLessThanOrEqual(1);
    // Still reachable by name (screen readers, getByRole), not just by icon.
    await page.getByRole("link", { name: "Harnesses", exact: true }).click();
    await expect(page.locator("#harnessPanel")).toBeVisible();

    await page.setViewportSize({ width: 1100, height: 800 });
    await expect(async () => {
      expect((await page.locator("#sidebar").boundingBox())!.width).toBeGreaterThan(150);
    }).toPass();
  });

  test("no horizontal scroll at 1280px on any page", async ({ page, request }) => {
    // A long unbroken title is the likeliest thing to push a page wide.
    await request.post("/tasks", { data: { title: "x".repeat(300), body: "x", labels: [], repo: "/tmp/wissel-e2e-repo" } });
    await page.setViewportSize({ width: 1280, height: 800 });
    for (const { hash, page: pageSel } of [...SIDEBAR_PAGES, { name: "", hash: "#/board/features", page: "#swimlanesPanel" }, { name: "", hash: "#/new", page: "#newTaskPanel" }]) {
      await page.goto("/board" + hash);
      await expect(page.locator(pageSel)).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, hash).toBeLessThanOrEqual(0);
    }
  });
});
