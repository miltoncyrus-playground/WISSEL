// The app's one audio player (docs/SDD-wissel-app.md §3.3). The shell
// owns a single <audio> element and hands it to createPlayer, so playback
// and position survive moving between screens; the mini-player, the
// Listen tab and the feed only call this. No React and no DOM globals
// here: the audio element, storage and Media Session come in as
// arguments, so app/test/player.test.ts drives it with fakes.
//
// Remembered in localStorage, always inside try/catch (private mode and
// a full quota just mean nothing is remembered):
//   wissel.app.positions   { [runId]: { t: seconds, at: ms } }, newest 50
//   wissel.app.nowPlaying  the last loaded track, restored paused on reload

export interface Track {
  runId: string;
  title: string;
  pipelineName: string;
  audioUrl: string;
  durationSeconds?: number;
}

export interface PlayerState {
  track: Track | null;
  playing: boolean;
  /** Seconds into the track. */
  position: number;
  /** Seconds; the track's own estimate until the audio's metadata loads, 0 when unknown. */
  duration: number;
  error: string | null;
}

/** The parts of HTMLAudioElement the player uses. */
export interface AudioLike {
  src: string;
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  play(): Promise<void> | void;
  pause(): void;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** navigator.mediaSession, as far as the player uses it. */
export interface MediaSessionLike {
  metadata: unknown;
  playbackState?: string;
  setActionHandler(action: string, handler: ((details: { seekTime?: number; seekOffset?: number }) => void) | null): void;
  setPositionState?(state: { duration: number; position: number; playbackRate?: number }): void;
}

export interface PlayerDeps {
  audio: AudioLike;
  storage?: StorageLike;
  mediaSession?: MediaSessionLike;
  /** window.MediaMetadata when the browser has it. */
  MediaMetadata?: new (init: { title: string; artist: string; album: string }) => unknown;
  now?: () => number;
  onChange?: (state: PlayerState) => void;
}

export const POSITIONS_KEY = "wissel.app.positions";
export const NOW_PLAYING_KEY = "wissel.app.nowPlaying";
export const MAX_POSITIONS = 50;
/** Saved at most this often while playing (and on every pause). */
export const SAVE_EVERY_MS = 5_000;
/** A saved spot this close to the end starts the episode over. */
export const END_SLACK_SECONDS = 10;
export const SKIP_BACK_SECONDS = 15;
export const SKIP_FORWARD_SECONDS = 30;

export type Positions = Record<string, { t: number; at: number }>;

export function loadPositions(storage: Pick<Storage, "getItem"> | undefined): Positions {
  try {
    const raw = storage?.getItem(POSITIONS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Positions = {};
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      const p = v as { t?: unknown; at?: unknown } | null;
      if (p && typeof p.t === "number" && Number.isFinite(p.t) && p.t >= 0 && typeof p.at === "number") out[id] = { t: p.t, at: p.at };
    }
    return out;
  } catch {
    return {};
  }
}

function writeJson(storage: Pick<Storage, "setItem"> | undefined, key: string, value: unknown): void {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // Full or blocked: forget it.
  }
}

/** Remembers `t` for a run, keeping the newest MAX_POSITIONS. */
export function savePosition(storage: StorageLike | undefined, runId: string, t: number, at: number): void {
  if (!Number.isFinite(t) || t < 0) return;
  const all = loadPositions(storage);
  all[runId] = { t: Math.floor(t), at };
  const kept = Object.entries(all)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_POSITIONS);
  writeJson(storage, POSITIONS_KEY, Object.fromEntries(kept));
}

export function forgetPosition(storage: StorageLike | undefined, runId: string): void {
  const all = loadPositions(storage);
  if (!(runId in all)) return;
  delete all[runId];
  writeJson(storage, POSITIONS_KEY, all);
}

/** Where to start a run: its saved spot, unless that is (near) the end. */
export function resumeFrom(saved: number | undefined, duration: number | undefined): number {
  if (saved === undefined || !Number.isFinite(saved) || saved <= 0) return 0;
  if (duration !== undefined && Number.isFinite(duration) && duration > 0 && saved >= duration - END_SLACK_SECONDS) return 0;
  return saved;
}

function isTrack(v: unknown): v is Track {
  const t = v as Partial<Track> | null;
  return (
    !!t &&
    typeof t === "object" &&
    typeof t.runId === "string" &&
    typeof t.title === "string" &&
    typeof t.pipelineName === "string" &&
    typeof t.audioUrl === "string" &&
    // Only our own audio route: a stored URL is never trusted further.
    t.audioUrl.startsWith("/pipeline-runs/") &&
    (t.durationSeconds === undefined || typeof t.durationSeconds === "number")
  );
}

export function loadNowPlaying(storage: Pick<Storage, "getItem"> | undefined): Track | null {
  try {
    const raw = storage?.getItem(NOW_PLAYING_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw) as unknown;
    return isTrack(t) ? t : null;
  } catch {
    return null;
  }
}

/** "0:05", "12:34", "1:02:03". */
export function formatClock(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

/** "12 min", "45 s". */
export function formatMinutes(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  return `${Math.round(seconds / 60)} min`;
}

export interface Player {
  state(): PlayerState;
  /** Loads `track` (saving the current one's spot first) and plays it,
   *  from its saved spot. The track already loaded just plays. */
  play(track?: Track): void;
  /** Loads `track` paused at its saved spot (a reload restoring the last one). */
  cue(track: Track): void;
  pause(): void;
  toggle(): void;
  seek(seconds: number): void;
  skip(delta: number): void;
  /** Saves the current spot now (on pagehide). */
  persist(): void;
  /** The saved spot for a run, for "Resume at 3:12". */
  savedPosition(runId: string): number | undefined;
  destroy(): void;
}

export function createPlayer(deps: PlayerDeps): Player {
  const { audio, storage, mediaSession, MediaMetadata } = deps;
  const now = deps.now ?? Date.now;
  let state: PlayerState = { track: null, playing: false, position: 0, duration: 0, error: null };
  let pendingSeek = 0;
  let lastSave = 0;

  function set(patch: Partial<PlayerState>) {
    state = { ...state, ...patch };
    deps.onChange?.(state);
  }

  function knownDuration(): number {
    return Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (state.track?.durationSeconds ?? 0);
  }

  function persist() {
    if (!state.track) return;
    lastSave = now();
    savePosition(storage, state.track.runId, audio.currentTime, lastSave);
  }

  function syncPositionState() {
    const duration = knownDuration();
    if (!mediaSession?.setPositionState || !(duration > 0)) return;
    try {
      mediaSession.setPositionState({ duration, position: Math.min(Math.max(0, audio.currentTime), duration), playbackRate: 1 });
    } catch {
      // Some browsers throw on a position the audio hasn't loaded yet.
    }
  }

  function startPlayback() {
    let p: Promise<void> | void;
    try {
      p = audio.play();
    } catch (err) {
      set({ playing: false, error: playError(err) });
      return;
    }
    if (p && typeof p.catch === "function") {
      p.catch((err: unknown) => {
        // A newer load() or pause() cut this play short: not an error.
        if ((err as { name?: string } | null)?.name === "AbortError") return;
        set({ playing: false, error: playError(err) });
      });
    }
  }

  function load(track: Track) {
    if (state.track && state.track.runId !== track.runId) persist();
    pendingSeek = resumeFrom(loadPositions(storage)[track.runId]?.t, track.durationSeconds);
    audio.src = track.audioUrl;
    writeJson(storage, NOW_PLAYING_KEY, track);
    set({ track, playing: false, position: pendingSeek, duration: track.durationSeconds ?? 0, error: null });
    if (mediaSession && MediaMetadata) {
      try {
        mediaSession.metadata = new MediaMetadata({ title: track.title, artist: track.pipelineName, album: "wissel" });
      } catch {
        // Leave the browser's default.
      }
    }
  }

  const on: Record<string, () => void> = {
    loadedmetadata: () => {
      if (pendingSeek > 0) {
        const at = resumeFrom(pendingSeek, audio.duration);
        if (at > 0) audio.currentTime = at;
        pendingSeek = 0;
      }
      set({ duration: knownDuration(), position: audio.currentTime });
      syncPositionState();
    },
    durationchange: () => set({ duration: knownDuration() }),
    timeupdate: () => {
      // Before metadata loads the element reports 0; keep the resume spot showing.
      if (pendingSeek > 0) return;
      set({ position: audio.currentTime });
      if (!audio.paused && now() - lastSave >= SAVE_EVERY_MS) persist();
    },
    play: () => {
      set({ playing: true, error: null });
      if (mediaSession) mediaSession.playbackState = "playing";
    },
    pause: () => {
      set({ playing: false, position: pendingSeek > 0 ? pendingSeek : audio.currentTime });
      if (pendingSeek === 0) persist();
      if (mediaSession) mediaSession.playbackState = "paused";
    },
    ended: () => {
      if (state.track) forgetPosition(storage, state.track.runId);
      set({ playing: false, position: 0 });
      if (mediaSession) mediaSession.playbackState = "none";
    },
    error: () => {
      if (!state.track) return;
      set({ playing: false, error: "Could not load this episode." });
    },
  };
  for (const [type, fn] of Object.entries(on)) audio.addEventListener(type, fn);

  const api: Player = {
    state: () => state,
    play(track) {
      if (track && track.runId !== state.track?.runId) load(track);
      if (!state.track) return;
      startPlayback();
    },
    cue(track) {
      load(track);
    },
    pause() {
      audio.pause();
    },
    toggle() {
      if (!state.track) return;
      if (audio.paused) startPlayback();
      else audio.pause();
    },
    seek(seconds) {
      if (!state.track || !Number.isFinite(seconds)) return;
      const duration = knownDuration();
      const t = Math.max(0, duration > 0 ? Math.min(seconds, duration) : seconds);
      pendingSeek = 0;
      audio.currentTime = t;
      set({ position: t });
      persist();
      syncPositionState();
    },
    skip(delta) {
      api.seek((pendingSeek > 0 ? pendingSeek : audio.currentTime) + delta);
    },
    persist,
    savedPosition: (runId) => loadPositions(storage)[runId]?.t,
    destroy() {
      for (const [type, fn] of Object.entries(on)) audio.removeEventListener(type, fn);
      if (mediaSession) for (const a of MEDIA_ACTIONS) safeHandler(mediaSession, a, null);
    },
  };

  if (mediaSession) {
    safeHandler(mediaSession, "play", () => api.play());
    safeHandler(mediaSession, "pause", () => api.pause());
    safeHandler(mediaSession, "seekbackward", (d) => api.skip(-(d.seekOffset ?? SKIP_BACK_SECONDS)));
    safeHandler(mediaSession, "seekforward", (d) => api.skip(d.seekOffset ?? SKIP_FORWARD_SECONDS));
    safeHandler(mediaSession, "seekto", (d) => {
      if (typeof d.seekTime === "number") api.seek(d.seekTime);
    });
  }
  return api;
}

const MEDIA_ACTIONS = ["play", "pause", "seekbackward", "seekforward", "seekto"] as const;

/** Browsers throw on an action they don't support; skip it. */
function safeHandler(ms: MediaSessionLike, action: string, fn: ((d: { seekTime?: number; seekOffset?: number }) => void) | null) {
  try {
    ms.setActionHandler(action, fn);
  } catch {
    // Unsupported action.
  }
}

function playError(err: unknown): string {
  const name = (err as { name?: string } | null)?.name;
  if (name === "NotAllowedError") return "The browser blocked playback. Press play again.";
  if (name === "NotSupportedError") return "This browser can't play this episode.";
  return "Could not play this episode.";
}
