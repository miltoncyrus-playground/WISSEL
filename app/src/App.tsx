import { useCallback, useEffect, useMemo, useState } from "react";
import { runNotice, runPipeline } from "./api";
import { buildCommands, isPaletteShortcut, type Command } from "./commands";
import { useBoardData, useHashRoute, useMediaQuery } from "./hooks";
import { partitionLanes } from "./lanes";
import { isEmbedded, SCREENS } from "./routes";
import { LivePanel } from "./components/LivePanel";
import { MiniPlayer } from "./components/MiniPlayer";
import { Rail, TabBar, TopBar } from "./components/Nav";
import { Palette } from "./components/Palette";
import { AskScreen } from "./screens/AskScreen";
import { BoardScreen, CardDetail } from "./screens/BoardScreen";
import { FeedScreen } from "./screens/FeedScreen";
import { ListenScreen } from "./screens/ListenScreen";
import { YouScreen } from "./screens/YouScreen";
import { CoordinatorScreen } from "./screens/CoordinatorScreen";
import { AgentsContext, useAgentsLoader } from "./useAgents";
import { ProjectsContext, useProjectsLoader } from "./useProjects";
import { useAsk } from "./useAsk";
import { PlayerContext, useShellPlayer } from "./usePlayer";
import { readUiMode, UiModeContext } from "./uiMode";

/** Rail + Live panel from here up; tab bar below (SDD §3.1). The shell
 *  gets `is-desktop` or `is-phone` from this; index.css lays out on
 *  those classes, not on its own media query. */
export const DESKTOP_QUERY = "(min-width: 1024px)";

/** Re-partition at least this often so "Done today" rolls over at
 *  midnight without an event. */
const CLOCK_TICK_MS = 60_000;

export function App() {
  const route = useHashRoute();
  // Operator or user mode (docs/SDD-board-ui-for-teams.md §3), read once
  // here and passed down; operator unless the URL or a stored choice says.
  const [uiMode] = useState(readUiMode);
  const data = useBoardData();
  const desktop = useMediaQuery(DESKTOP_QUERY);
  // Docked beside the board (/app?embed=1): the screen only, no rail, tab
  // bar or live panel (docs/SDD-coordinator.md §4.14).
  const embedded = isEmbedded(typeof window === "undefined" ? "" : window.location.search);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const player = useShellPlayer();
  // Held by the shell so a reply that lands while another tab is open
  // is there on return (SDD §3.4).
  const ask = useAsk(data.reload);
  const hasPlayer = player.api.state.track !== null;
  // Names and faces for every agent on every screen (SDD §3.6).
  const agents = useAgentsLoader();
  // The registered projects, for the ticket on each card.
  const projects = useProjectsLoader();

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

  const title = route.screen === "coordinator" ? "Coordinator" : (SCREENS.find((s) => s.id === route.screen)?.label ?? "");

  useEffect(() => {
    document.title = `${title} · wissel`;
  }, [title]);

  let screen;
  if (route.screen === "board") {
    screen = route.taskId ? <CardDetail taskId={route.taskId} tasks={data.tasks} loaded={data.loaded} /> : <BoardScreen lanes={lanes} loaded={data.loaded} error={data.error} reload={data.reload} />;
  } else if (route.screen === "feed") {
    screen = <FeedScreen now={now} />;
  } else if (route.screen === "listen") {
    screen = <ListenScreen now={now} />;
  } else if (route.screen === "coordinator") {
    screen = <CoordinatorScreen workstreamId={route.workstreamId} />;
  } else if (route.screen === "ask") {
    screen = <AskScreen ask={ask} tasks={data.tasks} tasksLoaded={data.loaded} pipelines={data.pipelines} now={now} />;
  } else {
    screen = <YouScreen running={lanes.running} />;
  }

  // The one <audio> (SDD §3.3) sits outside everything that changes
  // with the route or the breakpoint, so playback never stops.
  return (
    <UiModeContext.Provider value={uiMode}>
    <AgentsContext.Provider value={agents}>
      <ProjectsContext.Provider value={projects}>
      <PlayerContext.Provider value={player.api}>
        <div className={`shell ${embedded ? "is-embedded" : desktop ? "is-desktop" : "is-phone"}${hasPlayer ? " has-player" : ""}`}>
          {embedded ? null : desktop ? <Rail current={route.screen} onOpenPalette={openPalette} /> : <TopBar title={title} onOpenPalette={openPalette} />}
          <main className="content" id="main" data-screen={route.screen}>
            {screen}
          </main>
          {!embedded && desktop && <LivePanel lanes={lanes} connection={data.connection} reload={data.reload} player={<MiniPlayer variant="panel" />} />}
          {!embedded && !desktop && <MiniPlayer variant="bar" />}
          {!embedded && !desktop && <TabBar current={route.screen} />}
          <p className="notice" role="status" aria-live="polite">
            {notice}
          </p>
          <Palette open={paletteOpen} commands={commands} onClose={closePalette} onRun={run} />
          <audio ref={player.audioRef} preload="metadata" className="shell-audio" />
        </div>
      </PlayerContext.Provider>
      </ProjectsContext.Provider>
    </AgentsContext.Provider>
    </UiModeContext.Provider>
  );
}
