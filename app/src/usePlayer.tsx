import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPlayer, loadNowPlaying, type MediaSessionLike, type Player, type PlayerState, type Track } from "./player";

// React glue for app/src/player.ts. The shell (App) calls useShellPlayer
// once, renders the one <audio> with its ref and provides the API on
// PlayerContext; the mini-player, Listen and the feed read it with
// usePlayer. The <audio> never unmounts, so changing screens (or
// crossing the phone/desktop breakpoint) never stops playback.

export interface PlayerApi {
  state: PlayerState;
  play: (track?: Track) => void;
  pause: () => void;
  toggle: () => void;
  seek: (seconds: number) => void;
  skip: (delta: number) => void;
  savedPosition: (runId: string) => number | undefined;
}

const EMPTY: PlayerState = { track: null, playing: false, position: 0, duration: 0, error: null };

export const PlayerContext = createContext<PlayerApi | null>(null);

export function usePlayer(): PlayerApi {
  const api = useContext(PlayerContext);
  if (!api) throw new Error("usePlayer outside the shell's PlayerContext");
  return api;
}

/** localStorage, or undefined where even reading it throws (some
 *  sandboxed or private contexts). */
function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function useShellPlayer(): { api: PlayerApi; audioRef: (el: HTMLAudioElement | null) => void } {
  const [state, setState] = useState<PlayerState>(EMPTY);
  const player = useRef<Player | null>(null);

  const audioRef = useCallback((el: HTMLAudioElement | null) => {
    player.current?.destroy();
    player.current = null;
    if (!el) return;
    const storage = safeStorage();
    const mediaSession = "mediaSession" in navigator ? (navigator.mediaSession as unknown as MediaSessionLike) : undefined;
    const MediaMetadata = typeof window.MediaMetadata === "function" ? window.MediaMetadata : undefined;
    const p = createPlayer({ audio: el, storage, mediaSession, MediaMetadata, onChange: setState });
    player.current = p;
    // The last episode comes back paused at its spot after a reload.
    const last = loadNowPlaying(storage);
    if (last) p.cue(last);
  }, []);

  useEffect(() => {
    const save = () => player.current?.persist();
    window.addEventListener("pagehide", save);
    return () => window.removeEventListener("pagehide", save);
  }, []);

  const api = useMemo<PlayerApi>(
    () => ({
      state,
      play: (t) => player.current?.play(t),
      pause: () => player.current?.pause(),
      toggle: () => player.current?.toggle(),
      seek: (s) => player.current?.seek(s),
      skip: (d) => player.current?.skip(d),
      savedPosition: (id) => player.current?.savedPosition(id),
    }),
    [state],
  );
  return { api, audioRef };
}
