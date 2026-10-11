/// <reference lib="dom" />
import { test, expect, type Page } from "@playwright/test";

// docs/SDD-wissel-app.md §3.4 and §4.2 (card 4): the Ask screen with the
// scripted concierge (e2e/fixtures/concierge-script.json, set by
// playwright.config.ts's WISSEL_CONCIERGE_SCRIPT), at phone (390 px) and
// desktop (1440 px) widths. "create a card to check the README" makes
// exactly one card, and its chip follows the board over /events.
//
// The e2e board is shared by every spec, so each test finds its own
// card by the id the reply names, never by counting the board.

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

async function noSideways(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll, "page scrolls sideways").toBeLessThanOrEqual(client);
}

/** Each test starts a fresh chat: the open chat is kept in localStorage.
 *  Cleared once per tab (sessionStorage marks it), so a reload in the
 *  test still reopens the chat. */
async function openAsk(page: Page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("ask-e2e-cleared")) return;
    localStorage.removeItem("wissel.app.askConversation");
    sessionStorage.setItem("ask-e2e-cleared", "1");
  });
  await page.goto("/app#/ask");
  await expect(page.getByRole("heading", { level: 1, name: "Ask wissel" })).toBeVisible();
}

const log = (page: Page) => page.getByRole("log", { name: "Messages" });

for (const vp of VIEWPORTS) {
  test.describe(`Ask at ${vp.width}px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("'create a card to check the README' makes one card whose chip follows the board", async ({ page, request }) => {
      const before = ((await (await request.get("/tasks")).json()) as { title: string }[]).filter((t) => t.title === "Check the README").length;
      await openAsk(page);

      const box = page.getByRole("textbox", { name: "Message" });
      await box.fill("create a card to check the README");
      await box.press("Enter");

      // Milton's bubble at once; the reply with its chip and cost.
      await expect(log(page).getByText("create a card to check the README")).toBeVisible();
      await expect(log(page).getByText("Made a card to check the README.")).toBeVisible();
      await expect(log(page).getByText("$0.042")).toBeVisible();
      const chip = log(page).getByRole("link", { name: /Check the README/ });
      await expect(chip).toBeVisible();
      await expect(chip).toContainText("Queued");

      // Exactly one card made.
      const after = ((await (await request.get("/tasks")).json()) as { id: string; title: string }[]).filter((t) => t.title === "Check the README");
      expect(after).toHaveLength(before + 1);
      const href = await chip.getAttribute("href");
      const id = decodeURIComponent(href!.replace("#/board/", ""));
      expect(after.map((t) => t.id)).toContain(id);

      // No reload: the chip follows the board over the shared EventSource.
      await request.post(`/tasks/${id}/move`, { data: { status: "running" } });
      await expect(chip).toContainText("Running");
      await request.post(`/tasks/${id}/move`, { data: { status: "done" } });
      await expect(chip).toContainText("Done");

      await noSideways(page);
      await chip.click();
      await expect(page).toHaveURL(new RegExp(`#/board/${id}$`));
      await expect(page.getByRole("heading", { level: 1, name: "Check the README" })).toBeVisible();
    });

    test("a merge request takes no action and says so; the chat survives a reload", async ({ page }) => {
      await openAsk(page);
      await page.getByRole("textbox", { name: "Message" }).fill("merge the README card");
      await page.getByRole("button", { name: "Send" }).click();
      await expect(log(page).getByText("Merging is done on the board.")).toBeVisible();
      await expect(log(page).getByText("- merge: not something Ask can do; use the board")).toBeVisible();
      await expect(log(page).getByRole("link")).toHaveCount(0);

      await page.reload();
      await expect(log(page).getByText("merge the README card")).toBeVisible();
      await expect(log(page).getByText("Merging is done on the board.")).toBeVisible();

      // New chat empties it; Earlier chats brings it back.
      await page.getByRole("button", { name: "New chat" }).click();
      await expect(log(page).getByText("merge the README card")).toHaveCount(0);
      await page.getByText("Earlier chats").click();
      await page.getByRole("button", { name: /merge the README card/ }).first().click();
      await expect(log(page).getByText("Merging is done on the board.")).toBeVisible();
    });

    test("quick replies send from code, Show board is a link; keyboard alone works", async ({ page }) => {
      await openAsk(page);
      const replies = page.getByRole("list", { name: "Quick replies" });
      await expect(replies.getByRole("link", { name: "Show board" })).toHaveAttribute("href", "#/board");
      await replies.getByRole("button", { name: "What is running?" }).click();
      await expect(log(page).getByText("Nothing is running right now.")).toBeVisible();

      // Tab into the composer, type, Enter: no mouse.
      await page.keyboard.press("Tab");
      let reached = false;
      for (let i = 0; i < 40 && !reached; i++) {
        reached = await page.evaluate(() => document.activeElement?.id === "ask-input");
        if (!reached) await page.keyboard.press("Tab");
      }
      expect(reached).toBe(true);
      await page.keyboard.type("what did I do this week");
      await page.keyboard.press("Enter");
      await expect(log(page).getByText("what did I do this week")).toBeVisible();
      await expect(log(page).getByText("Nothing is running right now.")).toHaveCount(2);

      // Shift+Enter is a new line, not a send.
      const box = page.getByRole("textbox", { name: "Message" });
      await box.type("line one");
      await box.press("Shift+Enter");
      await box.type("line two");
      await expect(box).toHaveValue("line one\nline two");
      await noSideways(page);
    });
  });
}

test("a second tab gets a message sent elsewhere, live over the named ask event", async ({ page, context, request }) => {
  await openAsk(page);
  await page.getByRole("textbox", { name: "Message" }).fill("what is running");
  await page.getByRole("textbox", { name: "Message" }).press("Enter");
  await expect(log(page).getByText("Nothing is running right now.")).toBeVisible();
  const conversationId = await page.evaluate(() => localStorage.getItem("wissel.app.askConversation"));
  expect(conversationId).toBeTruthy();

  // The second tab has the same chat open (same localStorage), and gets
  // a message sent from elsewhere (the API) without a reload.
  const other = await context.newPage();
  await other.goto("/app#/ask");
  await expect(log(other).getByText("Nothing is running right now.")).toHaveCount(1);
  const res = await request.post("/ask", { data: { conversationId, text: "what did I do" } });
  expect(res.ok()).toBe(true);
  await expect(log(other).getByText("what did I do", { exact: true })).toBeVisible();
  await expect(log(other).getByText("Nothing is running right now.")).toHaveCount(2);
});

// Regression: a phone sent its message while the EventSource was still
// connecting, missed task.created, and the new card's chip read "Gone"
// until some later board event. The reply now waits for a /tasks
// refetch, so the chip is right with no event at all.
test("a new card's chip is right even when the board event is missed", async ({ page }) => {
  await page.route("**/events", (route) => route.abort());
  await openAsk(page);
  await page.getByRole("textbox", { name: "Message" }).fill("create a card to check the README");
  await page.getByRole("textbox", { name: "Message" }).press("Enter");
  const chip = log(page).getByRole("link", { name: /Check the README/ });
  await expect(chip).toContainText("Queued");
  await expect(chip).not.toContainText("Gone");
});

test("POST /ask validates its body and GET /conversations lists the chat", async ({ request }) => {
  expect((await request.post("/ask", { data: { text: "  " } })).status()).toBe(400);
  expect((await request.post("/ask", { data: { text: "hi", conversationId: "nope" } })).status()).toBe(404);
  const made = (await (await request.post("/ask", { data: { text: "what is running" } })).json()) as { conversation: { id: string } };
  const list = (await (await request.get("/conversations")).json()) as { id: string }[];
  expect(list.map((c) => c.id)).toContain(made.conversation.id);
  const one = (await (await request.get(`/conversations/${made.conversation.id}`)).json()) as { messages: { role: string }[] };
  expect(one.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
});

test("reduced motion stops the thinking dots", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openAsk(page);
  // Hold the reply so "Thinking" stays on screen.
  await page.route("/ask", async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page.getByRole("textbox", { name: "Message" }).fill("what is running");
  await page.getByRole("textbox", { name: "Message" }).press("Enter");
  const dot = page.locator(".dots span").first();
  await expect(dot).toBeVisible();
  expect(await dot.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
});
