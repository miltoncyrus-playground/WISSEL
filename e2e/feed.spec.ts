/// <reference lib="dom" />
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

// docs/SDD-wissel-app.md §3.2 and §4.2 (card 2): the Feed screen,
// Stories rings and the full-screen story viewer, at phone (390 px) and
// desktop (1440 px) widths. The board is the e2e server's in-memory one,
// shared by every spec, so each test makes its own uniquely named cards
// and only asserts on those.

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

const REPO = "/tmp/wissel-e2e-repo";

async function createCard(request: APIRequestContext, title: string, status?: string): Promise<string> {
  const res = await request.post("/tasks", { data: { title, body: "from feed.spec", labels: ["code"], repo: REPO } });
  expect(res.ok()).toBe(true);
  const { id } = (await res.json()) as { id: string };
  if (status) expect((await request.post(`/tasks/${id}/move`, { data: { status } })).ok()).toBe(true);
  return id;
}

async function noSideways(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll, "page scrolls sideways").toBeLessThanOrEqual(client);
}

function feedItem(page: Page, title: string) {
  return page.getByRole("list", { name: "Feed" }).getByRole("article", { name: title });
}

test("GET /feed answers typed items, newest first, and refuses a bad limit", async ({ request }) => {
  const title = `Feed API ${Date.now()}`;
  const id = await createCard(request, title, "done");
  const res = await request.get("/feed?limit=200");
  expect(res.ok()).toBe(true);
  const page = (await res.json()) as { items: { id: string; kind: string; at: string; taskId?: string }[]; next: string | null };
  const mine = page.items.find((i) => i.taskId === id);
  expect(mine).toMatchObject({ id: `landed:${id}`, kind: "landed" });
  const times = page.items.map((i) => Date.parse(i.at));
  expect([...times].sort((a, b) => b - a)).toEqual(times);
  expect((await request.get("/feed?limit=0")).status()).toBe(400);
});

for (const vp of VIEWPORTS) {
  test.describe(`Feed at ${vp.width}px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("shows landed and needs-you cards, with real controls and no sideways scroll", async ({ page, request }) => {
      const stamp = `${vp.name} ${Date.now()}`;
      const landed = `Landed card ${stamp}`;
      const failed = `Failed card ${stamp}`;
      const landedId = await createCard(request, landed, "done");
      await createCard(request, failed, "failed");

      await page.goto("/app#/feed");
      await expect(page.getByRole("heading", { level: 1, name: "Feed" })).toBeVisible();

      const l = feedItem(page, landed);
      await expect(l).toBeVisible();
      await expect(l).toHaveAttribute("data-kind", "landed");
      await expect(l.getByRole("link", { name: "Open" })).toHaveAttribute("href", `/app#/board/${landedId}`);

      const f = feedItem(page, failed);
      await expect(f).toHaveAttribute("data-kind", "needs-you");
      await expect(f.getByText("Failed", { exact: true })).toBeVisible();
      // Retry is a real button (it POSTs the board's own endpoint); not
      // clicked here, since a retry would dispatch a real agent.
      await expect(f.getByRole("button", { name: "Retry" })).toBeVisible();

      await expect(page.getByRole("navigation", { name: "Stories" }).getByRole("button", { name: /^Landed: \d+ items?, new$/ })).toBeVisible();
      await noSideways(page);

      const fakes = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>('[tabindex], [role="button"], [role="link"], [onclick]'))
          .filter((el) => !["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "DIALOG"].includes(el.tagName))
          .map((el) => el.outerHTML.slice(0, 120)),
      );
      expect(fakes).toEqual([]);
    });

    test("a card moving to done appears in the open feed within 2 s, no reload", async ({ page, request }) => {
      const title = `Live landing ${vp.name} ${Date.now()}`;
      const id = await createCard(request, title, "running");
      await page.goto("/app#/feed");
      await expect(page.getByRole("heading", { level: 1, name: "Feed" })).toBeVisible();
      await expect(page.getByRole("list", { name: "Feed" })).toBeVisible();
      await expect(feedItem(page, title)).toHaveCount(0);

      await request.post(`/tasks/${id}/move`, { data: { status: "done" } });
      await expect(feedItem(page, title)).toBeVisible({ timeout: 2_000 });
      await expect(feedItem(page, title)).toHaveAttribute("data-kind", "landed");

      // And on to needs-you, live as well.
      await request.post(`/tasks/${id}/move`, { data: { status: "failed" } });
      await expect(feedItem(page, title)).toHaveAttribute("data-kind", "needs-you", { timeout: 2_000 });
    });

    test("Stories: a ring opens by keyboard, arrows step through, Escape closes and the ring goes seen", async ({ page, request }) => {
      const stamp = `${vp.name} ${Date.now()}`;
      await createCard(request, `Story one ${stamp}`, "done");
      await createCard(request, `Story two ${stamp}`, "done");

      await page.goto("/app#/feed");
      const ring = page.getByRole("navigation", { name: "Stories" }).getByRole("button", { name: /^Landed: / });
      await expect(ring).toHaveAccessibleName(/, new$/);

      // Keyboard only: Tab until the ring has focus, with a visible outline.
      let focused = false;
      for (let i = 0; i < 40 && !focused; i++) {
        await page.keyboard.press("Tab");
        focused = await ring.evaluate((el) => el === document.activeElement);
      }
      expect(focused, "the Landed ring is reachable by Tab").toBe(true);
      const outline = await ring.evaluate((el) => getComputedStyle(el.querySelector(".story-dot")!).outlineStyle);
      expect(outline).not.toBe("none");
      await page.keyboard.press("Enter");

      const viewer = page.getByRole("dialog", { name: "Landed story" });
      await expect(viewer).toBeVisible();
      const progress = viewer.getByRole("list", { name: /^Item \d+ of \d+$/ });
      await expect(progress).toHaveAccessibleName(/^Item 1 of /);
      await noSideways(page);
      if (vp.width < 600) {
        // Full screen on a phone.
        const box = await viewer.boundingBox();
        expect(Math.round(box!.width)).toBe(vp.width);
      }

      await page.keyboard.press("ArrowRight");
      await expect(progress).toHaveAccessibleName(/^Item 2 of /);
      await page.keyboard.press("ArrowLeft");
      await expect(progress).toHaveAccessibleName(/^Item 1 of /);

      // Tap targets are real, labelled buttons.
      await viewer.getByRole("button", { name: "Next" }).click();
      await expect(progress).toHaveAccessibleName(/^Item 2 of /);

      await page.keyboard.press("Escape");
      await expect(viewer).toBeHidden();

      // Watched: the ring's seen mark covers both cards, and survives a
      // reload (localStorage). Checked on the stored mark, not on the
      // ring's "new", because other spec files land cards on the same
      // shared board in parallel and may light the ring again.
      const feed = (await (await request.get("/feed?limit=200")).json()) as { items: { title: string; at: string }[] };
      const mine = feed.items.filter((i) => i.title.endsWith(stamp)).map((i) => Date.parse(i.at));
      expect(mine).toHaveLength(2);
      const seenLanded = () => page.evaluate(() => (JSON.parse(localStorage.getItem("wissel.app.storiesSeen") ?? "{}") as { landed?: number }).landed ?? 0);
      expect(await seenLanded()).toBeGreaterThanOrEqual(Math.max(...mine));
      await page.reload();
      await expect(ring).toBeVisible();
      expect(await seenLanded()).toBeGreaterThanOrEqual(Math.max(...mine));
    });
  });
}

test("on a phone, a swipe left moves on, a swipe right goes back, and the close button closes", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const stamp = `swipe ${Date.now()}`;
  await createCard(request, `Swipe one ${stamp}`, "done");
  await createCard(request, `Swipe two ${stamp}`, "done");
  await page.goto("/app#/feed");
  await page.getByRole("navigation", { name: "Stories" }).getByRole("button", { name: /^Landed: / }).click();
  const viewer = page.getByRole("dialog", { name: "Landed story" });
  const progress = viewer.getByRole("list", { name: /^Item \d+ of \d+$/ });
  await expect(progress).toHaveAccessibleName(/^Item 1 of /);

  const swipe = async (fromX: number, toX: number) => {
    await page.mouse.move(fromX, 420);
    await page.mouse.down();
    await page.mouse.move((fromX + toX) / 2, 422, { steps: 4 });
    await page.mouse.move(toX, 424, { steps: 4 });
    await page.mouse.up();
  };
  await swipe(320, 80);
  await expect(progress).toHaveAccessibleName(/^Item 2 of /);
  await swipe(80, 320);
  await expect(progress).toHaveAccessibleName(/^Item 1 of /);

  await viewer.getByRole("button", { name: "Close story" }).click();
  await expect(viewer).toBeHidden();
});

test("the story viewer has no animation, so reduced motion needs nothing extra", async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await createCard(request, `Motion ${Date.now()}`, "done");
  await page.goto("/app#/feed");
  await page.getByRole("navigation", { name: "Stories" }).getByRole("button", { name: /^Landed: / }).click();
  const viewer = page.getByRole("dialog", { name: "Landed story" });
  await expect(viewer).toBeVisible();
  const moving = await viewer.evaluate((root) =>
    [root, ...Array.from(root.querySelectorAll("*"))]
      .map((el) => getComputedStyle(el))
      .filter((s) => s.animationName !== "none" || s.transitionDuration.split(",").some((d) => parseFloat(d) > 0)).length,
  );
  expect(moving).toBe(0);
});
