import { useCallback, useEffect, useRef, useState } from "react";
import { fetchPipelines, fetchTasks } from "./api";
import { events, type ConnectionState } from "./events";
import { parseRoute, type Route } from "./routes";
import type { PipelineDef, TaskCard } from "./types";

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
