/// <reference lib="dom" />
import { test, expect, type Page } from "@playwright/test";

// docs/SDD-wissel-app.md §3.1 and §4.2 (card 1): the /app shell at
// phone (390 px) and desktop (1440 px) widths.

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844, desktop: false },
  { name: "desktop", width: 1440, height: 900, desktop: true },
] as const;

const SCREENS = [
  { hash: "#/feed", heading: "Feed" },
  { hash: "#/ask", heading: "Ask wissel" },
  { hash: "#/board", heading: "Board" },
  { hash: "#/listen", heading: "Listen" },
  { hash: "#/you", heading: "You" },
];

const REPO = "/tmp/wissel-e2e-repo";

async function noSideways(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll, "page scrolls sideways").toBeLessThanOrEqual(client);
}

/** Every focusable thing is a real control: a, button, input (or the
 *  native dialog). No div/span with tabindex or a role pretending. */
async function onlyRealControls(page: Page) {
  const fakes = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[tabindex], [role="button"], [role="link"], [onclick]'))
      .filter((el) => !["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "DIALOG"].includes(el.tagName))
      .map((el) => el.outerHTML.slice(0, 120)),
  );
  expect(fakes).toEqual([]);
  const unlabeled = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>("button, a[href]"))
      .filter((el) => el.offsetParent !== null || getComputedStyle(el).position === "fixed")
      .filter((el) => !(el.getAttribute("aria-label") || el.textContent || "").trim())
      .map((el) => el.outerHTML.slice(0, 120)),
  );
  expect(unlabeled, "icon-only controls need an aria-label").toEqual([]);
}

async function createCard(request: import("@playwright/test").APIRequestContext, title: string, status?: string): Promise<string> {
  const res = await request.post("/tasks", { data: { title, body: "from app.spec", labels: ["code"], repo: REPO } });
  expect(res.ok()).toBe(true);
  const { id } = (await res.json()) as { id: string };
  if (status) expect((await request.post(`/tasks/${id}/move`, { data: { status } })).ok()).toBe(true);
  return id;
}

for (const vp of VIEWPORTS) {
  test.describe(`/app at ${vp.width}px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("renders every screen with no sideways scroll and only real, labelled controls", async ({ page }) => {
      const errors: string[] = [];
      page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
      page.on("pageerror", (e) => errors.push(e.message));
      const external: string[] = [];
      page.on("request", (r) => {
        const host = new URL(r.url()).hostname;
        if (host !== "localhost" && host !== "127.0.0.1") external.push(r.url());
      });

      await page.goto("/app");
      // Chat-first: no hash lands on Ask.
      await expect(page.getByRole("heading", { level: 1, name: "Ask wissel" })).toBeVisible();

      for (const s of SCREENS) {
        await page.goto(`/app${s.hash}`);
        await expect(page.getByRole("heading", { level: 1, name: s.heading })).toBeVisible();
        await noSideways(page);
        await onlyRealControls(page);
      }

      // Fonts are bundled, not fetched from Google.
      await page.evaluate(() => document.fonts.ready);
      expect(external).toEqual([]);
      const loaded = await page.evaluate(() => {
        const out: string[] = [];
        document.fonts.forEach((f) => {
          if (f.status === "loaded") out.push(f.family.replace(/["']/g, ""));
        });
        return out;
      });
      expect(loaded).toContain("Figtree");
      expect(errors).toEqual([]);
    });

    test("the shell has the right navigation for the width", async ({ page }) => {
      await page.goto("/app#/feed");
      const nav = page.getByRole("navigation", { name: "Screens" });
      await expect(nav).toBeVisible();
      for (const label of ["Feed", "Ask", "Board", "Listen", "You"]) {
        await expect(nav.getByRole("link", { name: label, exact: true })).toBeVisible();
      }
      await expect(nav.getByRole("link", { name: "Feed", exact: true })).toHaveAttribute("aria-current", "page");

      await nav.getByRole("link", { name: "Listen", exact: true }).click();
      await expect(page).toHaveURL(/#\/listen$/);
      await expect(page.getByRole("heading", { level: 1, name: "Listen" })).toBeVisible();

      const live = page.getByRole("complementary").filter({ has: page.getByRole("heading", { name: "Live" }) });
      if (vp.desktop) {
        await expect(live).toBeVisible();
        const box = await nav.boundingBox();
        expect(box!.x).toBeLessThan(10); // left rail
      } else {
        await expect(live).toHaveCount(0);
        const box = await nav.boundingBox();
        expect(box!.y + box!.height).toBeGreaterThan(vp.height - 2); // bottom tab bar
      }
    });

    test("every screen is reachable by keyboard alone", async ({ page }) => {
      await page.goto("/app#/feed");
      const reached = new Set<string>();
      for (let i = 0; i < 40 && reached.size < 5; i++) {
        await page.keyboard.press("Tab");
        const label = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          return el?.closest('nav[aria-label="Screens"]') && el.tagName === "A" ? (el.textContent ?? "").trim() : "";
        });
        if (["Feed", "Ask", "Board", "Listen", "You"].includes(label)) reached.add(label);
      }
      expect([...reached].sort()).toEqual(["Ask", "Board", "Feed", "Listen", "You"]);

      // Focus is visible: the focused link draws an outline.
      await page.getByRole("navigation", { name: "Screens" }).getByRole("link", { name: "Board", exact: true }).focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      const outline = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
      expect(outline).not.toBe("none");

      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/#\/board$/);
    });

    test("Ctrl-K opens the palette; typing and Enter jumps to a screen", async ({ page }) => {
      await page.goto("/app#/feed");
      await page.keyboard.press("Control+k");
      const dialog = page.getByRole("dialog", { name: "Command palette" });
      await expect(dialog).toBeVisible();
      const input = dialog.getByRole("combobox");
      await expect(input).toBeFocused();
      await input.fill("lis");
      await expect(dialog.getByRole("option").first()).toHaveText(/Listen/);
      await page.keyboard.press("Enter");
      await expect(dialog).toBeHidden();
      await expect(page).toHaveURL(/#\/listen$/);

      // Escape closes it; Meta-K works too.
      await page.keyboard.press("Meta+k");
      await expect(dialog).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    });

    test("the palette has a button (for phones) and opens a card by title", async ({ page, request }) => {
      const title = `Palette card ${vp.name} ${Date.now()}`;
      const id = await createCard(request, title, "running");
      await page.goto("/app#/feed");
      await page.getByRole("button", { name: "Search or jump" }).click();
      const dialog = page.getByRole("dialog", { name: "Command palette" });
      await dialog.getByRole("combobox").fill(title);
      await dialog.getByRole("option", { name: new RegExp(title) }).click();
      await expect(page).toHaveURL(new RegExp(`#/board/${id}$`));
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
      await noSideways(page);
    });

    test("Board tab: lanes from /tasks, live over /events, and a link to the full board", async ({ page, request }) => {
      const title = `Compact board ${vp.name} ${Date.now()}`;
      const id = await createCard(request, title, "running");
      await page.goto("/app#/board");

      const running = page.locator('[data-lane="running"]');
      await expect(running.getByRole("link", { name: new RegExp(title) })).toBeVisible();
      await expect(page.getByRole("link", { name: "Open full board" }).first()).toHaveAttribute("href", "/board");

      // No reload: the shared EventSource refetches on task.moved.
      await request.post(`/tasks/${id}/move`, { data: { status: "done" } });
      const done = page.locator('[data-lane="done-today"]');
      await expect(done.getByRole("link", { name: new RegExp(title) })).toBeVisible({ timeout: 2_000 });
      await expect(running.getByRole("link", { name: new RegExp(title) })).toHaveCount(0);

      await request.post(`/tasks/${id}/move`, { data: { status: "failed" } });
      await expect(page.locator('[data-lane="needs-you"]').getByRole("link", { name: new RegExp(title) })).toBeVisible({ timeout: 2_000 });

      if (vp.desktop) {
        const live = page.getByRole("complementary");
        await expect(live.getByRole("link", { name: new RegExp(title) })).toBeVisible();
      }
      await noSideways(page);
    });

    // docs/SDD-schedules.md §3.8: upcoming runs with the toggle and Run
    // now. A task schedule of its own (a card from a template), never a
    // podcast pipeline: Run now only makes an inert card here (the
    // orchestrator is off), and the cron is far off so the ticker never
    // fires it during the run.
    test("Board tab: the Scheduled section lists a schedule; the toggle and Run now work", async ({ page, request }) => {
      const name = `App schedule ${vp.name} ${Date.now()}`;
      const made = await request.post("/schedules", {
        data: { name, kind: "task", taskTemplate: { title: `${name} card`, body: "from app.spec", labels: ["code"], repo: REPO }, cron: "0 3 1 1 *", timezone: "Europe/Madrid", enabled: true },
      });
      expect(made.ok()).toBe(true);
      const { id } = (await made.json()) as { id: string };

      await page.goto("/app#/board");
      const section = page.locator('[data-lane="scheduled"]');
      await expect(section.getByRole("heading", { name: /Scheduled/ })).toBeVisible();
      const row = section.locator(`[data-schedule-id="${id}"]`);
      await expect(row).toContainText(name);
      // No template covers a yearly cadence, so it reads as the cron.
      await expect(row).toContainText("0 3 1 1 * (Europe/Madrid)");
      const toggle = row.getByRole("checkbox", { name: `${name}: on` });
      await expect(toggle).toBeChecked();

      await toggle.uncheck();
      await expect(row).toContainText("paused");
      await expect.poll(async () => ((await (await request.get(`/schedules/${id}`)).json()) as { enabled: boolean }).enabled).toBe(false);
      await toggle.check();
      await expect(row).toContainText("next ");
      await expect.poll(async () => ((await (await request.get(`/schedules/${id}`)).json()) as { enabled: boolean }).enabled).toBe(true);

      await row.getByRole("button", { name: `Run ${name} now` }).click();
      await expect(section.getByRole("status")).toHaveText(`Started ${name}.`);
      await expect
        .poll(async () => ((await (await request.get("/tasks")).json()) as { title: string; scheduleId?: string }[]).filter((t) => t.scheduleId === id).map((t) => t.title))
        .toEqual([`${name} card`]);
      await noSideways(page);
      await onlyRealControls(page);
      await request.delete(`/schedules/${id}`);
    });

    test("a card with a start time shows the Starts chip", async ({ page, request }) => {
      const title = `Starts later ${vp.name} ${Date.now()}`;
      const notBefore = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
      const res = await request.post("/tasks", { data: { title, body: "from app.spec", labels: ["code"], repo: REPO, notBefore } });
      expect(res.ok()).toBe(true);
      const { id } = (await res.json()) as { id: string };
      await page.goto(`/app#/board/${id}`);
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
      const hhmm = await page.evaluate((iso) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso)), notBefore);
      await expect(page.locator(".starts-chip")).toHaveText(`Starts ${hhmm}`);
    });

    test("one EventSource for the whole app, across screen changes", async ({ page }) => {
      await page.addInitScript(() => {
        const Orig = window.EventSource;
        (window as unknown as { __esCount: number }).__esCount = 0;
        window.EventSource = class extends Orig {
          constructor(url: string | URL, init?: EventSourceInit) {
            super(url, init);
            (window as unknown as { __esCount: number }).__esCount++;
          }
        } as typeof EventSource;
      });
      await page.goto("/app#/board");
      for (const s of [...SCREENS, ...SCREENS]) {
        await page.evaluate((h) => (location.hash = h), s.hash);
        await expect(page.getByRole("heading", { level: 1, name: s.heading })).toBeVisible();
      }
      expect(await page.evaluate(() => (window as unknown as { __esCount: number }).__esCount)).toBe(1);
    });
  });
}

test("reduced motion stops the live pulse", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app#/board");
  const dot = page.locator(".conn-dot");
  await expect(dot).toBeVisible();
  expect(await dot.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
});

test("the board's header links to /app, and /board itself is unchanged otherwise", async ({ page }) => {
  await page.goto("/board");
  const link = page.locator("header.topbar").getByRole("link", { name: "Try the new app" });
  await expect(link).toHaveAttribute("href", "/app");
  await link.click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { level: 1, name: "Ask wissel" })).toBeVisible();
});
