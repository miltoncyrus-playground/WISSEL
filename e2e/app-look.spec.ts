/// <reference lib="dom" />
import { test, expect } from "@playwright/test";

// docs/SDD-wissel-app.md §3.1: the news-site look. Light by default, dark
// under prefers-color-scheme, header nav on desktop, tab bar on phone.
// Set SHOTS_DIR to also write a screenshot of every screen (used to
// review the look; off by default).

const LIGHT_GROUND = "rgb(255, 255, 255)"; // --ground: #FFFFFF
const DARK_GROUND = "rgb(13, 17, 14)"; // --ground: #0D110E
const SCREENS = ["feed", "ask", "board", "listen", "you"] as const;

const bg = (page: import("@playwright/test").Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test.describe("light and dark", () => {
  test("light is the default", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/app#/feed");
    await expect(async () => expect(await bg(page)).toBe(LIGHT_GROUND)).toPass();
  });

  test("an OS dark preference gets the dark set, and switching back gets light again", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/app#/feed");
    await expect(async () => expect(await bg(page)).toBe(DARK_GROUND)).toPass();
    await page.emulateMedia({ colorScheme: "light" });
    await expect(async () => expect(await bg(page)).toBe(LIGHT_GROUND)).toPass();
  });

  test("the primary button text reads on the green in both sets (computed contrast >= 4.5)", async ({ page }) => {
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/app#/feed");
      const ratio = await page.evaluate(() => {
        const probe = document.createElement("button");
        probe.className = "btn btn-primary";
        document.body.append(probe);
        const cs = getComputedStyle(probe);
        const lum = (rgb: string) => {
          const [r, g, b] = rgb.match(/\d+/g)!.map(Number).map((c) => {
            const s = c! / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
        };
        const a = lum(cs.color);
        const b = lum(cs.backgroundColor);
        probe.remove();
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      });
      expect(ratio, scheme).toBeGreaterThanOrEqual(4.5);
    }
  });
});

test.describe("desktop shell at 1440px", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the nav is a header across the top, not a left rail", async ({ page }) => {
    await page.goto("/app#/feed");
    const nav = page.getByRole("navigation", { name: "Screens" });
    const box = (await nav.boundingBox())!;
    expect(box.y).toBeLessThan(120);
    expect(box.width).toBeGreaterThan(1000);
    // every screen link sits on one row
    const tops = await nav.locator(".rail-link").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    expect(tops).toHaveLength(5);
    expect(new Set(tops).size).toBe(1);
  });

  test("the brand is a green mark and the word, and the link name stays 'wissel'", async ({ page }) => {
    await page.goto("/app#/feed");
    await expect(page.getByRole("link", { name: "wissel", exact: true }).first()).toBeVisible();
    await expect(page.locator(".rail .brand-mark")).toBeVisible();
  });

  test("the Live panel stays on the right", async ({ page }) => {
    await page.goto("/app#/feed");
    const live = (await page.locator(".live").boundingBox())!;
    expect(live.x).toBeGreaterThan(1000);
  });
});

test.describe("phone shell at 390px", () => {
  test.use({ viewport: { width: 390, height: 800 } });

  test("tab bar at the bottom, no sideways scroll on any screen", async ({ page }) => {
    for (const s of SCREENS) {
      await page.goto(`/app#/${s}`);
      const tabbar = (await page.locator(".tabbar").boundingBox())!;
      expect(tabbar.y + tabbar.height).toBeGreaterThan(780);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, s).toBeLessThanOrEqual(0);
    }
  });
});

test("screenshots of every screen, light and dark, phone and desktop (only with SHOTS_DIR)", async ({ page }) => {
  const dir = process.env.SHOTS_DIR;
  test.skip(!dir, "set SHOTS_DIR to write them");
  for (const [tag, viewport] of [["d", { width: 1440, height: 900 }], ["m", { width: 390, height: 800 }]] as const) {
    await page.setViewportSize(viewport);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const s of SCREENS) {
        await page.goto(`/app#/${s}`);
        await page.waitForTimeout(500);
        await page.screenshot({ path: `${dir}/${tag}-${scheme}-${s}.png` });
      }
    }
  }
});
