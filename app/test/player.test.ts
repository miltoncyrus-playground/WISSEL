import { describe, expect, test } from "vitest";
import {
  MAX_POSITIONS,
  NOW_PLAYING_KEY,
  POSITIONS_KEY,
  SAVE_EVERY_MS,
  createPlayer,
  formatClock,
  formatMinutes,
  forgetPosition,
  loadNowPlaying,
  loadPositions,
  resumeFrom,
  savePosition,
  type MediaSessionLike,
  type PlayerState,
  type Track,
} from "../src/player";

// docs/SDD-wissel-app.md §3.3: the one player the shell owns. Driven
// here with a fake <audio> that fires the events a browser fires.

class FakeAudio extends EventTarget {
  src = "";
  currentTime = 0;
  duration = NaN;
  paused = true;
  playResult: () => Promise<void> = () => Promise.resolve();
  fire(type: string) {
    this.dispatchEvent(new Event(type));
  }
  play() {
    const r = this.playResult();
    this.paused = false;
    this.fire("play");
    return r;
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.fire("pause");
  }
  /** The browser has read the file's header. */
  loadMeta(duration: number) {
    this.duration = duration;
    this.fire("loadedmetadata");
  }
  tick(t: number) {
    this.currentTime = t;
    this.fire("timeupdate");
  }
}

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

class FakeSession implements MediaSessionLike {
  metadata: unknown = null;
  playbackState = "none";
  handlers = new Map<string, ((d: { seekTime?: number; seekOffset?: number }) => void) | null>();
  positions: { duration: number; position: number }[] = [];
  setActionHandler(action: string, fn: ((d: { seekTime?: number; seekOffset?: number }) => void) | null) {
    if (action === "seekto" && this.refuseSeekTo) throw new Error("not supported");
    this.handlers.set(action, fn);
  }
  setPositionState(s: { duration: number; position: number }) {
    this.positions.push(s);
  }
  refuseSeekTo = false;
}

class FakeMetadata {
  constructor(public init: { title: string; artist: string; album: string }) {}
}

const ep = (runId: string, durationSeconds = 600): Track => ({
  runId,
  title: `Episode ${runId}`,
  pipelineName: "AI news podcast",
  audioUrl: `/pipeline-runs/${runId}/audio`,
  durationSeconds,
});

function setup(opts: { storage?: MemoryStorage; session?: FakeSession; clock?: { t: number } } = {}) {
  const audio = new FakeAudio();
  const storage = opts.storage ?? new MemoryStorage();
  const clock = opts.clock ?? { t: 1_000_000 };
  const changes: PlayerState[] = [];
  const player = createPlayer({
    audio,
    storage,
    mediaSession: opts.session,
    MediaMetadata: opts.session ? FakeMetadata : undefined,
    now: () => clock.t,
    onChange: (s) => changes.push(s),
  });
  return { audio, storage, clock, player, changes };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("positions in localStorage", () => {
  test("save, load and forget; junk and missing storage read as nothing", () => {
    const s = new MemoryStorage();
    savePosition(s, "a", 61.8, 1);
    expect(loadPositions(s)).toEqual({ a: { t: 61, at: 1 } });
    forgetPosition(s, "a");
    expect(loadPositions(s)).toEqual({});
    s.setItem(POSITIONS_KEY, "{not json");
    expect(loadPositions(s)).toEqual({});
    s.setItem(POSITIONS_KEY, JSON.stringify({ a: { t: -1, at: 1 }, b: { t: "x" }, c: { t: 5, at: 2 }, d: null }));
    expect(loadPositions(s)).toEqual({ c: { t: 5, at: 2 } });
    expect(loadPositions(undefined)).toEqual({});
  });

  test("keeps only the newest MAX_POSITIONS runs", () => {
    const s = new MemoryStorage();
    for (let i = 0; i < MAX_POSITIONS + 5; i++) savePosition(s, `r${i}`, 10, i);
    const kept = loadPositions(s);
    expect(Object.keys(kept)).toHaveLength(MAX_POSITIONS);
    expect(kept.r0).toBeUndefined();
    expect(kept[`r${MAX_POSITIONS + 4}`]).toBeDefined();
  });

  test("storage that throws (private mode, full quota) never breaks anything", () => {
    const broken = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(() => savePosition(broken, "a", 5, 1)).not.toThrow();
    expect(loadPositions(broken)).toEqual({});
    expect(loadNowPlaying(broken)).toBeNull();
    const audio = new FakeAudio();
    const p = createPlayer({ audio, storage: broken });
    expect(() => p.play(ep("a"))).not.toThrow();
    expect(p.state().track?.runId).toBe("a");
  });

  test("resumeFrom: the saved spot, or the start when there is none or it is at the end", () => {
    expect(resumeFrom(undefined, 600)).toBe(0);
    expect(resumeFrom(0, 600)).toBe(0);
    expect(resumeFrom(120, 600)).toBe(120);
    expect(resumeFrom(595, 600)).toBe(0);
    expect(resumeFrom(120, undefined)).toBe(120);
    expect(resumeFrom(120, NaN)).toBe(120);
  });

  test("now playing only trusts our own audio route", () => {
    const s = new MemoryStorage();
    s.setItem(NOW_PLAYING_KEY, JSON.stringify(ep("a")));
    expect(loadNowPlaying(s)?.runId).toBe("a");
    s.setItem(NOW_PLAYING_KEY, JSON.stringify({ ...ep("a"), audioUrl: "https://evil.example/x.mp3" }));
    expect(loadNowPlaying(s)).toBeNull();
    s.setItem(NOW_PLAYING_KEY, JSON.stringify({ runId: "a" }));
    expect(loadNowPlaying(s)).toBeNull();
  });
});

describe("formatting", () => {
  test("clock and minutes", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(5.9)).toBe("0:05");
    expect(formatClock(754)).toBe("12:34");
    expect(formatClock(3723)).toBe("1:02:03");
    expect(formatClock(NaN)).toBe("0:00");
    expect(formatMinutes(45)).toBe("45 s");
    expect(formatMinutes(312)).toBe("5 min");
  });
});

describe("createPlayer", () => {
  test("play loads the track and plays; state follows the audio's events", async () => {
    const { audio, player, changes } = setup();
    player.play(ep("a"));
    expect(audio.src).toBe("/pipeline-runs/a/audio");
    expect(player.state()).toMatchObject({ playing: true, duration: 600, position: 0, error: null });
    audio.loadMeta(598);
    audio.tick(12);
    expect(player.state()).toMatchObject({ position: 12, duration: 598 });
    player.toggle();
    expect(player.state().playing).toBe(false);
    expect(changes.length).toBeGreaterThan(3);
    await flush();
  });

  test("the spot is saved while playing (throttled), on pause and on persist, and resumed next time", () => {
    const storage = new MemoryStorage();
    const { audio, player, clock } = setup({ storage });
    player.play(ep("a"));
    audio.loadMeta(600);
    clock.t += SAVE_EVERY_MS;
    audio.tick(30);
    expect(loadPositions(storage).a?.t).toBe(30);
    clock.t += 1000;
    audio.tick(31);
    expect(loadPositions(storage).a?.t).toBe(30); // throttled
    audio.currentTime = 95;
    player.pause();
    expect(loadPositions(storage).a?.t).toBe(95);
    audio.currentTime = 99;
    player.persist();
    expect(loadPositions(storage).a?.t).toBe(99);

    // A new page (reload): the same run starts where it was left.
    const again = setup({ storage });
    again.player.play(ep("a"));
    expect(again.player.state().position).toBe(99);
    again.audio.tick(0); // the element reports 0 before its metadata
    expect(again.player.state().position).toBe(99);
    again.audio.loadMeta(600);
    expect(again.audio.currentTime).toBe(99);
    expect(again.player.state().position).toBe(99);
  });

  test("switching episodes saves the old one's spot first; each run keeps its own", () => {
    const storage = new MemoryStorage();
    const { audio, player } = setup({ storage });
    player.play(ep("a"));
    audio.loadMeta(600);
    audio.currentTime = 200;
    player.play(ep("b"));
    expect(loadPositions(storage).a?.t).toBe(200);
    expect(audio.src).toBe("/pipeline-runs/b/audio");
    expect(player.savedPosition("a")).toBe(200);
    expect(player.savedPosition("b")).toBeUndefined();
  });

  test("playing the loaded track again does not reload it", () => {
    const { audio, player } = setup();
    player.play(ep("a"));
    audio.loadMeta(600);
    audio.currentTime = 50;
    player.pause();
    audio.src = "sentinel";
    player.play(ep("a"));
    expect(audio.src).toBe("sentinel");
    expect(player.state().playing).toBe(true);
  });

  test("an episode that ended starts over next time", () => {
    const storage = new MemoryStorage();
    const { audio, player } = setup({ storage });
    player.play(ep("a"));
    audio.loadMeta(600);
    audio.currentTime = 600;
    audio.pause(); // a browser fires pause, then ended
    audio.fire("ended");
    expect(loadPositions(storage).a).toBeUndefined();
    expect(player.state()).toMatchObject({ playing: false, position: 0 });
  });

  test("seek and skip clamp to the episode and save", () => {
    const storage = new MemoryStorage();
    const { audio, player } = setup({ storage });
    player.play(ep("a"));
    audio.loadMeta(100);
    player.seek(40);
    expect(audio.currentTime).toBe(40);
    player.skip(-60);
    expect(audio.currentTime).toBe(0);
    player.skip(500);
    expect(audio.currentTime).toBe(100);
    expect(loadPositions(storage).a?.t).toBe(100);
  });

  test("cue restores a track paused at its spot; a skip before metadata counts from that spot", () => {
    const storage = new MemoryStorage();
    savePosition(storage, "a", 120, 1);
    const { audio, player } = setup({ storage });
    player.cue(ep("a"));
    expect(audio.paused).toBe(true);
    expect(player.state()).toMatchObject({ playing: false, position: 120 });
    player.skip(30);
    expect(audio.currentTime).toBe(150);
  });

  test("a blocked play is shown as an error; an aborted one (a newer load) is not", async () => {
    const { audio, player } = setup();
    audio.playResult = () => Promise.reject(Object.assign(new Error("no"), { name: "NotAllowedError" }));
    player.play(ep("a"));
    await flush();
    expect(player.state()).toMatchObject({ playing: false, error: "The browser blocked playback. Press play again." });

    audio.playResult = () => Promise.reject(Object.assign(new Error("x"), { name: "AbortError" }));
    player.play(ep("b"));
    await flush();
    expect(player.state().error).toBeNull();
  });

  test("an audio error with a track loaded says so", () => {
    const { audio, player } = setup();
    audio.fire("error");
    expect(player.state().error).toBeNull();
    player.play(ep("a"));
    audio.fire("error");
    expect(player.state()).toMatchObject({ playing: false, error: "Could not load this episode." });
  });

  test("Media Session: metadata, playback state, and play/pause/seek handlers drive the player", () => {
    const session = new FakeSession();
    const { audio, player } = setup({ session });
    player.play(ep("a"));
    expect((session.metadata as FakeMetadata).init).toEqual({ title: "Episode a", artist: "AI news podcast", album: "wissel" });
    expect(session.playbackState).toBe("playing");
    audio.loadMeta(600);
    expect(session.positions.at(-1)).toMatchObject({ duration: 600, position: 0 });

    session.handlers.get("pause")!({});
    expect(audio.paused).toBe(true);
    expect(session.playbackState).toBe("paused");
    session.handlers.get("play")!({});
    expect(audio.paused).toBe(false);
    session.handlers.get("seekto")!({ seekTime: 300 });
    expect(audio.currentTime).toBe(300);
    session.handlers.get("seekforward")!({});
    expect(audio.currentTime).toBe(330);
    session.handlers.get("seekbackward")!({ seekOffset: 10 });
    expect(audio.currentTime).toBe(320);

    player.destroy();
    expect([...session.handlers.values()].every((h) => h === null)).toBe(true);
  });

  test("without Media Session, or with an action the browser refuses, the player still works", () => {
    const session = new FakeSession();
    session.refuseSeekTo = true;
    const { player } = setup({ session });
    expect(() => player.play(ep("a"))).not.toThrow();
    expect(session.handlers.has("seekto")).toBe(false);
    const bare = setup();
    bare.player.play(ep("b"));
    expect(bare.player.state().playing).toBe(true);
  });

  test("destroy stops listening to the audio", () => {
    const { audio, player } = setup();
    player.play(ep("a"));
    player.destroy();
    audio.tick(42);
    expect(player.state().position).toBe(0);
  });
});
