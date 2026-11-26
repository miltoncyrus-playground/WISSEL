import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { findInternalVocabulary } from "../src/core/user-vocabulary.ts";

// docs/cards/ui-vocabulary-pass.md card 3: the board in user mode shows
// none of FORBIDDEN_IN_USER_MODE, and operator mode — the default —
// renders exactly what it rendered before user mode existed.

/** Every card this file made, deleted after each test so the shared
 *  e2e server's Needs you strip is as the next spec expects it. */
const seeded: string[] = [];

/** A card in each failure state user mode re-words. */
async function seedFailures(request: APIRequestContext) {
  const ids: Record<string, string> = {};
  for (const status of ["escalated", "no-match", "failed"] as const) {
    const created = await request.post("/tasks", { data: { title: `User mode fixture ${status}`, body: "x", labels: ["code"], repo: "." } });
    const id = (await created.json()).id as string;
    seeded.push(id);
    const moved = await request.post(`/tasks/${id}/move`, { data: { status } });
    expect(moved.ok(), `move to ${status}: ${await moved.text()}`).toBe(true);
    ids[status] = id;
  }
  return ids;
}

/** What a person can read: visible text and visible title / aria-label /
 *  placeholder values, leaving out anything marked as their own words
 *  (titles, descriptions, agent output). */
async function readableText(page: Page, opts: { skipUserContent: boolean }): Promise<string> {
  return page.evaluate(({ skipUserContent }) => {
    const out: string[] = [];
    const visible = (el: Element) => (el as HTMLElement).checkVisibility?.({ checkOpacity: false, checkVisibilityCSS: true }) ?? true;
    const skip = (el: Element) => el.closest("script, style, template" + (skipUserContent ? ", [data-user-content]" : "")) !== null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.nodeType === 1 ? (n as Element) : n.parentElement;
      if (!el || skip(el) || !visible(el)) continue;
      if (n.nodeType === 3) out.push(n.nodeValue ?? "");
      else for (const a of ["title", "aria-label", "placeholder"]) { const v = el.getAttribute(a); if (v) out.push(v); }
    }
    return out.join(" ").replace(/\s+/g, " ").trim();
  }, opts);
}

/** Words only: counts and clocks on a live board move between two loads
 *  (another card arriving, a minute passing) and say nothing about mode. */
function words(text: string): string {
  return text.replace(/\d+/g, "#");
}

async function openBoard(page: Page, query = "") {
  await page.goto(`/board${query}`);
  await expect(page.locator('#needsYou .kcard').first()).toBeVisible();
  await page.waitForLoadState("networkidle");
}

test.describe("Board user mode", () => {
  test.afterEach(async ({ request }) => {
    for (const id of seeded.splice(0)) await request.delete(`/tasks/${id}`);
  });

  test("in user mode the board shows no internal vocabulary, and a failure says what happened with its action", async ({ page, request }) => {
    const ids = await seedFailures(request);
    await openBoard(page, "?mode=user");
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "user");

    await expect.poll(async () => findInternalVocabulary(await readableText(page, { skipUserContent: true }))).toEqual([]);

    // Setup is still there, behind Advanced; nothing removed.
    await expect(page.locator("details.um-advanced > summary")).toHaveText("Advanced");
    await expect(page.locator('details.um-advanced a[href="#/setup/harnesses"]')).toHaveCount(1);

    // The no-match card says what happened and offers its action.
    const card = page.locator(`#needsYou .kcard[data-task-id="${ids["no-match"]}"]`);
    await expect(card.locator(".kreason")).toContainText("can do this");
    await expect(card.getByRole("button", { name: "Open" })).toBeVisible();

    // The drawer leads with the sentence; the raw output is one click away.
    await card.locator(".kt").click();
    await expect(page.locator("#tdUserFailure .um-sentence")).toContainText("can do this");
    await expect(page.locator("#tdUserFailure")).toContainText("Show the agent's output");
    await expect.poll(async () => findInternalVocabulary(await readableText(page, { skipUserContent: true }))).toEqual([]);
  });

  test("in operator mode the rendered text is unchanged from the board without user mode", async ({ page, request }) => {
    await seedFailures(request);

    // Before this card: the board with no user-mode script at all.
    await page.route("**/user-mode.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
    await openBoard(page);
    const before = words(await readableText(page, { skipUserContent: false }));
    const beforeHtmlMode = await page.locator("html").getAttribute("data-ui-mode");
    await page.unroute("**/user-mode.js");

    // After: the real script, in the default mode and asked for by name.
    await openBoard(page);
    expect(await page.evaluate(() => (window as unknown as { WisselUserMode?: { mode: string } }).WisselUserMode?.mode)).toBe("operator");
    expect(words(await readableText(page, { skipUserContent: false }))).toBe(before);
    await openBoard(page, "?mode=operator");
    expect(words(await readableText(page, { skipUserContent: false }))).toBe(before);

    expect(beforeHtmlMode).toBeNull();
    await expect(page.locator("html")).not.toHaveAttribute("data-ui-mode", /.*/);
    await expect(page.locator("details.um-advanced")).toHaveCount(0);
  });

  test("a stored wissel.uiMode is honoured when the URL does not say", async ({ page, request }) => {
    await seedFailures(request);
    await page.addInitScript(() => { try { localStorage.setItem("wissel.uiMode", "user"); } catch {} });
    await openBoard(page);
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "user");
    await openBoard(page, "?mode=operator");
    await expect(page.locator("html")).not.toHaveAttribute("data-ui-mode", /.*/);
  });
});
