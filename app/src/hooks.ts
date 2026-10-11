import { useCallback, useEffect, useRef, useState } from "react";
import { fetchFeed, fetchPipelines, fetchPodcasts, fetchTasks } from "./api";
import { events, type ConnectionState } from "./events";
import { parseRoute, type Route } from "./routes";
import type { FeedItem, PipelineDef, PodcastEpisode, TaskCard } from "./types";

export function useHashRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export interface BoardData {
  tasks: TaskCard[];
  pipelines: PipelineDef[];
  /** False until the first /tasks answer (or failure). */
  loaded: boolean;
  error: string | null;
  connection: ConnectionState;
}

/** Board events arrive in bursts (a run moves, gets a result, moves
 *  again), so refetches wait this long for the burst to settle. */
const REFETCH_DEBOUNCE_MS = 150;

/** /tasks and /pipelines, refetched on any `/events` message through
 *  the app's one shared EventSource, the same way /board refetches. */
export function useBoardData(): BoardData {
  const [tasks, setTasks] = useState<TaskCard[]>([]);
  const [pipelines, setPipelines] = useState<PipelineDef[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>(events.state());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, p] = await Promise.all([fetchTasks(), fetchPipelines()]);
      setTasks(t);
      setPipelines(p);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const offState = events.onState(setConnection);
    const off = events.subscribe(() => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void load(), REFETCH_DEBOUNCE_MS);
    });
    setConnection(events.state());
    return () => {
      off();
      offState();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  return { tasks, pipelines, loaded, error, connection };
}

export interface FeedData {
  items: FeedItem[];
  /** The `before` for the next page; null when there is no more. */
  next: string | null;
  loaded: boolean;
  error: string | null;
  loadingMore: boolean;
  loadMore: () => void;
}

/** One page of the feed; also the most a live refresh refetches. */
export const FEED_PAGE = 50;
const FEED_MAX = 200;

/** GET /feed, refetched on any `/events` message (a card moved, a
 *  result landed) through the shared EventSource. A refresh refetches
 *  as many items as are showing, so "Load more" pages stay put. */
export function useFeed(): FeedData {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const shown = useRef(FEED_PAGE);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const page = await fetchFeed(Math.min(FEED_MAX, Math.max(FEED_PAGE, shown.current)));
      setItems(page.items);
      setNext(page.next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const off = events.subscribe(() => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void refresh(), REFETCH_DEBOUNCE_MS);
    });
    return () => {
      off();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [refresh]);

  const loadMore = useCallback(() => {
    if (!next || loadingMore) return;
    setLoadingMore(true);
    fetchFeed(FEED_PAGE, next).then(
      (page) => {
        setItems((prev) => {
          const have = new Set(prev.map((i) => i.id));
          const merged = [...prev, ...page.items.filter((i) => !have.has(i.id))];
          shown.current = merged.length;
          return merged;
        });
        setNext(page.next);
        setLoadingMore(false);
      },
      (err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoadingMore(false);
      },
    );
  }, [next, loadingMore]);

  return { items, next, loaded, error, loadingMore, loadMore };
}

export interface PodcastData {
  episodes: PodcastEpisode[];
  loaded: boolean;
  error: string | null;
}

/** Episodes per pipeline the Listen tab shows. */
export const LISTEN_PER_PIPELINE = 10;

/** GET /podcasts, refetched on any `/events` message (a run finishing
 *  makes a new episode) through the shared EventSource. */
export function usePodcasts(): PodcastData {
  const [episodes, setEpisodes] = useState<PodcastEpisode[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      setEpisodes(await fetchPodcasts(LISTEN_PER_PIPELINE));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const off = events.subscribe(() => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void refresh(), REFETCH_DEBOUNCE_MS);
    });
    return () => {
      off();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [refresh]);

  return { episodes, loaded, error };
}

/** True when the viewport is at least the desktop breakpoint (rail +
 *  Live panel). CSS does the layout; this only decides what to mount. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    mql.addEventListener("change", onChange);
    onChange();
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}
