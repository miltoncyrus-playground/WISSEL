import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";

// docs/SDD-schedules.md §3.7: the board's Schedules panel (under Saved
// pipelines), each pipeline's next run and "Add schedule", and the
// schedule editor with its live preview.
//
// The e2e server runs the real ScheduleRunner on its own :memory: DB.
// Every schedule here is either disabled or on a cron that can't come
// round during a run (29 February, or a weekday days away), so nothing
// fires behind a test's back. The orchestrator is off (playwright.config
// .ts), so a task schedule's card just sits in inbox.

const TZ = "Europe/Madrid";
// Next due 29 Feb 2028: valid, and never due while the suite runs.
const FAR_CRON = "17 3 29 2 *";

function unique(label: string): string {
  return `${label} ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// Same no-entry fixture as e2e/pipelines.spec.ts: a run fails at once,
// spawning nothing.
async function createNoEntryPipeline(request: APIRequestContext, name: string) {
  const res = await request.post("/pipelines", {
    data: {
      name, description: "e2e: no entry step, fails instantly",
      graph: {
        steps: [
          { id: "a", name: "Plan", agentId: "planner", transition: "all" },
          { id: "b", name: "Implement", agentId: "implementer", transition: "all" },
        ],
        edges: [{ id: "ab", from: "a", to: "b" }, { id: "ba", from: "b", to: "a" }],
      },
    },
  });
  expect(res.status()).toBe(201);
  return (await res.json()) as { id: string; name: string };
}

async function createTaskSchedule(request: APIRequestContext, name: string, title: string) {
  const res = await request.post("/schedules", {
    data: {
      name, kind: "task", cron: FAR_CRON, timezone: TZ, enabled: false,
      taskTemplate: { title, body: "e2e: a task schedule's card", labels: ["intake"], repo: "/tmp/wissel-e2e-repo" },
    },
  });
  expect(res.status()).toBe(201);
  return (await res.json()) as { id: string; name: string };
}

async function getSchedule(request: APIRequestContext, id: string) {
  const res = await request.get(`/schedules/${id}`);
  return { status: res.status(), body: res.ok() ? await res.json() : null };
}

function scheduleRow(page: Page, id: string): Locator {
  return page.locator(`#schedulesList [data-schedule-id="${id}"]`);
}

test.describe("Schedules on the board", () => {
  test.use({ viewport: { width: 1440, height: 900 }, timezoneId: TZ });

  test("Add schedule: the preview follows the picker and the cron, shows the server's error, and Save creates it", async ({ page, request }) => {
    const pipeline = await createNoEntryPipeline(request, unique("Scheduled pipeline"));
    await page.goto("/board#/pipelines");
    const row = page.locator(`#pipelinesList [data-pipeline-id="${pipeline.id}"]`);
    await expect(row.locator(".pl-next")).toHaveCount(0);
    await row.getByRole("button", { name: `Add schedule for ${pipeline.name}` }).click();

    const drawer = page.locator("#schedDrawer");
    await expect(drawer).toBeVisible();
    await expect(page.locator("#schedTitle")).toHaveText("Add schedule");
    await expect(page.locator("#seTarget")).toContainText(pipeline.name);
    // Preselected: every day at 09:00 in the browser's zone.
    await expect(page.locator("#seMode")).toHaveValue("daily");
    await expect(page.locator("#seTz")).toHaveValue(TZ);
    await expect(page.locator("#seCron")).toHaveValue("0 9 * * *");
    await expect(page.locator("#sePreview li")).toHaveCount(3);
    await expect(page.locator("#seCadence")).toHaveText("every day at 09:00");
    // The name follows the cadence until you type one.
    await expect(page.locator("#seName")).toHaveValue(`${pipeline.name}, every day at 09:00`);
    await expect(page.locator("#seSave")).toBeEnabled();

    // The three lines are the server's next runs on the browser's clock.
    const preview = await (await request.get(`/schedules/preview?cron=${encodeURIComponent("0 9 * * *")}&timezone=${TZ}`)).json();
    const expected = await page.evaluate((next: string[]) => {
      const w = window as unknown as { formatWhen(iso: string, now: Date, tz: string): string };
      return next.slice(0, 3).map((iso) => w.formatWhen(iso, new Date(), "Europe/Madrid"));
    }, preview.next);
    await expect(page.locator("#sePreview li")).toHaveText(expected);

    // Weekly with no day: the picker's own error, Save off.
    await page.locator("#seMode").selectOption("weekly");
    await expect(page.locator("#sePreviewError")).toHaveText("Pick at least one day.");
    await expect(page.locator("#seSave")).toBeDisabled();
    await page.locator('#sePicker [data-day="3"]').check();
    await expect(page.locator("#seCron")).toHaveValue("0 9 * * 3");
    await expect(page.locator("#seCadence")).toContainText("Wednesday");
    await expect(page.locator("#seSave")).toBeEnabled();

    // Every N hours.
    await page.locator("#seMode").selectOption("hours");
    await page.locator("#seHours").fill("4");
    await expect(page.locator("#seCron")).toHaveValue("0 */4 * * *");
    await expect(page.locator("#seCadence")).toHaveText("every 4 hours");

    // Advanced: an invalid cron shows the server's reason, Save off.
    await page.locator("#seAdvanced summary").click();
    await page.locator("#seCron").fill("* * * * *");
    await expect(page.locator("#seMode")).toHaveValue("custom");
    await expect(page.locator("#sePreviewError")).toBeVisible();
    await expect(page.locator("#sePreviewError")).toContainText("5 minutes");
    await expect(page.locator("#sePreview li")).toHaveCount(0);
    await expect(page.locator("#seSave")).toBeDisabled();
    await page.locator("#seCron").fill("0 6 * *");
    await expect(page.locator("#sePreviewError")).toBeVisible();
    await expect(page.locator("#seSave")).toBeDisabled();

    // A cron the picker can show moves the picker.
    await page.locator("#seCron").fill("30 7 * * 1-5");
    await expect(page.locator("#seMode")).toHaveValue("weekdays");
    await expect(page.locator("#seTime")).toHaveValue("07:30");
    await expect(page.locator("#seCadence")).toHaveText("weekdays at 07:30");
    await expect(page.locator("#sePreview li")).toHaveCount(3);

    // A bad zone is the server's error too.
    await page.locator("#seTz").fill("Mars/Olympus");
    await expect(page.locator("#sePreviewError")).toBeVisible();
    await expect(page.locator("#seSave")).toBeDisabled();
    await page.locator("#seTz").fill(TZ);

    // Save on a cron that never comes round during the suite.
    await page.locator("#seCron").fill(FAR_CRON);
    await expect(page.locator("#sePreview li")).toHaveCount(3);
    await page.locator("#seName").fill(`${pipeline.name} nightly`);
    await page.locator("#seInput").fill("e2e input");
    await page.locator("#seCatchUp").fill("2");
    const posted = page.waitForRequest((r) => r.url().endsWith("/schedules") && r.method() === "POST");
    await page.locator("#seSave").click();
    const body = (await posted).postDataJSON();
    expect(body).toEqual({
      name: `${pipeline.name} nightly`, kind: "pipeline", pipelineId: pipeline.id, input: "e2e input",
      cron: FAR_CRON, timezone: TZ, catchUpHours: 2,
    });
    await expect(drawer).toBeHidden();

    const list = await (await request.get("/schedules")).json();
    const saved = list.find((s: { name: string }) => s.name === `${pipeline.name} nightly`);
    expect(saved).toMatchObject({ kind: "pipeline", pipelineId: pipeline.id, cron: FAR_CRON, timezone: TZ, enabled: true, catchUpHours: 2 });

    // The panel row, and the pipeline's next run.
    const sRow = scheduleRow(page, saved.id);
    await expect(sRow.locator(".sc-name")).toHaveText(`${pipeline.name} nightly`);
    await expect(sRow.locator(".sc-target")).toHaveText(`Pipeline: ${pipeline.name}`);
    await expect(sRow.locator(".sc-cadence")).toContainText(TZ);
    await expect(sRow.locator(".sc-next")).toContainText("29 Feb 2028 03:17");
    await expect(sRow.locator(".sc-msg")).toContainText("Saved");
    await expect(row.locator(".pl-next")).toContainText("Next run Tue 29 Feb 2028 03:17");

    // Leave nothing enabled behind.
    await request.patch(`/schedules/${saved.id}`, { data: { enabled: false } });
  });

  test("Edit opens on the saved cadence (Advanced for a cron the picker can't show) and saves with PATCH", async ({ page, request }) => {
    const pipeline = await createNoEntryPipeline(request, unique("Edit schedule pipeline"));
    const created = await request.post("/schedules", {
      data: { name: unique("Twice a day"), kind: "pipeline", pipelineId: pipeline.id, cron: "0 6,18 * * *", timezone: "UTC", enabled: false, repo: "/tmp/wissel-e2e-repo" },
    });
    const s = await created.json();
    await page.goto("/board#/pipelines");
    await scheduleRow(page, s.id).getByRole("button", { name: `Edit schedule ${s.name}` }).click();

    await expect(page.locator("#schedTitle")).toHaveText("Edit schedule");
    await expect(page.locator("#seMode")).toHaveValue("custom");
    await expect(page.locator("#seAdvanced")).toHaveAttribute("open", "");
    await expect(page.locator("#seCron")).toHaveValue("0 6,18 * * *");
    await expect(page.locator("#seTz")).toHaveValue("UTC");
    await expect(page.locator("#seRepo")).toHaveValue("/tmp/wissel-e2e-repo");
    await expect(page.locator("#seName")).toHaveValue(s.name);
    await expect(page.locator("#sePreview li")).toHaveCount(3);

    await page.locator("#seName").fill(`${s.name} (edited)`);
    await page.locator("#seRepo").fill("");
    const patched = page.waitForRequest((r) => r.url().endsWith(`/schedules/${s.id}`) && r.method() === "PATCH");
    await page.locator("#seSave").click();
    expect((await patched).postDataJSON()).toEqual({
      name: `${s.name} (edited)`, cron: "0 6,18 * * *", timezone: "UTC", catchUpHours: 12, input: null, repo: null,
    });
    await expect(page.locator("#schedDrawer")).toBeHidden();
    await expect(scheduleRow(page, s.id).locator(".sc-name")).toHaveText(`${s.name} (edited)`);
    const after = await getSchedule(request, s.id);
    expect(after.body).toMatchObject({ name: `${s.name} (edited)`, enabled: false });
    expect(after.body.repo).toBeUndefined();
  });

  test("the enabled toggle PATCHes; Run now starts a run, links to its card, and shows the 409 overlap plainly; Delete asks first", async ({ page, request }) => {
    const title = unique("Scheduled card");
    const s = await createTaskSchedule(request, unique("Task schedule"), title);
    await page.goto("/board#/pipelines");
    const row = scheduleRow(page, s.id);
    await expect(row.locator(".sc-target")).toHaveText(`Task: ${title}`);
    await expect(row.locator(".sc-next")).toHaveText("Paused");
    await expect(row.locator(".sc-last")).toHaveText("Last: never run");

    // Toggle on, then off again.
    const toggle = row.getByRole("checkbox", { name: `Enabled: ${s.name}` });
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect(row.locator(".sc-next")).toContainText("29 Feb 2028 03:17");
    expect((await getSchedule(request, s.id)).body).toMatchObject({ enabled: true });
    await row.getByRole("checkbox", { name: `Enabled: ${s.name}` }).uncheck();
    await expect(row.locator(".sc-next")).toHaveText("Paused");
    expect((await getSchedule(request, s.id)).body).toMatchObject({ enabled: false });

    // Run now: one card, tagged with the schedule.
    await row.getByRole("button", { name: `Run now: ${s.name}` }).click();
    await expect(row.locator(".sc-msg")).toContainText("Started: run ");
    const after = (await getSchedule(request, s.id)).body;
    expect(after).toMatchObject({ lastOutcome: "started", lastRunStatus: "inbox" });
    const tasks = await (await request.get("/tasks")).json();
    const made = tasks.filter((t: { title: string }) => t.title === title);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ id: after.lastRunId, scheduleId: s.id, status: "inbox" });
    await expect(row.locator(".sc-last")).toContainText("started");
    await expect(row.locator(".sc-last .status-pill")).toContainText(/inbox/i);

    // The card is still open: a second Run now is the server's 409, shown as is.
    await row.getByRole("button", { name: `Run now: ${s.name}` }).click();
    await expect(row.getByRole("alert")).toContainText("is still on its last run");
    expect((await (await request.get("/tasks")).json()).filter((t: { title: string }) => t.title === title)).toHaveLength(1);

    // The last run's link opens its card.
    await row.getByRole("button", { name: `Open the last run of ${s.name}` }).click();
    await expect(page.locator("#taskDrawer")).toBeVisible();
    await expect(page.locator("#tdTitle")).toHaveText(title);
    await page.locator("#tdClose").click();
    await expect(page.locator("#taskDrawer")).toBeHidden();

    // Delete: dismissing the confirm keeps it; accepting deletes it, the card stays.
    page.once("dialog", (d) => d.dismiss());
    await row.getByRole("button", { name: `Delete schedule ${s.name}` }).click();
    await expect(row).toBeVisible();
    expect((await getSchedule(request, s.id)).status).toBe(200);
    let confirmText = "";
    page.once("dialog", (d) => { confirmText = d.message(); void d.accept(); });
    await row.getByRole("button", { name: `Delete schedule ${s.name}` }).click();
    await expect(row).toHaveCount(0);
    expect(confirmText).toContain(s.name);
    expect((await getSchedule(request, s.id)).status).toBe(404);
    expect((await (await request.get(`/tasks/${after.lastRunId}`)).json())).toMatchObject({ title });
  });
});
