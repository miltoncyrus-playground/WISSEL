import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KokoroBusyError, inKokoroQueue, type SpeakResult } from "../src/executors/tts.ts";
import { MAX_SPOKEN_CHARS, ReplyAudioError, createReplyAudio, replyAudioDir, replyAudioUrl, spokenText } from "../src/services/reply-audio.ts";
import type { ChatMessage } from "../src/services/conversations.ts";

// docs/SDD-wissel-app.md §3.5: what a spoken reply says, and the queue
// it shares with the podcasts.

describe("spokenText", () => {
  test("Markdown marks, code and links are not read out", () => {
    expect(spokenText("**Done.** I made `Check the README`.")).toBe("Done. I made Check the README.");
    expect(spokenText("See [the board](http://x/board) or http://localhost:8787/app#/ask now")).toBe("See the board or a link now");
    expect(spokenText("## Running\n- one\n- two\n* three")).toBe("Running one two three");
    expect(spokenText("Before\n```json\n{\"a\":1}\n```\nafter")).toBe("Before after");
    expect(spokenText("an _emphasised_ word and snake_case_name")).toBe("an emphasised word and snake_case_name");
    expect(spokenText("   \n ")).toBe("");
    expect(spokenText("```\nonly code\n```")).toBe("");
  });

  test("a long reply is cut at a sentence end and says the rest is in the chat", () => {
    const sentence = "This sentence is exactly fifty characters long ok. ";
    const long = sentence.repeat(100);
    const out = spokenText(long);
    expect(out.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS + 30);
    expect(out.endsWith("ok. The rest is in the chat.")).toBe(true);
    expect(spokenText("word ".repeat(30), 50)).toMatch(/^(word ){0,9}word The rest is in the chat\.$/);
  });
});

describe("inKokoroQueue", () => {
  test("runs jobs for one URL one at a time, in order", async () => {
    const order: string[] = [];
    const job = (name: string, ms: number) => async () => {
      order.push(`start ${name}`);
      await Bun.sleep(ms);
      order.push(`end ${name}`);
      return name;
    };
    const url = "http://queue-order";
    expect(await Promise.all([inKokoroQueue(url, job("a", 30)), inKokoroQueue(url, job("b", 1)), inKokoroQueue(url, job("c", 1))])).toEqual(["a", "b", "c"]);
    expect(order).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  test("with maxWaitMs, a job still waiting gives up with KokoroBusyError and never runs; one that started finishes", async () => {
    const url = "http://queue-wait";
    const ran: string[] = [];
    const long = inKokoroQueue(url, async () => {
      ran.push("podcast");
      await Bun.sleep(120);
      return "podcast";
    });
    const waiting = inKokoroQueue(
      url,
      async () => {
        ran.push("reply");
        return "reply";
      },
      30,
    );
    await expect(waiting).rejects.toBeInstanceOf(KokoroBusyError);
    expect(await long).toBe("podcast");
    // A job queued after the one that gave up still runs.
    expect(await inKokoroQueue(url, async () => "next", 1000)).toBe("next");
    expect(ran).toEqual(["podcast"]);
  });

  test("a job that starts in time is not cut off by maxWaitMs, however long it runs", async () => {
    expect(
      await inKokoroQueue(
        "http://queue-started",
        async () => {
          await Bun.sleep(60);
          return "done";
        },
        10,
      ),
    ).toBe("done");
  });
});

describe("createReplyAudio", () => {
  const msg = (over: Partial<ChatMessage>): ChatMessage => ({ id: "m1", conversationId: "c", role: "assistant", text: "Hello there.", actions: [], dropped: [], at: "2026-10-11T00:00:00Z", ...over });

  test("maps every Kokoro failure kind to an HTTP status", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wissel-reply-"));
    try {
      const cases: [Exclude<SpeakResult, { ok: true }>["kind"], number][] = [
        ["unavailable", 503],
        ["busy", 503],
        ["timeout", 504],
        ["bad-response", 502],
        ["save", 500],
      ];
      for (const [kind, status] of cases) {
        const svc = createReplyAudio({ audioDir: dir, message: (id) => msg({ id }), speak: async () => ({ ok: false, kind, reason: `because ${kind}` }) });
        const e = await svc.ensure(`id-${kind}`).catch((err: unknown) => err);
        expect(e).toBeInstanceOf(ReplyAudioError);
        expect((e as ReplyAudioError).status).toBe(status as ReplyAudioError["status"]);
        expect((e as ReplyAudioError).message).toBe(`because ${kind}`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a reply with nothing to say is refused without calling Kokoro", async () => {
    let called = false;
    const svc = createReplyAudio({
      audioDir: "/nonexistent",
      message: () => msg({ text: "```\ncode only\n```" }),
      speak: async () => {
        called = true;
        return { ok: false, kind: "unavailable", reason: "x" };
      },
    });
    const e = (await svc.ensure("m1").catch((err: unknown) => err)) as ReplyAudioError;
    expect(e.status).toBe(400);
    expect(called).toBe(false);
  });

  test("paths and URLs", () => {
    expect(replyAudioDir("/a")).toBe("/a/ask");
    expect(replyAudioUrl("abc-1")).toBe("/ask/abc-1/audio");
  });
});
