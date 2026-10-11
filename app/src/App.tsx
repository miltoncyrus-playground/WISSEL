import { useCallback, useEffect, useMemo, useState } from "react";
import { runNotice, runPipeline } from "./api";
import { buildCommands, isPaletteShortcut, type Command } from "./commands";
import { useBoardData, useHashRoute, useMediaQuery } from "./hooks";
import { partitionLanes } from "./lanes";
import { SCREENS } from "./routes";
import { LivePanel } from "./components/LivePanel";
import { Rail, TabBar, TopBar } from "./components/Nav";
import { Palette } from "./components/Palette";
import { BoardScreen, CardDetail } from "./screens/BoardScreen";
import { FeedScreen } from "./screens/FeedScreen";
import { Placeholder } from "./screens/Placeholder";

/** Rail + Live panel from here up; tab bar below (SDD §3.1). The shell
 *  gets `is-desktop` or `is-phone` from this; index.css lays out on
 *  those classes, not on its own media query. */
export const DESKTOP_QUERY = "(min-width: 1024px)";

/** Re-partition at least this often so "Done today" rolls over at
 *  midnight without an event. */
const CLOCK_TICK_MS = 60_000;

export function App() {
  const route = useHashRoute();
  const data = useBoardData();
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const lanes = useMemo(() => partitionLanes(data.tasks, now), [data.tasks, now]);
  const commands = useMemo(() => buildCommands({ tasks: data.tasks, pipelines: data.pipelines }), [data.tasks, data.pipelines]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || !isPaletteShortcut(e)) return;
      e.preventDefault();
      setPaletteOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);

  const run = useCallback((c: Command) => {
    const a = c.action;
    if (a.kind === "go") {
      location.hash = a.hash;
    } else if (a.kind === "open-url") {
      location.assign(a.url);
    } else {
      setNotice(`Running ${a.name}…`);
      runPipeline(a.pipelineId).then(
        (root) => setNotice(runNotice(a.name, root)),
        (err: unknown) => setNotice(`${a.name} could not run: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
  }, []);

  const title = SCREENS.find((s) => s.id === route.screen)?.label ?? "";

  useEffect(() => {
    document.title = `${title} · wissel`;
  }, [title]);

  let screen;
  if (route.screen === "board") {
    screen = route.taskId ? <CardDetail taskId={route.taskId} tasks={data.tasks} loaded={data.loaded} /> : <BoardScreen lanes={lanes} loaded={data.loaded} error={data.error} />;
  } else if (route.screen === "feed") {
    screen = <FeedScreen now={now} />;
  } else {
    screen = <Placeholder screen={route.screen} />;
  }

  return (
    <div className={`shell ${desktop ? "is-desktop" : "is-phone"}`}>
      {desktop ? <Rail current={route.screen} onOpenPalette={openPalette} /> : <TopBar title={title} onOpenPalette={openPalette} />}
      <main className="content" id="main" data-screen={route.screen}>
        {screen}
      </main>
      {desktop && <LivePanel lanes={lanes} connection={data.connection} />}
      {!desktop && <TabBar current={route.screen} />}
      <p className="notice" role="status" aria-live="polite">
        {notice}
      </p>
      <Palette open={paletteOpen} commands={commands} onClose={closePalette} onRun={run} />
    </div>
  );
}
