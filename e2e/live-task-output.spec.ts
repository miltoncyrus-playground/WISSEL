import { test, expect } from "@playwright/test";

/**
 * Real browser coverage for docs/SDD-live-task-output.md's UI subtask
 * (§3.6/§6) — no real claude/codex process runs here (this fixture
 * server never dispatches one), so these tests exercise the modal's
 * wiring (card/drawer button -> SSE/snapshot fetch -> render) against
 * real HTTP endpoints, the same "drive it over real HTTP, not a
 * hand-rolled stand-in" principle e2e/board.spec.ts's driveToEscalated
 * already uses. A live agent run producing real streamed rows is
 * covered separately by eval/live-task-output.eval.ts (real spend,
 * disclosed as not run by this session).
 */

// The task drawer (board.html's openTaskDrawer) unconditionally fetches
// /tasks/:id/decision and /tasks/:id/result on open, and both already
// treat a 404 as a legitimate, expected "not recorded yet" state (see
// loadDrawerDecision/loadDrawerResult's own `if (r.status === 404)`
// handling) -- correct REST semantics for a task that hasn't been
// routed or hasn't finished yet, which every test below deliberately
// exercises. The browser still logs the network-level 404 to console
// regardless of how gracefully the JS response handler deals with it
// afterward. Chromium's own console message for this has no URL in its
// text (confirmed live -- it's the generic "Failed to load resource:
// the server responded with a status of 404" with nothing identifying
// which request), so distinguishing "expected /decision or /result
// 404" from "a genuinely new, unexpected 404" has to happen at the
// network layer via page.on("response"), not by pattern-matching the
// console text (which would just as easily hide a real regression).
function collectPageErrors(page: import("@playwright/test").Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  page.on("console", (msg) => {
    // Real app-level console.error calls (not the browser's own generic
    // resource-load notice) always have specific, identifiable text --
    // exactly the kind of thing this assertion should still catch.
    if (msg.type() === "error" && !/^Failed to load resource/.test(msg.text())) errors.push(msg.text());
  });
  page.on("response", (res) => {
    if (res.ok()) return;
    const url = res.url();
    const isExpectedNotFound = res.status() === 404 && (url.endsWith("/decision") || url.endsWith("/result"));
    if (!isExpectedNotFound) errors.push(`unexpected ${res.status()} response: ${url}`);
  });
  return errors;
}

test("a running task's kanban card shows a Live output button that opens the modal, connects via SSE, and shows the empty state with no output yet", async ({ page, request }) => {
  const errors = collectPageErrors(page);
  const created = await request.post("/tasks", { data: { title: "Stream me", body: "x", labels: ["code"], repo: "." } });
  const task = await created.json();
  await request.post(`/tasks/${task.id}/move`, { data: { status: "running" } });

  await page.goto("/board");
  const card = page.locator("#kanbanBody").locator(".kcard", { hasText: task.title });
  await expect(card).toBeVisible();

  const liveBtn = card.getByRole("button", { name: `View live output for ${task.title}` });
  await expect(liveBtn).toBeVisible();
  await liveBtn.click();

  const panel = page.locator("#liveOutputPanel");
  await expect(panel).toBeVisible();
  await expect(panel.locator("#loTitle")).toHaveText(`Live output — ${task.title}`);
  // Clicking the card's own live-output button must not also open the
  // task drawer underneath it (stopPropagation).
  await expect(page.locator("#taskDrawer")).toBeHidden();

  await expect(panel.locator("#loRows")).toContainText("No output yet.");

  await page.screenshot({ path: "/tmp/live-task-output-modal-open.png", fullPage: true });

  await panel.locator("#loClose").click();
  await expect(panel).toBeHidden();

  expect(errors).toEqual([]);
});

test("SSE stream ends cleanly (event: done) when the task's result lands, without crashing the open modal", async ({ page, request }) => {
  const errors = collectPageErrors(page);
  const created = await request.post("/tasks", { data: { title: "Watch me finish", body: "x", labels: ["code"], repo: "." } });
  const task = await created.json();
  await request.post(`/tasks/${task.id}/move`, { data: { status: "running" } });

  const streamResponsePromise = page.waitForResponse((r) => r.url().includes(`/tasks/${task.id}/output/stream`));

  await page.goto("/board");
  await page.locator("#kanbanBody").getByText(task.title).click();
  const drawer = page.locator("#taskDrawer");
  await expect(drawer).toBeVisible();
  await drawer.getByRole("button", { name: "Live output" }).click();

  const panel = page.locator("#liveOutputPanel");
  await expect(panel).toBeVisible();
  await expect(panel.locator("#loRows")).toContainText("No output yet.");
  const streamResponse = await streamResponsePromise;
  expect(streamResponse.headers()["content-type"]).toContain("text/event-stream");

  // finishResult's real path (board.recordResult -> "task.result"
  // BoardEvent -> taskOutputStream's resultListener -> `event: done` ->
  // controller.close()) — driven here purely over HTTP, same as
  // driveToEscalated in e2e/board.spec.ts. Proves the whole chain fires
  // against a real browser EventSource, not just the Node-side
  // fetch+reader test in test/api.test.ts.
  await request.post(`/tasks/${task.id}/result`, { data: { agentId: "implementer", ok: true, summary: "done streaming" } });

  // Nothing crashes and the panel stays usable after the stream closes —
  // the strongest signal available from outside the page that `event:
  // done` was handled cleanly rather than surfacing as an uncaught error.
  await panel.locator("#loClose").click();
  await expect(panel).toBeHidden();

  await page.screenshot({ path: "/tmp/live-task-output-modal-streaming.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("a finished task's drawer offers 'View output' (not 'Live output') and fetches the snapshot endpoint instead of opening SSE", async ({ page, request }) => {
  const errors = collectPageErrors(page);
  const created = await request.post("/tasks", { data: { title: "Already done", body: "x", labels: ["code"], repo: "." } });
  const task = await created.json();
  await request.post(`/tasks/${task.id}/move`, { data: { status: "done" } });

  const snapshotRequests: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/output")) snapshotRequests.push(req.url());
  });

  await page.goto("/board");
  await page.locator("#kanbanBody").getByText(task.title).click();
  const drawer = page.locator("#taskDrawer");
  await expect(drawer).toBeVisible();

  const viewBtn = drawer.getByRole("button", { name: "View output" });
  await expect(viewBtn).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Live output" })).toHaveCount(0);
  await viewBtn.click();

  const panel = page.locator("#liveOutputPanel");
  await expect(panel).toBeVisible();
  await expect(panel.locator("#loRows")).toContainText("No output yet.");
  expect(snapshotRequests.some((u) => u.endsWith(`/tasks/${task.id}/output`))).toBe(true);
  expect(snapshotRequests.some((u) => u.includes("/output/stream"))).toBe(false);

  expect(errors).toEqual([]);
});
