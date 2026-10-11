/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

// docs/SDD-wissel-app.md §3.5 and §4.2 (card 5): voice notes and spoken
// replies on the Ask screen, at phone (390 px) and desktop (1440 px).
// POST /voice runs for real against the fake speaches playwright.config.ts
// starts (e2e/fixtures/fake-stt-server.ts), which hears every note as
// "Create a card to check the README." The e2e Kokoro is port 9 (nothing
// there), so "Play reply" fails for real with Kokoro's reason; the
// success path serves the reply's MP3 from the checked-in fixture.

const FAKE_STT = `http://127.0.0.1:${process.env.FAKE_STT_PORT ?? 8791}`;
const HEARD = "Create a card to check the README.";
const MP3 = Buffer.concat(Array.from({ length: 20 }, () => readFileSync(join(process.cwd(), "test", "fixtures", "ai-news", "silence.mp3"))));

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

async function noSideways(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll, "page scrolls sideways").toBeLessThanOrEqual(client);
}

/** A fresh chat, as ask.spec.ts does it. `lan` removes getUserMedia, as
 *  on the board's plain-HTTP LAN address, so the mic opens a file picker.
 *  Otherwise getUserMedia gives a tone from Web Audio, so the real
 *  MediaRecorder records a real Opus note with no microphone. */
async function openAsk(page: Page, opts: { lan?: boolean } = {}) {
  await page.addInitScript((lan: boolean) => {
    if (!sessionStorage.getItem("voice-e2e-cleared")) {
      localStorage.removeItem("wissel.app.askConversation");
      localStorage.removeItem("wissel.app.nowPlaying");
      sessionStorage.setItem("voice-e2e-cleared", "1");
    }
    if (lan) {
      Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
      return;
    }
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const dest = ctx.createMediaStreamDestination();
      osc.connect(dest);
      osc.start();
      return dest.stream;
    };
  }, opts.lan ?? false);
  await page.goto("/app#/ask");
  await expect(page.getByRole("heading", { level: 1, name: "Ask wissel" })).toBeVisible();
}

async function fakeMode(request: APIRequestContext, mode: string) {
  const res = await request.post(`${FAKE_STT}/fake/mode`, { data: { mode } });
  expect(res.ok()).toBe(true);
}

async function lastUpload(request: APIRequestContext) {
  return (await (await request.get(`${FAKE_STT}/fake/last`)).json()) as { filename: string; bytes: number; model: string } | null;
}

const log = (page: Page) => page.getByRole("log", { name: "Messages" });
const box = (page: Page) => page.getByRole("textbox", { name: "Message" });

test.beforeEach(async ({ request }) => {
  await fakeMode(request, "ok");
});

for (const vp of VIEWPORTS) {
  test.describe(`Voice at ${vp.width}px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("on the LAN the mic opens the phone's recorder; the note's text lands in the box, unsent, and sends on Enter", async ({ page, request }) => {
      await openAsk(page, { lan: true });
      const mic = page.getByRole("button", { name: "Add a voice note" });
      await expect(mic).toBeVisible();
      const input = page.locator("#voice-file");
      await expect(input).toHaveAttribute("accept", "audio/*");
      await expect(input).toHaveAttribute("capture", "");

      // The button opens the picker.
      const chooser = page.waitForEvent("filechooser");
      await mic.click();
      await (await chooser).setFiles({ name: "memo.m4a", mimeType: "audio/mp4", buffer: Buffer.alloc(4096, 1) });

      await expect(box(page)).toHaveValue(HEARD);
      await expect(box(page)).toBeFocused();
      // Not sent: Milton reads it first.
      await expect(log(page).getByText(HEARD)).toHaveCount(0);
      expect(await lastUpload(request)).toMatchObject({ filename: "memo.m4a", bytes: 4096, model: "Systran/faster-whisper-small" });

      await box(page).press("Enter");
      await expect(log(page).getByText(HEARD)).toBeVisible();
      await expect(log(page).getByText("Made a card to check the README.")).toBeVisible();
      await noSideways(page);
    });

    test("where the page can record, the mic records in the page: a clock while recording, Stop sends the note", async ({ page, request }) => {
      await openAsk(page);
      await box(page).fill("Also:");
      await page.getByRole("button", { name: "Record a voice note" }).click();
      const strip = page.getByRole("group", { name: "Recording" });
      await expect(strip).toBeVisible();
      await expect(strip).toContainText("/ 5:00");
      await expect(strip).toContainText("Recording 0:01");
      await noSideways(page);
      await strip.getByRole("button", { name: "Stop" }).click();
      await expect(strip).toHaveCount(0);
      await expect(box(page)).toHaveValue(`Also: ${HEARD}`);
      const last = await lastUpload(request);
      expect(last?.filename).toMatch(/^voice-note\.(webm|ogg|m4a)$/);
      expect(last!.bytes).toBeGreaterThan(0);
    });

    test("keyboard alone: Tab reaches the mic, Enter starts, Cancel throws the note away", async ({ page, request }) => {
      await openAsk(page);
      const before = await lastUpload(request);
      let reached = false;
      for (let i = 0; i < 40 && !reached; i++) {
        await page.keyboard.press("Tab");
        reached = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Record a voice note");
      }
      expect(reached).toBe(true);
      // Focus is visible on it.
      expect(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle)).not.toBe("none");
      await page.keyboard.press("Enter");
      const strip = page.getByRole("group", { name: "Recording" });
      await expect(strip).toBeVisible();
      await strip.getByRole("button", { name: "Cancel" }).click();
      await expect(strip).toHaveCount(0);
      await page.waitForTimeout(300);
      expect(await lastUpload(request)).toEqual(before);
      await expect(box(page)).toHaveValue("");
    });
  });
}

test("a speech to text failure says what broke, and the box is left alone", async ({ page, request }) => {
  await fakeMode(request, "no-model");
  await openAsk(page, { lan: true });
  await box(page).fill("keep me");
  await page.locator("#voice-file").setInputFiles({ name: "memo.m4a", mimeType: "audio/mp4", buffer: Buffer.alloc(1024, 1) });
  await expect(page.getByRole("alert")).toContainText("Voice note: Speech to text at");
  await expect(page.getByRole("alert")).toContainText("doesn't have model Systran/faster-whisper-small");
  await expect(box(page)).toHaveValue("keep me");
});

test("a file that isn't audio is refused in the browser, never uploaded", async ({ page, request }) => {
  await openAsk(page, { lan: true });
  const before = await lastUpload(request);
  await page.locator("#voice-file").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await expect(page.getByRole("alert")).toHaveText("Voice note: That file isn't audio.");
  expect(await lastUpload(request)).toEqual(before);
});

test("POST /voice validates its body", async ({ request }) => {
  expect((await request.post("/voice", { data: { text: "hi" } })).status()).toBe(400);
  const res = await request.post("/voice", { multipart: { file: { name: "a.webm", mimeType: "audio/webm", buffer: Buffer.alloc(100, 1) } } });
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ text: HEARD });
});

async function askForReply(page: Page) {
  await box(page).fill("what is running");
  await box(page).press("Enter");
  const reply = log(page).locator(".msg-assistant").filter({ hasText: "Nothing is running right now." }).last();
  await expect(reply).toBeVisible();
  return reply;
}

for (const vp of VIEWPORTS) {
  test(`Play reply at ${vp.width}px: Kokoro reads it and it plays in the mini-player, which links back to Ask`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    let made = 0;
    await page.route(
      (url) => /^\/ask\/[^/]+\/audio$/.test(url.pathname),
      async (route) => {
        const req = route.request();
        const id = decodeURIComponent(new URL(req.url()).pathname.split("/")[2]!);
        if (req.method() === "POST") {
          made++;
          return route.fulfill({ json: { audioUrl: `/ask/${id}/audio`, bytes: MP3.length, cached: false } });
        }
        return route.fulfill({ status: 200, body: MP3, headers: { "content-type": "audio/mpeg", "accept-ranges": "bytes" } });
      },
    );
    await openAsk(page);
    const reply = await askForReply(page);
    await reply.getByRole("button", { name: "Play reply" }).click();
    await expect(reply.getByRole("button", { name: "Pause reply" })).toBeVisible();
    const player = page.getByRole("region", { name: "Player" }).first();
    await expect(player).toContainText("Nothing is running right now.");
    await expect(player).toContainText("wissel reply");
    await expect(player.getByRole("link", { name: "Nothing is running right now." })).toHaveAttribute("href", "#/ask");
    expect(made).toBe(1);

    // Pausing and playing again is the player's, not a second synthesis.
    await reply.getByRole("button", { name: "Pause reply" }).click();
    await expect(reply.getByRole("button", { name: "Play reply" })).toBeVisible();
    await reply.getByRole("button", { name: "Play reply" }).click();
    await expect(reply.getByRole("button", { name: "Pause reply" })).toBeVisible();
    expect(made).toBe(1);
    await noSideways(page);
  });
}

test("Play reply with Kokoro down says so, with Kokoro's own reason", async ({ page }) => {
  await openAsk(page);
  const reply = await askForReply(page);
  await reply.getByRole("button", { name: "Play reply" }).click();
  await expect(reply.getByRole("alert")).toContainText("Could not play: Kokoro TTS isn't reachable at http://127.0.0.1:9");
  await expect(reply.getByRole("button", { name: "Play reply" })).toBeEnabled();
});

test("POST /ask/:id/audio refuses Milton's own message and unknown ids", async ({ request }) => {
  const made = (await (await request.post("/ask", { data: { text: "what is running" } })).json()) as { user: { id: string } };
  expect((await request.post(`/ask/${made.user.id}/audio`)).status()).toBe(400);
  expect((await request.post("/ask/nope/audio")).status()).toBe(404);
  expect((await request.get("/ask/nope/audio")).status()).toBe(404);
});

test("reduced motion stops the recording dot", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openAsk(page);
  await page.getByRole("button", { name: "Record a voice note" }).click();
  const dot = page.locator(".rec-dot");
  await expect(dot).toBeVisible();
  expect(await dot.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  await page.getByRole("button", { name: "Cancel" }).click();
});
