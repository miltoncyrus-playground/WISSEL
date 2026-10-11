/// <reference lib="dom" />
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

// docs/SDD-wissel-app.md §3.7 (card 7): Ask controls the board, with the
// scripted concierge (e2e/fixtures/concierge-script.json; its `$1` is the
// card named in the message). A Tier A archive runs at once and shows a
// chip with Undo; a Tier B delete waits for the Confirm tap; Cancel and
// expiry do nothing; an ambiguous card gets a question. Phone (390 px)
// and desktop (1440 px).
//
// The e2e board is shared by every spec, so each test makes its own
// cards with a unique `ctl-` name and only ever archives or deletes
// those. Nothing here merges, discards or touches a harness.

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

let seq = 0;
/** A name no other test or run uses. */
const unique = (kind: string, width: number) => `ctl-${kind}-${width}-${Date.now().toString(36)}${(seq++).toString(36)}`;

async function makeCard(request: APIRequestContext, title: string): Promise<{ id: string; title: string }> {
  const res = await request.post("/tasks", { data: { title, body: "e2e control card", labels: ["docs"] } });
  expect(res.status()).toBe(201);
  return (await res.json()) as { id: string; title: string };
}

async function noSideways(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll, "page scrolls sideways").toBeLessThanOrEqual(client);
}

async function openAsk(page: Page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("ask-control-e2e-cleared")) return;
    localStorage.removeItem("wissel.app.askConversation");
    sessionStorage.setItem("ask-control-e2e-cleared", "1");
  });
  await page.goto("/app#/ask");
  await expect(page.getByRole("heading", { level: 1, name: "Ask wissel" })).toBeVisible();
}

async function send(page: Page, text: string) {
  const box = page.getByRole("textbox", { name: "Message" });
  await box.fill(text);
  await box.press("Enter");
  await expect(log(page).getByText(text, { exact: true })).toBeVisible();
}

const log = (page: Page) => page.getByRole("log", { name: "Messages" });
const id8 = (id: string) => id.slice(0, 8);
const card = (request: APIRequestContext, id: string) => request.get(`/tasks/${id}`);

for (const vp of VIEWPORTS) {
  test.describe(`Ask controls at ${vp.width}px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("a Tier A archive runs at once with a green chip; Undo puts it back", async ({ page, request }) => {
      const name = unique("arc", vp.width);
      const made = await makeCard(request, `${name} old notes`);
      await openAsk(page);
      await send(page, `archive card ${name}`);

      const sentence = `Archived '${made.title}' (card ${id8(made.id)}).`;
      const results = log(page).getByRole("list", { name: "What was done" });
      await expect(results.getByRole("link", { name: sentence })).toBeVisible();
      await expect(results.locator(".tone-result-done")).toHaveCount(1);
      expect(((await (await card(request, made.id)).json()) as { archivedAt?: string }).archivedAt).toBeTruthy();
      await noSideways(page);

      // Undo, by keyboard: focus it and press Enter.
      const undo = results.getByRole("button", { name: `Undo: ${sentence}` });
      await undo.focus();
      await expect(undo).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(results.getByText("Undone")).toBeVisible();
      await expect(undo).toHaveCount(0);
      await expect.poll(async () => ((await (await card(request, made.id)).json()) as { archivedAt?: string }).archivedAt ?? null).toBeNull();
    });

    test("a Tier B delete does nothing until Confirm is tapped, then deletes", async ({ page, request }) => {
      const name = unique("del", vp.width);
      const made = await makeCard(request, `${name} scratch`);
      await openAsk(page);
      await send(page, `delete card ${name}`);

      const confirmCard = log(page).getByRole("group", { name: "Waiting for your Confirm" });
      await expect(confirmCard).toBeVisible();
      await expect(confirmCard.getByText(`Delete '${made.title}' (card ${id8(made.id)})`)).toBeVisible();
      await expect(log(page).getByText("Waiting for your Confirm:")).toBeVisible();
      await noSideways(page);

      // Nothing happened: not now, and not a moment later either.
      expect((await card(request, made.id)).status()).toBe(200);
      await page.waitForTimeout(500);
      expect((await card(request, made.id)).status()).toBe(200);

      await confirmCard.getByRole("button", { name: "Confirm" }).click();
      await expect(confirmCard.getByText("Done")).toBeVisible();
      await expect(confirmCard.getByRole("button", { name: "Confirm" })).toHaveCount(0);
      await expect(log(page).getByRole("list", { name: "What was done" }).getByText(`Deleted '${made.title}' (card ${id8(made.id)}).`)).toBeVisible();
      await expect.poll(async () => (await card(request, made.id)).status()).toBe(404);
    });

    test("Cancel does nothing and closes the card", async ({ page, request }) => {
      const name = unique("can", vp.width);
      const made = await makeCard(request, `${name} keep me`);
      await openAsk(page);
      await send(page, `delete card ${name}`);
      const confirmCard = log(page).getByRole("group", { name: "Waiting for your Confirm" });
      await confirmCard.getByRole("button", { name: "Cancel" }).click();
      await expect(confirmCard.getByText("Cancelled")).toBeVisible();
      await expect(confirmCard.getByRole("button", { name: "Confirm" })).toHaveCount(0);
      expect((await card(request, made.id)).status()).toBe(200);

      // A reload shows the same: the state is the server's.
      await page.reload();
      await expect(log(page).getByRole("group", { name: "Waiting for your Confirm" }).getByText("Cancelled")).toBeVisible();
    });

    test("an ambiguous card gets a question, never an action", async ({ page, request }) => {
      const name = unique("amb", vp.width);
      const a = await makeCard(request, `${name} one`);
      const b = await makeCard(request, `${name} two`);
      await openAsk(page);
      await send(page, `run card ${name}`);
      await expect(log(page).getByText(`Which card should I run: '${a.title}' (card ${id8(a.id)}) or '${b.title}' (card ${id8(b.id)})?`, { exact: false })).toBeVisible();
      await expect(log(page).getByRole("group", { name: "Waiting for your Confirm" })).toHaveCount(0);
      await expect(log(page).getByRole("list", { name: "What was done" })).toHaveCount(0);
      for (const t of [a, b]) expect(((await (await card(request, t.id)).json()) as { status: string }).status).toBe("inbox");
      await noSideways(page);
    });

    test("the new quick replies are there and reachable", async ({ page }) => {
      await openAsk(page);
      const replies = page.getByRole("list", { name: "Quick replies" });
      for (const label of ["What needs me?", "Retry failed", "Show harnesses"]) await expect(replies.getByRole("button", { name: label })).toBeVisible();
      await noSideways(page);
    });
  });
}

test("expiry: after 10 minutes the card reads Expired and offers no Confirm; nothing was deleted", async ({ page, request }) => {
  await page.clock.install();
  const name = unique("exp", 0);
  const made = await makeCard(request, `${name} stays`);
  await openAsk(page);
  await send(page, `delete card ${name}`);
  const confirmCard = log(page).getByRole("group", { name: "Waiting for your Confirm" });
  await expect(confirmCard.getByRole("button", { name: "Confirm" })).toBeVisible();
  // The client's clock passes the expiry; the server refuses a late
  // Confirm on its own clock (test/ask-control-api.test.ts).
  await page.clock.fastForward("11:00");
  await expect(confirmCard.getByText("Expired. Ask again to do it.")).toBeVisible();
  await expect(confirmCard.getByRole("button", { name: "Confirm" })).toHaveCount(0);
  expect((await card(request, made.id)).status()).toBe(200);
});

test("another tab sees a Confirm tapped elsewhere, live over the ask event", async ({ page, context, request }) => {
  const name = unique("tab", 1);
  const made = await makeCard(request, `${name} two tabs`);
  await openAsk(page);
  await send(page, `delete card ${name}`);
  const other = await context.newPage();
  await other.goto("/app#/ask");
  const there = log(other).getByRole("group", { name: "Waiting for your Confirm" });
  await expect(there.getByRole("button", { name: "Confirm" })).toBeVisible();

  await log(page).getByRole("group", { name: "Waiting for your Confirm" }).getByRole("button", { name: "Confirm" }).click();
  await expect(there.getByText("Done")).toBeVisible();
  await expect.poll(async () => (await card(request, made.id)).status()).toBe(404);
});

test("reduced motion: the Confirm card and chips add no animation", async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const name = unique("rm", 2);
  await makeCard(request, `${name} motion`);
  await openAsk(page);
  await send(page, `delete card ${name}`);
  const confirmCard = log(page).getByRole("group", { name: "Waiting for your Confirm" });
  await expect(confirmCard).toBeVisible();
  expect(await confirmCard.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
});
