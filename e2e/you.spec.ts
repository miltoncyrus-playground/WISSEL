/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

// docs/SDD-wissel-app.md §3.6 and §4.2 (card 6): agent faces with a
// working pulse, and the You tab's Wissel Wrapped at phone (390 px) and
// desktop (1440 px). The e2e board is shared by every spec, so its real
// numbers change from run to run: the UI tests serve GET /wrapped from a
// fixture, and the real endpoint is checked on its own (its numbers are
// checked against the digest in test/wrapped.test.ts).

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844, desktop: false },
  { name: "desktop", width: 1440, height: 900, desktop: true },
] as const;

const REPO = "/tmp/wissel-e2e-repo";

const WRAPPED = {
  period: { input: "last 7 days", from: "2026-10-04", to: "2026-10-11", days: 7 },
  cardsMerged: 12,
  commits: 31,
  agentRuns: 48,
  spendUsd: 23.4,
  topAgent: { id: "implementer", runs: 20, spendUsd: 14.1 },
  pipelinesAdded: [{ id: "p1", name: "World news podcast" }],
  streak: { current: 5, best: 9, today: true, lastDay: "2026-10-11", week: [false, false, true, true, true, true, true] },
  lesson: { title: "Test the real path", text: "Mocks hid the bug twice.", runId: "r1" },
};
const CARD_COUNT = 7;

async function serveWrapped(page: Page, periods: string[] = []) {
  await page.route(/\/wrapped\?/, async (route) => {
    const period = new URL(route.request().url()).searchParams.get("period") ?? "";
    periods.push(period);
    const days = period === "last 30 days" ? 30 : 7;
    await route.fulfill({ json: { ...WRAPPED, period: { ...WRAPPED.period, input: period, days, from: days === 30 ? "2026-09-11" : "2026-10-04" }, cardsMerged: days === 30 ? 40 : 12 } });
  });
}

async function noSideways(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll, "page scrolls sideways").toBeLessThanOrEqual(client);
}

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

/** A card routed to `agent` and moved to `status`, as the router and
 *  dispatcher would leave it. */
async function routedCard(request: APIRequestContext, title: string, agent: string, status: string): Promise<string> {
  const res = await request.post("/tasks", { data: { title, body: "from you.spec", labels: ["code"], repo: REPO } });
  expect(res.ok()).toBe(true);
  const { id } = (await res.json()) as { id: string };
  const decision = { matchedTags: ["code"], candidates: [], selected: agent, confident: true, reason: "you.spec", strategy: "manual", decidedAt: new Date().toISOString() };
  expect((await request.post(`/tasks/${id}/decision`, { data: decision })).ok()).toBe(true);
  expect((await request.post(`/tasks/${id}/move`, { data: { status } })).ok()).toBe(true);
  return id;
}

const counter = (page: Page) => page.locator(".wrapped-count");

for (const vp of VIEWPORTS) {
  test.describe(`You at ${vp.width}px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("Wrapped's story cards: all seven, no sideways scroll, real labelled controls", async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await serveWrapped(page);
      await page.goto("/app#/you");
      await expect(page.getByRole("heading", { level: 1, name: "You" })).toBeVisible();
      const cards = page.locator(".wrapped-card");
      await expect(cards).toHaveCount(CARD_COUNT);
      await expect(cards.nth(0)).toContainText("Your week");
      await expect(cards.nth(0)).toContainText("4 Oct to 11 Oct");
      await expect(cards.nth(1)).toContainText("12");
      await expect(cards.nth(1)).toContainText("31 commits across your repos.");
      await expect(cards.nth(2)).toContainText("Top agent: Implementer, 20 runs.");
      // The top agent's face: the manifest's persona.
      await expect(cards.nth(2).locator(".avatar")).toHaveText("Im");
      await expect(cards.nth(3)).toContainText("$23.40");
      await expect(cards.nth(4)).toContainText("Merged on 5 of the last 7 days.");
      await expect(cards.nth(5)).toContainText("World news podcast");
      await expect(cards.nth(6)).toContainText("Test the real path");
      await expect(counter(page)).toHaveText("1 / 7");
      // One card fills the row; the rest wait to the side, inside it.
      const track = await page.locator(".wrapped-track").boundingBox();
      const first = await cards.nth(0).boundingBox();
      expect(first!.width).toBeGreaterThan(track!.width - 8);
      await noSideways(page);
      await onlyRealControls(page);
      expect(errors).toEqual([]);
    });

    test("swipe, Previous/Next and arrow keys move one card; the counter follows", async ({ page }) => {
      await serveWrapped(page);
      await page.goto("/app#/you");
      await expect(page.locator(".wrapped-card")).toHaveCount(CARD_COUNT);
      const prev = page.getByRole("button", { name: "Previous card" });
      const next = page.getByRole("button", { name: "Next card" });
      await expect(prev).toBeDisabled();

      await next.click();
      await expect(counter(page)).toHaveText("2 / 7");
      await expect(prev).toBeEnabled();

      // A swipe is a horizontal scroll of the row; it snaps to a card.
      await page.locator(".wrapped-track").evaluate((el) => el.scrollTo({ left: el.clientWidth * 3 + 20 }));
      await expect(counter(page)).toHaveText("4 / 7");
      const shown = await page.locator(".wrapped-slide[aria-current='true'] .wrapped-card").getAttribute("data-card");
      expect(shown).toBe("spend");

      // Keyboard: arrows anywhere in the Wrapped section.
      await next.focus();
      await page.keyboard.press("ArrowRight");
      await expect(counter(page)).toHaveText("5 / 7");
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("ArrowLeft");
      await expect(counter(page)).toHaveText("3 / 7");
      for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowRight");
      await expect(counter(page)).toHaveText("7 / 7");
      await expect(next).toBeDisabled();
      await noSideways(page);
    });

    test("every Wrapped control is reachable by keyboard, with a visible focus ring", async ({ page }) => {
      await serveWrapped(page);
      await page.goto("/app#/you");
      await expect(page.locator(".wrapped-card")).toHaveCount(CARD_COUNT);
      const want = ["7 days", "30 days", "Next card", "Download"];
      const reached = new Set<string>();
      for (let i = 0; i < 60 && reached.size < want.length; i++) {
        await page.keyboard.press("Tab");
        const label = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          return el?.closest(".you-screen") ? (el.getAttribute("aria-label") || el.textContent || "").trim() : "";
        });
        if (want.includes(label)) {
          reached.add(label);
          const outline = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
          expect(outline, label).not.toBe("none");
        }
      }
      expect([...reached].sort()).toEqual([...want].sort());
      await page.getByRole("button", { name: "Next card" }).focus();
      await page.keyboard.press("Enter");
      await expect(counter(page)).toHaveText("2 / 7");
    });

    test("the period switch asks for 30 days and starts at the first card", async ({ page }) => {
      const periods: string[] = [];
      await serveWrapped(page, periods);
      await page.goto("/app#/you");
      await expect(page.locator(".wrapped-card")).toHaveCount(CARD_COUNT);
      await page.getByRole("button", { name: "Next card" }).click();
      await expect(counter(page)).toHaveText("2 / 7");
      const month = page.getByRole("button", { name: "30 days" });
      await month.click();
      await expect(month).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByRole("button", { name: "7 days" })).toHaveAttribute("aria-pressed", "false");
      await expect(page.locator(".wrapped-card").nth(0)).toContainText("Your month");
      await expect(page.locator(".wrapped-card").nth(1)).toContainText("40");
      await expect(counter(page)).toHaveText("1 / 7");
      expect(periods).toEqual(["last 7 days", "last 30 days"]);
    });

    test("Download saves the current card as a PNG", async ({ page }) => {
      await serveWrapped(page);
      await page.goto("/app#/you");
      await expect(page.locator(".wrapped-card")).toHaveCount(CARD_COUNT);
      await page.getByRole("button", { name: "Next card" }).click();
      await expect(counter(page)).toHaveText("2 / 7");
      const width = (await page.locator(".wrapped-card").nth(1).boundingBox())!.width;
      const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download" }).click()]);
      expect(download.suggestedFilename()).toBe("wissel-wrapped-2026-10-11-merged.png");
      const bytes = readFileSync((await download.path())!);
      // PNG signature, then IHDR's width: the card at 2x.
      expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(Math.abs(bytes.readUInt32BE(16) - Math.round(width * 2))).toBeLessThanOrEqual(2);
      expect(bytes.length).toBeGreaterThan(2000);
      await expect(page.locator(".wrapped-status")).toHaveText("Saved wissel-wrapped-2026-10-11-merged.png.");
    });

    test("Share hands the PNG to navigator.share when the browser has it", async ({ page }) => {
      await page.addInitScript(() => {
        const w = window as unknown as { __shared: { name: string; type: string; size: number; title?: string; text?: string }[] };
        w.__shared = [];
        Object.defineProperty(navigator, "canShare", { configurable: true, value: (d: ShareData) => !!d.files?.length });
        Object.defineProperty(navigator, "share", {
          configurable: true,
          value: async (d: ShareData) => {
            for (const f of d.files ?? []) w.__shared.push({ name: f.name, type: f.type, size: f.size, title: d.title, text: d.text });
          },
        });
      });
      await serveWrapped(page);
      await page.goto("/app#/you");
      await expect(page.locator(".wrapped-card")).toHaveCount(CARD_COUNT);
      await page.locator(".wrapped-track").evaluate((el) => el.scrollTo({ left: el.clientWidth * 4 }));
      await expect(counter(page)).toHaveText("5 / 7");
      await page.getByRole("button", { name: "Share" }).click();
      await expect(page.locator(".wrapped-status")).toHaveText("Shared.");
      const shared = await page.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared);
      expect(shared).toEqual([{ name: "wissel-wrapped-2026-10-11-streak.png", type: "image/png", size: expect.any(Number), title: "Wissel Wrapped", text: "Merge streak: 5" }]);
      expect((shared[0] as { size: number }).size).toBeGreaterThan(2000);
    });

    test("no Share button where the browser has no navigator.share", async ({ page }) => {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
      });
      await serveWrapped(page);
      await page.goto("/app#/you");
      await expect(page.locator(".wrapped-card")).toHaveCount(CARD_COUNT);
      await expect(page.getByRole("button", { name: "Download" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Share" })).toHaveCount(0);
    });

    test("agents have faces; a running card's agent pulses as working, live over /events", async ({ page, request }) => {
      const title = `Pulse ${vp.name} ${Date.now()}`;
      await serveWrapped(page);
      await page.goto(vp.desktop ? "/app#/board" : "/app#/you");
      const id = await routedCard(request, title, "implementer", "running");

      // Board tab (and the Live panel on desktop): the card's row shows
      // the implementer's face, working.
      await page.goto("/app#/board");
      const row = page.locator(".lane-running.task-row", { hasText: title }).first();
      const face = row.locator(".avatar");
      await expect(face).toHaveText("Im");
      await expect(face).toHaveAttribute("data-working", "");
      await expect(row).toContainText("Implementer");
      if (vp.desktop) {
        const atWork = page.locator(".live .at-work");
        await expect(atWork.locator(".at-work-row", { hasText: "Implementer" })).toBeVisible();
      }

      // The You tab lists who is at work.
      await page.goto("/app#/you");
      const atWork = page.locator(".you-screen .at-work");
      await expect(atWork.locator(".at-work-row", { hasText: title })).toBeVisible();
      await expect(atWork.locator(".at-work-row", { hasText: "Implementer" }).locator(".avatar[data-working]")).toBeVisible();

      // Done: the pulse stops without a reload.
      expect((await request.post(`/tasks/${id}/move`, { data: { status: "done" } })).ok()).toBe(true);
      await expect(atWork.locator(".at-work-row", { hasText: title })).toHaveCount(0, { timeout: 5000 });
      await noSideways(page);
    });

    test("an agent with no persona gets a derived face; reduced motion keeps the ring, drops the pulse", async ({ page, request }) => {
      const title = `Derived ${vp.name} ${Date.now()}`;
      await routedCard(request, title, "triager", "running");
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/app#/board");
      const face = page.locator(".lane-running.task-row", { hasText: title }).first().locator(".avatar");
      await expect(face).toHaveText("Tr");
      const style = await face.evaluate((el) => ({ animation: getComputedStyle(el).animationName, ring: getComputedStyle(el).boxShadow }));
      expect(style.animation).toBe("none");
      expect(style.ring).not.toBe("none");
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await expect.poll(() => face.evaluate((el) => getComputedStyle(el).animationName)).toBe("working");
    });
  });
}

test("GET /wrapped answers the real numbers' shape; a long period is a 400", async ({ request }) => {
  const res = await request.get("/wrapped");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as Record<string, unknown> & { period: { days: number; input: string }; streak: { week: boolean[] } };
  expect(Object.keys(body).sort()).toEqual(["agentRuns", "cardsMerged", "commits", "lesson", "period", "pipelinesAdded", "spendUsd", "streak", "topAgent"]);
  expect(body.period).toMatchObject({ input: "last 7 days", days: 7 });
  expect(body.streak.week).toHaveLength(7);
  const month = (await (await request.get(`/wrapped?period=${encodeURIComponent("last 30 days")}`)).json()) as { period: { days: number } };
  expect(month.period.days).toBe(30);
  expect((await request.get(`/wrapped?period=${"x".repeat(101)}`)).status()).toBe(400);
});

test("the You tab draws the real endpoint's answer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app#/you");
  await expect(page.locator(".wrapped-card")).not.toHaveCount(0);
  await expect(page.locator(".wrapped-card").nth(0)).toContainText("Your week");
  await expect(page.locator(".wrapped-card[data-card='streak']")).toContainText("Merge streak");
});
