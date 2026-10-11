/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";

// docs/SDD-wissel-app.md §3.3 and §4.2 (card 3): the Listen tab and the
// shell's mini-player at phone (390 px) and desktop (1440 px). The e2e
// board is in memory and has no podcast runs (a real one needs Kokoro),
// so GET /podcasts and the MP3s are served by the page from fixtures,
// the way e2e/pipelines.spec.ts serves its AI news run. The real
// endpoint is checked on its own below; test/podcasts.test.ts covers
// it over a real board.

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844, desktop: false },
  { name: "desktop", width: 1440, height: 900, desktop: true },
] as const;

const FIXTURES = join(process.cwd(), "test", "fixtures", "ai-news");
const read = (f: string) => readFileSync(join(FIXTURES, f), "utf8");

/** test/fixtures/ai-news/silence.mp3 is 1.5 s of real MP3 frames; 20 in
 *  a row are about 30 s, long enough to move around while it plays. */
const MP3 = Buffer.concat(Array.from({ length: 20 }, () => readFileSync(join(FIXTURES, "silence.mp3"))));

/** The `data` of a step's recorded pipeline-handoff block. */
function handoffData(summary: string): Record<string, unknown> {
  const blocks = [...summary.matchAll(/```pipeline-handoff\s*\n([\s\S]*?)```/g)];
  return (JSON.parse(blocks.at(-1)![1]!) as { data: Record<string, unknown> }).data;
}

const SCRIPT = handoffData(read("script-summary.md"));
const GATHER = handoffData(read("gather-summary.md"));
const EXPLAIN = handoffData(read("explain-summary.md"));
const QUICK_READ = SCRIPT.quickRead as { headline: string; oneLine: string; source: string }[];
const GATHER_SOURCES = (GATHER.stories as { sources: string[] }[]).flatMap((s) => s.sources);

function episodes() {
  const hour = 3_600_000;
  const at = (h: number) => new Date(Date.now() - h * hour).toISOString();
  const base = { durationSeconds: 30, quickRead: null as unknown };
  return [
    {
      ...base,
      runId: "e2e-ai-2",
      pipelineId: "p-ai",
      pipelineName: "AI news podcast",
      show: "ai",
      at: at(1),
      title: QUICK_READ[0]!.headline,
      audioUrl: "/pipeline-runs/e2e-ai-2/audio",
      // One invented source, flagged like the board flags it.
      quickRead: {
        items: [...QUICK_READ, { headline: "Made-up story", oneLine: "Not from the gather step.", source: "https://invented.example.com/x" }],
        gatherSources: GATHER_SOURCES,
        explain: EXPLAIN,
      },
    },
    {
      ...base,
      runId: "e2e-world-1",
      pipelineId: "p-world",
      pipelineName: "World news podcast",
      show: "world",
      at: at(3),
      title: "World in brief",
      audioUrl: "/pipeline-runs/e2e-world-1/audio",
    },
    {
      ...base,
      runId: "e2e-ai-1",
      pipelineId: "p-ai",
      pipelineName: "AI news podcast",
      show: "ai",
      at: at(26),
      title: "Yesterday in AI",
      audioUrl: "/pipeline-runs/e2e-ai-1/audio",
      quickRead: { items: [{ headline: "Older headline", oneLine: "From yesterday.", source: QUICK_READ[1]!.source }], gatherSources: GATHER_SOURCES, explain: null },
    },
  ];
}

/** An MP3 with Range support, like the server's pipelineAudioResponse. */
function fulfillMp3(route: Route) {
  const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers()["range"] ?? "");
  if (!range) return route.fulfill({ status: 200, contentType: "audio/mpeg", headers: { "accept-ranges": "bytes" }, body: MP3 });
  const start = Number(range[1]);
  const end = range[2] ? Math.min(Number(range[2]), MP3.length - 1) : MP3.length - 1;
  return route.fulfill({
    status: 206,
    contentType: "audio/mpeg",
    headers: { "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${MP3.length}` },
    body: MP3.subarray(start, end + 1),
  });
}

async function servePodcasts(page: Page) {
  const list = episodes();
  await page.route((url) => url.pathname === "/podcasts", (route) => route.fulfill({ json: list }));
  await page.route((url) => /^\/pipeline-runs\/e2e-[a-z0-9-]+\/audio$/.test(url.pathname), fulfillMp3);
  return list;
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
    Array.from(document.querySelectorAll<HTMLElement>("button, a[href], input"))
      .filter((el) => el.offsetParent !== null || getComputedStyle(el).position === "fixed")
      .filter((el) => !(el.getAttribute("aria-label") || el.textContent || "").trim())
      .map((el) => el.outerHTML.slice(0, 120)),
  );
  expect(unlabeled).toEqual([]);
}

/** The shell's one <audio>: its src, time and whether it plays. */
const audioState = (page: Page) =>
  page.evaluate(() => {
    const a = document.querySelector<HTMLAudioElement & { __mark?: string }>("audio.shell-audio")!;
    return { src: new URL(a.src || "about:blank", location.href).pathname, time: a.currentTime, paused: a.paused, mark: a.__mark ?? null, count: document.querySelectorAll("audio").length };
  });

const player = (page: Page) => page.getByRole("region", { name: "Player" });

test("GET /podcasts answers a list on the real server, and refuses a bad limit", async ({ request }) => {
  const res = await request.get("/podcasts");
  expect(res.ok()).toBe(true);
  expect(Array.isArray(await res.json())).toBe(true);
  expect((await request.get("/podcasts?limit=0")).status()).toBe(400);
});

for (const vp of VIEWPORTS) {
  test.describe(`Listen at ${vp.width}px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("episodes by pipeline, Quick read with sources, flags and expandable detail; real controls, no sideways scroll", async ({ page }) => {
      await servePodcasts(page);
      await page.goto("/app#/listen");
      await expect(page.getByRole("heading", { level: 1, name: "Listen" })).toBeVisible();

      const ai = page.getByRole("region", { name: "AI news podcast" });
      const world = page.getByRole("region", { name: "World news podcast" });
      await expect(ai).toBeVisible();
      await expect(world).toBeVisible();
      // The pipeline with the newest episode first.
      const names = await page.locator(".show-name").allTextContents();
      expect(names).toEqual(["AI news podcast", "World news podcast"]);

      const latest = ai.getByRole("article", { name: QUICK_READ[0]!.headline });
      await expect(latest).toBeVisible();
      await expect(latest.getByRole("button", { name: `Play ${QUICK_READ[0]!.headline}` })).toBeVisible();
      await expect(latest).toContainText("1 h ago");

      // The latest episode's Quick read is open: every row, its one line
      // and a new-tab source link; the invented source is flagged.
      const quick = latest.getByRole("region", { name: "Quick read" });
      for (const row of QUICK_READ) {
        await expect(quick.getByText(row.headline, { exact: true })).toBeVisible();
        await expect(quick.getByText(row.oneLine, { exact: true })).toBeVisible();
      }
      const link = quick.getByRole("link", { name: /lab\.example\.com/ });
      await expect(link).toHaveAttribute("href", QUICK_READ[0]!.source);
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(link).toHaveAttribute("rel", /noopener/);
      await expect(quick.getByText("source not from the gather step")).toBeVisible();

      // Expandable detail from the explain step, by keyboard.
      const more = quick.getByText("More", { exact: false }).first();
      await expect(quick.getByText("Why it matters").first()).toBeHidden();
      await more.focus();
      await page.keyboard.press("Enter");
      await expect(quick.getByText("Why it matters").first()).toBeVisible();
      await expect(quick.getByText("Not known yet").first()).toBeVisible();

      // An earlier episode keeps its Quick read folded away.
      const earlier = ai.getByRole("list", { name: "Earlier AI news podcast episodes" });
      await expect(earlier.getByRole("article", { name: "Yesterday in AI" })).toBeVisible();
      await expect(earlier.getByText("Older headline")).toBeHidden();
      await earlier.locator("summary", { hasText: "Quick read" }).click();
      await expect(earlier.getByText("Older headline")).toBeVisible();

      await noSideways(page);
      await onlyRealControls(page);
    });

    test("the mini-player plays on every screen: playback and position survive navigation and a reload", async ({ page }) => {
      await servePodcasts(page);
      await page.goto("/app#/listen");
      await expect(player(page)).toHaveCount(0);

      await page.getByRole("button", { name: "Play World in brief" }).click();
      await expect(player(page)).toBeVisible();
      await expect(player(page).getByRole("link", { name: "World in brief" })).toHaveAttribute("href", "#/listen");
      await expect(page.getByRole("button", { name: "Pause World in brief" })).toBeVisible();
      await expect.poll(async () => (await audioState(page)).time, { timeout: 10_000 }).toBeGreaterThan(0.5);
      await page.evaluate(() => {
        (document.querySelector("audio.shell-audio") as HTMLAudioElement & { __mark?: string }).__mark = "same element";
      });

      if (vp.desktop) {
        // On desktop it lives in the Live panel.
        await expect(page.getByRole("complementary", { name: "Live" }).getByRole("region", { name: "Player" })).toBeVisible();
      } else {
        // On a phone it sits just above the tab bar, never under it.
        const bar = await player(page).boundingBox();
        const tabs = await page.getByRole("navigation", { name: "Screens" }).boundingBox();
        expect(bar!.y + bar!.height).toBeLessThanOrEqual(tabs!.y + 1);
      }

      const nav = page.getByRole("navigation", { name: "Screens" });
      for (const screen of ["Feed", "Board", "Ask"]) {
        const before = (await audioState(page)).time;
        await nav.getByRole("link", { name: screen, exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`#/${screen.toLowerCase()}$`));
        await expect(player(page)).toBeVisible();
        await expect.poll(async () => (await audioState(page)).time, { timeout: 5_000 }).toBeGreaterThan(before);
        const s = await audioState(page);
        expect(s).toMatchObject({ src: "/pipeline-runs/e2e-world-1/audio", paused: false, mark: "same element", count: 1 });
        await noSideways(page);
      }

      // Pause from the mini-player, by keyboard: Tab reaches it, with a
      // visible outline.
      const pause = player(page).getByRole("button", { name: "Pause", exact: true });
      let focused = false;
      for (let i = 0; i < 60 && !focused; i++) {
        await page.keyboard.press("Tab");
        focused = await pause.evaluate((el) => el === document.activeElement);
      }
      expect(focused, "the mini-player's Pause is reachable by Tab").toBe(true);
      const outline = await pause.evaluate((el) => getComputedStyle(el).outlineStyle);
      expect(outline).not.toBe("none");
      await page.keyboard.press("Enter");
      await expect(player(page).getByRole("button", { name: "Play", exact: true })).toBeVisible();
      const stopped = await audioState(page);
      expect(stopped.paused).toBe(true);
      const saved = await page.evaluate(() => (JSON.parse(localStorage.getItem("wissel.app.positions") ?? "{}") as Record<string, { t: number }>)["e2e-world-1"]?.t);
      expect(saved).toBe(Math.floor(stopped.time));

      // A reload brings the episode back, paused at the same spot.
      await page.reload();
      await expect(player(page)).toBeVisible();
      await expect(player(page).getByRole("link", { name: "World in brief" })).toBeVisible();
      await expect.poll(async () => (await audioState(page)).time, { timeout: 5_000 }).toBeGreaterThanOrEqual(saved! - 0.01);
      expect((await audioState(page)).paused).toBe(true);
      await page.goto("/app#/listen");
      await expect(page.getByRole("article", { name: "World in brief" })).toContainText(`at 0:${String(saved).padStart(2, "0")}`);

      await onlyRealControls(page);
    });
  });
}

// The action handlers are driven in app/test/player.test.ts; a page
// can't fire a Media Session action itself.
test("Media Session gets the episode's title, show and playing state", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await servePodcasts(page);
  await page.goto("/app#/listen");
  await page.getByRole("button", { name: `Play ${QUICK_READ[0]!.headline}` }).click();
  await expect.poll(async () => (await audioState(page)).time, { timeout: 10_000 }).toBeGreaterThan(0.2);
  const meta = await page.evaluate(() => {
    const m = navigator.mediaSession.metadata;
    return m ? { title: m.title, artist: m.artist, album: m.album, state: navigator.mediaSession.playbackState } : null;
  });
  expect(meta).toEqual({ title: QUICK_READ[0]!.headline, artist: "AI news podcast", album: "wissel", state: "playing" });
});

test("seek and skip from the mini-player move the shell's audio", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await servePodcasts(page);
  await page.goto("/app#/listen");
  await page.getByRole("button", { name: "Play Yesterday in AI" }).click();
  await expect.poll(async () => (await audioState(page)).time, { timeout: 10_000 }).toBeGreaterThan(0.2);
  await player(page).getByRole("button", { name: "Pause", exact: true }).click();

  await player(page).getByRole("button", { name: "Forward 30 seconds" }).click();
  // Clamped to the end of a 30 s episode.
  await expect.poll(async () => (await audioState(page)).time).toBeGreaterThan(25);
  await player(page).getByRole("button", { name: "Back 15 seconds" }).click();
  await expect.poll(async () => (await audioState(page)).time).toBeLessThan(20);

  const slider = player(page).getByRole("slider", { name: "Position" });
  await slider.fill("10");
  await expect.poll(async () => Math.round((await audioState(page)).time)).toBe(10);
  await expect(slider).toHaveAttribute("aria-valuetext", /^0:10 of 0:\d\d$/);
});

test("a podcast in the feed plays in the mini-player and keeps playing on Listen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const list = await servePodcasts(page);
  const ep = list[1]!;
  await page.route((url) => url.pathname === "/feed", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: `podcast:${ep.runId}`,
            kind: "podcast",
            at: ep.at,
            title: ep.title,
            detail: `${ep.pipelineName} · 1 min`,
            links: [{ label: "Download", href: ep.audioUrl }],
            runId: ep.runId,
            show: "world",
            audioUrl: ep.audioUrl,
            durationSeconds: 30,
            pipelineName: ep.pipelineName,
          },
        ],
        next: null,
      },
    }),
  );
  await page.goto("/app#/feed");
  const item = page.getByRole("list", { name: "Feed" }).getByRole("article", { name: ep.title });
  await item.getByRole("button", { name: `Play ${ep.title}` }).click();
  await expect(player(page).getByRole("link", { name: ep.title })).toBeVisible();
  await expect.poll(async () => (await audioState(page)).time, { timeout: 10_000 }).toBeGreaterThan(0.3);
  // The feed has no audio element of its own any more: one player.
  expect((await audioState(page)).count).toBe(1);

  await page.getByRole("navigation", { name: "Screens" }).getByRole("link", { name: "Listen", exact: true }).click();
  await expect(page.getByRole("button", { name: `Pause ${ep.title}` })).toBeVisible();
  expect((await audioState(page)).paused).toBe(false);
});

test("Listen with no podcast runs says how to make one", async ({ page }) => {
  await page.route((url) => url.pathname === "/podcasts", (route) => route.fulfill({ json: [] }));
  await page.goto("/app#/listen");
  await expect(page.getByText("No episodes yet.", { exact: false })).toBeVisible();
});
