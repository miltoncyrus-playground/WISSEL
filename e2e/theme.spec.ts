/// <reference lib="dom" />
import { test, expect } from "@playwright/test";

// The light and dark token blocks (SDD-dark-mode-toggle.md §2.3) share the
// exact same values, so this page's real light --page and dark --page can
// stand in as ground truth for "did the CSS actually apply" without
// hardcoding a second copy of the palette here.
const LIGHT_PAGE_BG = "rgb(249, 249, 247)"; // --page: #f9f9f7
const DARK_PAGE_BG = "rgb(13, 13, 13)"; // --page: #0d0d0d

function pageBg(page: import("@playwright/test").Page) {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

test.describe("Theme toggle", () => {
  test("clicking Light/Dark/Auto sets data-theme and updates aria-pressed", async ({ page }) => {
    await page.goto("/board");

    const light = page.locator('#themeToggle button[data-theme-choice="light"]');
    const dark = page.locator('#themeToggle button[data-theme-choice="dark"]');
    const auto = page.locator('#themeToggle button[data-theme-choice=""]');

    // Auto is the default — no data-theme attribute at all.
    await expect(auto).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);

    await dark.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(dark).toHaveAttribute("aria-pressed", "true");
    await expect(light).toHaveAttribute("aria-pressed", "false");
    await expect(auto).toHaveAttribute("aria-pressed", "false");

    await light.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(light).toHaveAttribute("aria-pressed", "true");
    await expect(dark).toHaveAttribute("aria-pressed", "false");

    await auto.click();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
    await expect(auto).toHaveAttribute("aria-pressed", "true");
  });

  test("choosing a theme actually changes the computed background color, not just the attribute", async ({ page }) => {
    await page.goto("/board");
    await expect(async () => expect(await pageBg(page)).toBe(LIGHT_PAGE_BG)).toPass();

    await page.locator('#themeToggle button[data-theme-choice="dark"]').click();
    await expect(async () => expect(await pageBg(page)).toBe(DARK_PAGE_BG)).toPass();

    await page.locator('#themeToggle button[data-theme-choice="light"]').click();
    await expect(async () => expect(await pageBg(page)).toBe(LIGHT_PAGE_BG)).toPass();
  });

  test("an explicit Light choice overrides a dark OS preference (the :not([data-theme=\"light\"]) guard)", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/board");
    await expect(async () => expect(await pageBg(page)).toBe(DARK_PAGE_BG)).toPass();

    await page.locator('#themeToggle button[data-theme-choice="light"]').click();
    await expect(async () => expect(await pageBg(page)).toBe(LIGHT_PAGE_BG)).toPass();
  });

  test("the choice survives a reload, applied before first paint with no flash", async ({ page }) => {
    await page.goto("/board");
    await page.locator('#themeToggle button[data-theme-choice="dark"]').click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await page.reload();
    // The inline early-restore <script> in <head> sets this before body
    // render, so it should already be correct at DOMContentLoaded, not
    // just eventually after the bottom-of-file IIFE runs.
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator('#themeToggle button[data-theme-choice="dark"]')).toHaveAttribute("aria-pressed", "true");
    await expect(async () => expect(await pageBg(page)).toBe(DARK_PAGE_BG)).toPass();
  });

  test("Auto with no stored preference falls back to whatever the OS media query would apply", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/board");
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
    await expect(async () => expect(await pageBg(page)).toBe(DARK_PAGE_BG)).toPass();

    await page.emulateMedia({ colorScheme: "light" });
    await expect(async () => expect(await pageBg(page)).toBe(LIGHT_PAGE_BG)).toPass();
  });
});
