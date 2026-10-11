import { describe, expect, test } from "vitest";
import {
  MAX_VOICE_BYTES,
  canRecordInPage,
  clock,
  createRecorder,
  micError,
  pickRecorderType,
  recordingName,
  replyTrack,
  voiceFileProblem,
  withTranscript,
  type MediaRecorderLike,
  type StreamLike,
} from "../src/voice";
import { loadNowPlaying, NOW_PLAYING_KEY } from "../src/player";

// docs/SDD-wissel-app.md §3.5: the browser half of voice notes and
// spoken replies, with a fake MediaRecorder and fake timers.

describe("canRecordInPage", () => {
  test("only with getUserMedia and MediaRecorder: plain HTTP on the LAN has neither, so the file input is used", () => {
    expect(canRecordInPage({ mediaDevices: { getUserMedia: () => {} }, MediaRecorder: function () {} })).toBe(true);
    expect(canRecordInPage({ mediaDevices: undefined, MediaRecorder: function () {} })).toBe(false);
    expect(canRecordInPage({ mediaDevices: {}, MediaRecorder: function () {} })).toBe(false);
    expect(canRecordInPage({ mediaDevices: { getUserMedia: () => {} }, MediaRecorder: undefined })).toBe(false);
  });
});

describe("pickRecorderType and recordingName", () => {
  test("Opus first, then what the browser has; a name to match", () => {
    expect(pickRecorderType(() => true)).toBe("audio/webm;codecs=opus");
    expect(pickRecorderType((t) => t === "audio/mp4")).toBe("audio/mp4");
    expect(pickRecorderType(() => false)).toBe("");
    expect(pickRecorderType(undefined)).toBe("");
    expect(
      pickRecorderType(() => {
        throw new Error("no");
      }),
    ).toBe("");
    expect(recordingName("audio/webm;codecs=opus")).toBe("voice-note.webm");
    expect(recordingName("audio/ogg;codecs=opus")).toBe("voice-note.ogg");
    expect(recordingName("audio/mp4")).toBe("voice-note.m4a");
    expect(recordingName("")).toBe("voice-note.webm");
  });
});

describe("voiceFileProblem", () => {
  test("empty, over 10 MB, not audio, or longer than 5 minutes; else fine", () => {
    expect(voiceFileProblem({ size: 0, type: "audio/mp4" })).toBe("That recording is empty.");
    expect(voiceFileProblem({ size: MAX_VOICE_BYTES + 1, type: "audio/mp4" })).toBe("That recording is 10.0 MB. The limit is 10 MB.");
    expect(voiceFileProblem({ size: 10, type: "image/png" })).toBe("That file isn't audio.");
    expect(voiceFileProblem({ size: 10, type: "audio/mp4" }, 400)).toBe("That recording is 6:40 long. The limit is 5:00.");
    expect(voiceFileProblem({ size: 10, type: "audio/mp4" }, 300)).toBeNull();
    expect(voiceFileProblem({ size: 10, type: "audio/webm" }, Infinity)).toBeNull();
    expect(voiceFileProblem({ size: 10, type: "" })).toBeNull();
    expect(voiceFileProblem({ size: 10, type: "video/mp4" })).toBeNull();
  });
});

describe("withTranscript", () => {
  test("fills an empty box, adds after a space otherwise, ignores empty text", () => {
    expect(withTranscript("", " Run the AI news ")).toBe("Run the AI news");
    expect(withTranscript("  ", "hi")).toBe("hi");
    expect(withTranscript("Also", "run it")).toBe("Also run it");
    expect(withTranscript("Also ", "run it")).toBe("Also run it");
    expect(withTranscript("keep", "  ")).toBe("keep");
  });
});

describe("clock and micError", () => {
  test("m:ss, and a plain message per getUserMedia failure", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(61.9)).toBe("1:01");
    expect(micError({ name: "NotAllowedError" })).toMatch(/blocked the microphone/);
    expect(micError({ name: "NotFoundError" })).toBe("No microphone found.");
    expect(micError({ name: "NotReadableError" })).toMatch(/in use/);
    expect(micError(new Error("x"))).toBe("Could not start recording.");
  });
});

describe("replyTrack", () => {
  test("a reply plays as a track in the shell's player, titled by its first line, linking back to Ask", () => {
    const t = replyTrack({ id: "m1", text: "\nMade a card to check the README.\nMore." }, "/ask/m1/audio");
    expect(t).toEqual({ runId: "reply-m1", title: "Made a card to check the README.", pipelineName: "wissel reply", audioUrl: "/ask/m1/audio", link: "#/ask" });
    expect(replyTrack({ id: "m2", text: "x".repeat(100) }, "/ask/m2/audio").title).toHaveLength(80);
  });

  test("a reply track survives a reload; a foreign URL or link still does not", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null };
    store.set(NOW_PLAYING_KEY, JSON.stringify(replyTrack({ id: "m1", text: "Hi" }, "/ask/m1/audio")));
    expect(loadNowPlaying(storage)?.runId).toBe("reply-m1");
    store.set(NOW_PLAYING_KEY, JSON.stringify({ ...replyTrack({ id: "m1", text: "Hi" }, "/ask/m1/audio"), link: "https://evil.example" }));
    expect(loadNowPlaying(storage)).toBeNull();
    store.set(NOW_PLAYING_KEY, JSON.stringify({ ...replyTrack({ id: "m1", text: "Hi" }, "https://evil.example/a.mp3") }));
    expect(loadNowPlaying(storage)).toBeNull();
  });
});

// ---------- createRecorder ----------

class FakeRecorder implements MediaRecorderLike {
  state = "inactive";
  started: number | undefined;
  private handlers: Record<string, ((e: { data: Blob }) => void)[]> = {};
  constructor(readonly mimeType: string) {}
  addEventListener(type: string, fn: (e: { data: Blob }) => void) {
    (this.handlers[type] ??= []).push(fn);
  }
  fire(type: string, e?: { data: Blob }) {
    for (const fn of this.handlers[type] ?? []) fn(e as { data: Blob });
  }
  start(timeslice?: number) {
    this.started = timeslice;
    this.state = "recording";
  }
  stop() {
    this.fire("dataavailable", { data: new Blob(["tail"]) });
    this.state = "inactive";
    this.fire("stop");
  }
}

function setup(over: { getUserMedia?: () => Promise<StreamLike> } = {}) {
  let t = 1_000;
  const timers: { fn: () => void; ms: number; id: number }[] = [];
  let stopped = 0;
  const stream: StreamLike = { getTracks: () => [{ stop: () => stopped++ }] };
  let rec: FakeRecorder | undefined;
  const r = createRecorder({
    getUserMedia: over.getUserMedia ?? (async () => stream),
    createRecorder: (_s, type) => (rec = new FakeRecorder(type)),
    mimeType: "audio/webm;codecs=opus",
    now: () => t,
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms, id: timers.length + 1 });
      return timers.length;
    },
    clearTimeout: (id) => {
      const i = timers.findIndex((x) => x.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  return {
    r,
    rec: () => rec!,
    advance: (s: number) => (t += s * 1000),
    timers,
    tracksStopped: () => stopped,
  };
}

describe("createRecorder", () => {
  test("records in one-second slices, and Stop gives the whole note as one Blob with its length; the mic is released", async () => {
    const s = setup();
    await s.r.start();
    expect(s.rec().started).toBe(1000);
    s.rec().fire("dataavailable", { data: new Blob(["abc"]) });
    s.advance(12);
    expect(s.r.elapsed()).toBe(12);
    const note = await s.r.stop();
    expect(note.name).toBe("voice-note.webm");
    expect(note.seconds).toBe(12);
    expect(note.capped).toBe(false);
    expect(await note.blob.text()).toBe("abctail");
    expect(note.blob.type).toBe("audio/webm;codecs=opus");
    expect(s.tracksStopped()).toBe(1);
    expect(s.timers).toHaveLength(0);
  });

  test("stops by itself at 5 minutes and hands the note over", async () => {
    const s = setup();
    await s.r.start();
    let got: { capped: boolean; seconds: number } | undefined;
    s.r.onCapped((rec) => (got = rec));
    expect(s.timers[0]!.ms).toBe(300_000);
    s.advance(300);
    s.timers[0]!.fn();
    await Promise.resolve();
    await Promise.resolve();
    expect(got).toMatchObject({ capped: true, seconds: 300 });
    expect(s.tracksStopped()).toBe(1);
  });

  test("Cancel throws the note away and releases the mic", async () => {
    const s = setup();
    await s.r.start();
    s.r.cancel();
    expect(s.rec().state).toBe("inactive");
    expect(s.tracksStopped()).toBe(1);
  });

  test("Cancel while the permission prompt is open: the mic is let go and no recorder starts", async () => {
    let grant!: (s: StreamLike) => void;
    let lateStopped = 0;
    const late: StreamLike = { getTracks: () => [{ stop: () => lateStopped++ }] };
    const s = setup({ getUserMedia: () => new Promise<StreamLike>((res) => (grant = res)) });
    const started = s.r.start();
    s.r.cancel(); // Ask unmounts before Milton answers the prompt
    grant(late);
    await expect(started).rejects.toThrow(/cancelled/);
    expect(lateStopped).toBe(1);
    expect(s.rec()).toBeUndefined();
    expect(s.timers).toHaveLength(0);
    expect(s.r.elapsed()).toBe(0);
  });

  test("a refused microphone rejects with a message to show", async () => {
    const s = setup({
      getUserMedia: () => Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" })),
    });
    await expect(s.r.start()).rejects.toThrow(/blocked the microphone/);
  });
});
