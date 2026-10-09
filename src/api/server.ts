import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Board, BoardEvent } from "../services/board.ts";
import { SqliteBoard } from "../services/board.ts";
import type { PipelineStore } from "../services/pipelines.ts";
import { SqlitePipelineStore } from "../services/pipelines.ts";
import type { ProjectStore } from "../services/projects.ts";
import { SqliteProjectStore } from "../services/projects.ts";
import { TelemetryLog } from "../services/telemetry.ts";
import { HarnessPool, validateAgentHarnesses } from "../core/harness-pool.ts";
import { McpServerPool, checkMcpServerReachable, parseMcpServerCreateInput, type CheckMcpServerReachableOptions } from "../core/mcp-server-pool.ts";
import { setMcpServerEnabled, setMcpServerToolTrust, addMcpServer } from "../core/mcp-manifest.ts";
import { Registry } from "../core/registry.ts";
import { buildAccountStatus } from "../core/account-status.ts";
import { Router } from "../core/router.ts";
import { Orchestrator, finishResult, resolveHandoffAllowlist, wireAutoIntegrator } from "../core/orchestrator.ts";
import { reconcileOrphanedTasks, reconcileInterruptedReviewVerdicts } from "../core/crash-recovery.ts";
import { PipelineRepoRequiredError, startPipelineRun, stepsNeedingRepo } from "../core/pipeline-runner.ts";
import { startMemoryScheduler, getMemoryCurationHistory } from "../core/memory-scheduler.ts";
import { startArchiveScheduler } from "../core/archive-scheduler.ts";
import { startModelRefreshScheduler, readModelsCache, DEFAULT_MODELS_CACHE_PATH } from "../core/model-refresh-scheduler.ts";
import { startMergeHealthScheduler } from "../core/merge-health-scheduler.ts";
import { readMemoryLessons, DEFAULT_MEMORY_PATH } from "../services/memory.ts";
import { appendTaskOutput, getBufferedOutput, getTaskOutput, TASK_OUTPUT_EVENTS } from "../services/task-output.ts";
import { buildPipelineRunSummary } from "../services/pipeline-run-summary.ts";
import { ReadOnlyExecutor } from "../executors/readonly.ts";
import { WriteExecutor } from "../executors/write.ts";
import { ApiExecutor } from "../executors/anthropic-api.ts";
import { CodexReadOnlyExecutor } from "../executors/codex-readonly.ts";
import { CodexWriteExecutor } from "../executors/codex-write.ts";
import { DEFAULT_TTS_URL, DEFAULT_TTS_VOICE, TtsExecutor, defaultAudioDir, isSafeRunId } from "../executors/tts.ts";
import { pipelineAudioBytes, pipelineAudioResponse } from "../services/pipeline-audio.ts";
import { getRepoDiff } from "../services/repo-diff.ts";
import { getProjectGitStatus } from "../services/project-status.ts";
import { generateProjectEli5 } from "../services/project-eli5.ts";
import type { AnthropicMessagesClient } from "../executors/anthropic-api.ts";
import { mergeTaskWorktree, removeTaskWorktree } from "../services/worktree.ts";
import { runViaBun, type CommandRunner } from "../executors/claude-cli.ts";
import { checkHarnessAuth } from "../core/harness-discovery.ts";
import { setHarnessEnabled, setHarnessModel } from "../core/harness-manifest.ts";
import { getVersionInfo } from "../core/version.ts";
import { installShutdownHandlers } from "../executors/child-processes.ts";
import type { Executor, PipelineGraph, RoutingDecision, TaskCard, TaskResult } from "../core/types.ts";

const PUBLIC_DIR = new URL("./public/", import.meta.url);
// src/api/server.ts -> ../../pipeline-editor/dist/ = <repo root>/pipeline-editor/dist/
const DEFAULT_PIPELINE_EDITOR_DIST = new URL("../../pipeline-editor/dist/", import.meta.url);

export interface CreateAppOptions {
  /** Starts the automatic sweep-on-every-event loop. Off by default —
   *  matches the pre-existing WISSEL_ORCHESTRATOR gate. */
  orchestratorEnabled?: boolean;
  /** Lets the automatic loop itself run write-tier work (see
   *  Orchestrator's option of the same name) instead of only
   *  dispatching it. Off by default. Doesn't affect the manual
   *  `/tasks/:id/run` endpoint below, which always can. */
  executeWriteTier?: boolean;
  /** Passed straight through to Orchestrator's option of the same name
   *  — see its own doc comment. Undefined means unlimited. */
  maxConcurrentTasks?: number;
  /** Passed straight through to Orchestrator's option of the same name
   *  — see its own doc comment. Undefined means unlimited. */
  spendCeilingUsd?: number;
  /** Executor pool the manual `/tasks/:id/run` endpoint uses — defaults
   *  to a real ReadOnlyExecutor + WriteExecutor pair. Overridable so
   *  tests can inject fakes instead of spawning a real `claude`
   *  process. */
  manualExecutors?: Executor[];
  /** Harnesses wissel can run local work under — see
   *  docs/SDD-execution-harnesses.md. Defaults to an empty pool (no
   *  harness concept in play), matching wissel's behavior before
   *  harnesses existed. */
  harnesses?: HarnessPool;
  /** Path to the harnesses.yaml manifest — where `POST
   *  /harnesses/:id/enable`/`/disable`/`/model` persist a human's
   *  decision (see docs/SDD-harness-enable-disable.md and
   *  docs/SDD-model-selection.md). Defaults to the same "harnesses.yaml"
   *  relative path HarnessPool.load()/autoload() already default to.
   *  The `WISSEL_HARNESSES_PATH` env override is read once at the
   *  `src/api/server.ts` bootstrap entrypoint (same convention as every
   *  other `WISSEL_*_PATH` var) and passed straight through here — this
   *  option itself never reads `process.env`. */
  harnessesPath?: string;
  /** Used only by `POST /harnesses/:id/enable`'s re-validation check —
   *  injectable so tests never spawn a real `claude`/`codex` process.
   *  Defaults to the real one. */
  harnessRunner?: CommandRunner;
  /** MCP servers (external tool surfaces — Slack, a database, a
   *  ticketing system) an agent can reach once it's running — orthogonal
   *  to `harnesses` (which answers "whose account runs the process," not
   *  "what capability can it reach"). See
   *  docs/SDD-mcp-orchestration.md §3.1. Defaults to an empty pool (no
   *  MCP servers registered), same "injectable, sensible empty default"
   *  convention `harnesses` above follows. */
  mcpServers?: McpServerPool;
  /** Path to the mcp-servers.yaml manifest — where `POST
   *  /mcp-servers/:id/enable`/`/disable` persist a human's decision. Same
   *  convention as `harnessesPath` above. */
  mcpServersPath?: string;
  /** Used only by `POST /mcp-servers/:id/enable`'s re-validation check —
   *  injectable so tests never hit a real filesystem PATH lookup or
   *  network probe. Defaults to the real environment/fetch. */
  mcpServerReachabilityOpts?: CheckMcpServerReachableOptions;
  /** Starts the in-process memory-curation scheduler (see
   *  src/core/memory-scheduler.ts) — off by default, same gate pattern
   *  as orchestratorEnabled. A no-op if `telemetry` isn't also given:
   *  due-ness is read from the telemetry log, so there's nothing to
   *  schedule against without one. */
  memoryCurationEnabled?: boolean;
  /** Passed straight through to startMemoryScheduler's option of the
   *  same name — see its own doc comment. Defaults to 24 there. */
  memoryIntervalHours?: number;
  /** Where the global memory file lives — see
   *  src/services/memory.ts's DEFAULT_MEMORY_PATH. Overridable so tests
   *  never touch this repo's own real memory/lessons.md. */
  memoryPath?: string;
  /** Gates whether `memoryPath`'s content is folded into every
   *  claude-cli/codex-cli agent prompt — see
   *  docs/SDD-memory-injection-toggle.md. Off by default: memory
   *  curation (memoryCurationEnabled above, `writeMemoryLessons`, `GET
   *  /memory`) keeps running exactly as before regardless of this flag;
   *  this only controls whether the result ever reaches an agent's
   *  prompt. Read once from `WISSEL_MEMORY_INJECTION` at the
   *  `src/api/server.ts` bootstrap entrypoint (same convention as every
   *  other `WISSEL_*` flag) and passed straight through here — threaded
   *  into every executor built below and from there into
   *  `runClaude`/`runCodex`; no executor or run function ever reads
   *  `process.env` itself. */
  injectMemory?: boolean;
  /** Starts the in-process auto-archive scheduler (see
   *  src/core/archive-scheduler.ts) — off by default, same gate pattern
   *  as memoryCurationEnabled. Unlike memory curation, needs no
   *  telemetry: due-ness is read straight off TaskCard.doneAt. */
  autoArchiveEnabled?: boolean;
  /** Passed straight through to startArchiveScheduler's option of the
   *  same name — see its own doc comment. Defaults to 1 there. Distinct
   *  from the fixed 24h auto-archive threshold itself
   *  (AUTO_ARCHIVE_AFTER_HOURS), which is not configurable. */
  archiveCheckIntervalHours?: number;
  /** Starts the in-process model-catalog refresh scheduler (see
   *  src/core/model-refresh-scheduler.ts) — off by default, same gate
   *  pattern as memoryCurationEnabled/autoArchiveEnabled. A no-op if
   *  `harnesses` isn't also given anything to resolve. */
  modelRefreshEnabled?: boolean;
  /** Passed straight through to startModelRefreshScheduler's option of
   *  the same name — see its own doc comment. Defaults to 24 there. */
  modelRefreshIntervalHours?: number;
  /** Passed straight through to startModelRefreshScheduler's `cachePath`
   *  option — see its own doc comment. Defaults to
   *  `DEFAULT_MODELS_CACHE_PATH` (`~/.wissel/models-cache.json`) there. */
  modelsCachePath?: string;
  /** Storage for pipeline definitions (see docs/SDD-pipelines.md §3.7) —
   *  injectable so tests never share a real on-disk pipelines table.
   *  Defaults to a SqlitePipelineStore sharing `board`'s own connection
   *  (see SqliteBoard.db's doc comment for why it has to be the *same*
   *  connection, not a second one opened against the same path). */
  pipelines?: PipelineStore;
  /** Storage for registered projects/repos (see src/services/projects.ts
   *  for the store's CRUD/clone contract) — injectable so tests never
   *  share a real on-disk projects table. Defaults to a SqliteProjectStore
   *  sharing `board`'s own connection, same reasoning as `pipelines` above. */
  projects?: ProjectStore;
  /** The `CommandRunner` used for `POST /projects/local`'s git checks,
   *  `POST /projects/clone`'s git clone, `GET /projects/:id/status`'s
   *  real git state lookup (src/services/project-status.ts), and the
   *  merge-health scheduler's own git checks (src/services/merge-health.ts)
   *  — same shared-real-runner convention `harnessRunner` above already
   *  established (defaults to `runViaBun`), kept as its own option rather
   *  than reusing `harnessRunner` itself since that one's doc comment
   *  scopes it specifically to `POST /harnesses/:id/enable`'s
   *  re-validation check. Overridable so tests never spawn a real `git`
   *  subprocess for the failure-path cases (bad URL, auth failure). */
  commandRunner?: CommandRunner;
  /** Injectable Anthropic client factory for `GET /projects/:id/eli5`
   *  (src/services/project-eli5.ts) — same convention as ApiExecutor's
   *  own `clientFactory` option (src/executors/anthropic-api.ts):
   *  defaults to a real client using ambient credentials, overridable so
   *  tests never spend a real token generating a summary. */
  projectEli5ClientFactory?: (apiKey?: string) => AnthropicMessagesClient;
  /** Where a task's durable raw-output JSONL lives (see
   *  src/services/task-output.ts's own DEFAULT_TASK_OUTPUT_DIR). Defaults
   *  to `~/.wissel/task-output`; overridable so tests never touch that
   *  real directory — same "injectable so a fixture run can't pollute
   *  the real thing" convention memoryPath/modelsCachePath already use. */
  taskOutputDir?: string;
  /** Directory pipeline-editor's built static output is served from at
   *  `GET /pipelines/edit` — see docs/SDD-pipelines.md §3.2/§4. Defaults
   *  to `pipeline-editor/dist/` at the repo root, resolved the same way
   *  PUBLIC_DIR resolves board.html (relative to this file, not cwd).
   *  Overridable so tests point it at a fixture directory instead of
   *  requiring a real `vite build` to exist on disk. */
  pipelineEditorDist?: URL;
  /** Starts the in-process dangling-merge detection scheduler (see
   *  src/core/merge-health-scheduler.ts and
   *  docs/SDD-crash-recovery.md §3.2/§4) — off by default, same gate
   *  pattern as memoryCurationEnabled/autoArchiveEnabled/
   *  modelRefreshEnabled. Detection and board visibility only — never
   *  auto-resolution. */
  mergeHealthEnabled?: boolean;
  /** Passed straight through to startMergeHealthScheduler's option of
   *  the same name — see its own doc comment. Defaults to
   *  DEFAULT_MERGE_HEALTH_CHECK_INTERVAL_HOURS there (matches
   *  archive-scheduler's own default). */
  mergeHealthIntervalHours?: number;
  /** The local Kokoro text-to-speech service the "Make audio" pipeline
   *  step calls (TtsExecutor, docs/SDD-ai-news-podcast.md §3.7). Read
   *  once from `WISSEL_TTS_URL` / `WISSEL_TTS_VOICE` at the bootstrap
   *  entrypoint; undefined fields use TtsExecutor's defaults
   *  (http://127.0.0.1:8880, af_heart). */
  tts?: { url?: string; voice?: string };
  /** Where a run's MP3 is written and served from (`WISSEL_AUDIO_DIR`).
   *  Defaults to `~/.wissel/audio`; tests point it at a temp dir. */
  audioDir?: string;
}

/**
 * Board API. One SSE stream per board carries card moves and routing
 * decisions, so the fleet view, the routing decision panel, and whatever
 * actually runs write-tier work (agetor, or wissel itself when opted in)
 * all watch the same feed.
 *
 * Exported as a plain fetch handler (not bound to a port) so tests can
 * exercise routing without opening a socket.
 */
export function createApp(
  board: Board & { events?: import("node:events").EventEmitter },
  registry: Registry,
  telemetry?: TelemetryLog,
  opts: CreateAppOptions = {},
) {
  // Stateless wrapper over the registry — safe to build once per app
  // regardless of whether the orchestrator loop is running, so the New
  // Task tab's live preview works even with WISSEL_ORCHESTRATOR unset.
  const router = new Router(registry);
  const harnesses = opts.harnesses ?? HarnessPool.from([]);
  const harnessesPath = opts.harnessesPath ?? "harnesses.yaml";
  const harnessRunner = opts.harnessRunner ?? runViaBun;
  const mcpServers = opts.mcpServers ?? McpServerPool.from([]);
  const mcpServersPath = opts.mcpServersPath ?? "mcp-servers.yaml";
  const mcpServerReachabilityOpts = opts.mcpServerReachabilityOpts ?? {};
  // Same default the refresh scheduler itself falls back to — read here
  // too so `GET /harnesses`/`POST /harnesses/:id/model`/`POST /tasks`
  // validate against exactly the file the scheduler (or a real refresh
  // run) actually wrote, whether or not `modelRefreshEnabled` is on.
  const modelsCachePath = opts.modelsCachePath ?? DEFAULT_MODELS_CACHE_PATH;

  const executeWriteTier = opts.executeWriteTier ?? false;
  // Every claude-cli/codex-cli executor streams its subprocess's raw
  // JSONL straight into the durable task-output store as it runs — see
  // docs/SDD-live-task-output.md §3.2/§4. ApiExecutor is excluded: it
  // calls the Messages API directly, not a CLI subprocess, so there's
  // nothing to stream (§5's explicit non-goal).
  const onTaskOutputChunk = (taskId: string, line: unknown) => {
    appendTaskOutput(taskId, line, opts.taskOutputDir);
  };
  // ApiExecutor and CodexReadOnlyExecutor are unconditional, like
  // ReadOnlyExecutor — all three are tier-gated to "readonly" agents
  // (see their canHandle), so there's no write risk to gate behind
  // executeWriteTier the way WriteExecutor/CodexWriteExecutor are.
  // TtsExecutor too: it only writes an MP3 under audioDir, never a repo.
  const audioDir = opts.audioDir ?? defaultAudioDir();
  const ttsExecutor = () => new TtsExecutor({ baseUrl: opts.tts?.url, voice: opts.tts?.voice, audioDir });
  const autoExecutors: Executor[] = [
    new ReadOnlyExecutor({ memoryPath: opts.memoryPath, injectMemory: opts.injectMemory, mcpServers, onChunk: onTaskOutputChunk }),
    new ApiExecutor(),
    new CodexReadOnlyExecutor({ memoryPath: opts.memoryPath, injectMemory: opts.injectMemory, mcpServers, onChunk: onTaskOutputChunk }),
    ttsExecutor(),
  ];
  if (executeWriteTier)
    autoExecutors.push(
      new WriteExecutor({ memoryPath: opts.memoryPath, injectMemory: opts.injectMemory, mcpServers, onChunk: onTaskOutputChunk }),
      new CodexWriteExecutor({ memoryPath: opts.memoryPath, injectMemory: opts.injectMemory, mcpServers, onChunk: onTaskOutputChunk }),
    );
  const manualExecutors: Executor[] = opts.manualExecutors ?? [
    new ReadOnlyExecutor({ memoryPath: opts.memoryPath, injectMemory: opts.injectMemory, mcpServers, onChunk: onTaskOutputChunk }),
    new ApiExecutor(),
    new CodexReadOnlyExecutor({ memoryPath: opts.memoryPath, injectMemory: opts.injectMemory, mcpServers, onChunk: onTaskOutputChunk }),
    new WriteExecutor({ memoryPath: opts.memoryPath, injectMemory: opts.injectMemory, mcpServers, onChunk: onTaskOutputChunk }),
    new CodexWriteExecutor({ memoryPath: opts.memoryPath, injectMemory: opts.injectMemory, mcpServers, onChunk: onTaskOutputChunk }),
    ttsExecutor(),
  ];
  // Fail loud before serving anything if an agent's `harnesses` list names
  // an unknown id or a harness of the wrong tool (a typo would otherwise
  // hold that agent's tasks forever). See
  // docs/SDD-agent-harness-preference.md §3.2.
  validateAgentHarnesses(registry.all(), harnesses, [autoExecutors, manualExecutors]);

  // A pipeline run always executes every step in-process, the same way
  // a human's manual "Run" click does — a pipeline never hands a step
  // off to agetor in this phase (see docs/SDD-pipelines.md §3.3), so it
  // reuses this exact pool rather than the automatic loop's
  // executeWriteTier-gated one.
  const pipelines: PipelineStore = opts.pipelines ?? new SqlitePipelineStore((board as SqliteBoard).db);
  const pipelineEditorDist = opts.pipelineEditorDist ?? DEFAULT_PIPELINE_EDITOR_DIST;
  const projects: ProjectStore = opts.projects ?? new SqliteProjectStore((board as SqliteBoard).db);
  const commandRunner = opts.commandRunner ?? runViaBun;
  const projectEli5ClientFactory = opts.projectEli5ClientFactory;

  // One Orchestrator instance regardless of whether the automatic loop is
  // started, so its `inFlight` guard covers both paths — a human clicking
  // "Run" on a card the automatic sweep is mid-processing (or vice versa)
  // gets a clean "already running" error instead of a double-run, not two
  // independent trackers that can't see each other.
  const orchestrator = new Orchestrator(
    board as Board & { events: import("node:events").EventEmitter },
    registry,
    router,
    autoExecutors,
    telemetry,
    { executeWriteTier, harnesses, maxConcurrentTasks: opts.maxConcurrentTasks, spendCeilingUsd: opts.spendCeilingUsd, memoryPath: opts.memoryPath },
  );
  // Unconditional — cleanup of existing state, not automation of new
  // work, so it runs even when WISSEL_ORCHESTRATOR is off. Every task
  // found at "running" here is a crash/restart orphan (see
  // reconcileOrphanedTasks's own doc comment and docs/SDD-crash-recovery.md
  // §3.1); "dispatched" tasks are deliberately untouched. Sequenced
  // strictly before orchestrator.start()'s own initial sweep() below —
  // not raced against it — so a reconciled task is actually eligible by
  // the time that sweep runs, rather than reset a tick too late with
  // nothing left to trigger a follow-up sweep. The returned fetch
  // handler itself also awaits this below, so a request can never
  // observe a still-orphaned task as "running" post-boot.
  const crashRecoveryReady = (async () => {
    const orphanedCount = await reconcileOrphanedTasks(board).catch((e) => {
      console.error(`crash recovery: reconciliation failed: ${(e as Error).message}`);
      return 0;
    });
    console.log(`crash recovery: reset ${orphanedCount} orphaned running task(s) back to inbox`);

    // Sequenced strictly after the above, not raced against it — a
    // "running" implementer that's also somehow its own reviewer's
    // parent (impossible today, but this ordering costs nothing and
    // avoids ever having to reason about the two passes interleaving).
    // See docs/SDD-crash-recovery.md's interrupted-review-verdict
    // section and reconcileInterruptedReviewVerdicts's own doc comment.
    const recoveredCount = await reconcileInterruptedReviewVerdicts(board as Board, registry, commandRunner).catch((e) => {
      console.error(`crash recovery: review-verdict reconciliation failed: ${(e as Error).message}`);
      return 0;
    });
    console.log(`crash recovery: recovered ${recoveredCount} interrupted review verdict(s)`);
  })();
  if (opts.orchestratorEnabled) void crashRecoveryReady.then(() => orchestrator.start());
  // Always wired, regardless of WISSEL_ORCHESTRATOR — a completed
  // subtask set should get its integrator card queued the moment it
  // completes, the same way spawnReviewerTask always queues a reviewer
  // card, whether or not anything dispatches it automatically. Uses the
  // board's own event stream, which every path that can produce
  // `status: "done"` emits on (finishResult's several branches AND a
  // human's explicit POST /tasks/:id/merge, below) — see
  // wireAutoIntegrator's own doc comment.
  wireAutoIntegrator(board as Board & { events: import("node:events").EventEmitter }, registry);

  // Off by default (WISSEL_MEMORY_CURATION) — see
  // src/core/memory-scheduler.ts and docs/SDD-memory-curator.md §9.
  // Uses the same manualExecutors pool and orchestrator.runNow path a
  // human's board "Run now" click already uses, so a curation run is
  // never a separate execution mechanism to keep in sync.
  if (opts.memoryCurationEnabled && telemetry) {
    startMemoryScheduler({
      board: board as Board,
      orchestrator,
      executors: manualExecutors,
      telemetryPath: telemetry.filePath,
      intervalHours: opts.memoryIntervalHours,
      memoryPath: opts.memoryPath,
    });
  }

  // Off by default (WISSEL_AUTO_ARCHIVE) — see
  // src/core/archive-scheduler.ts and docs/SDD-task-archiving.md §3.3.
  // No telemetry dependency, unlike memory curation above: due-ness is
  // read straight off TaskCard.doneAt via board.list().
  if (opts.autoArchiveEnabled) {
    startArchiveScheduler({ board: board as Board, checkIntervalHours: opts.archiveCheckIntervalHours });
  }

  // Off by default (WISSEL_MODEL_REFRESH) — see
  // src/core/model-refresh-scheduler.ts and docs/SDD-model-selection.md
  // §8. Refreshes every harness's known model list into
  // ~/.wissel/models-cache.json (static re-copy for claude-cli/codex-cli,
  // a live client.models.list() call for anthropic-api).
  if (opts.modelRefreshEnabled) {
    startModelRefreshScheduler({ harnesses, cachePath: modelsCachePath, intervalHours: opts.modelRefreshIntervalHours });
  }

  // Off by default (WISSEL_MERGE_HEALTH) — see
  // src/core/merge-health-scheduler.ts and
  // docs/SDD-crash-recovery.md §3.2/§4. Detection + board visibility of
  // any repo left mid-merge (a dangling `.git/MERGE_HEAD`), never
  // auto-resolution — `GET /merge-health` below reads `getLast()`
  // directly, so it stays [] (not an error) whenever this is off.
  let mergeHealthScheduler: ReturnType<typeof startMergeHealthScheduler> | undefined;
  if (opts.mergeHealthEnabled) {
    mergeHealthScheduler = startMergeHealthScheduler({
      board: board as Board,
      projects,
      runner: commandRunner,
      checkIntervalHours: opts.mergeHealthIntervalHours,
    });
  }

  return async function fetch(req: Request): Promise<Response> {
    // Guarantees no request ever observes a crash-orphaned "running"
    // task before this boot's one-time reconciliation has actually run
    // — explicit sequencing, not a timing assumption. Near-instant in
    // practice (a couple of local sqlite calls), already resolved by
    // the time any real request arrives.
    await crashRecoveryReady;
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);

    try {
      if (url.pathname === "/health") return new Response("ok");

      // No favicon anywhere in this project's history — every browser tab
      // requests it by default regardless, and an unhandled 404 shows up
      // as a console error in any e2e test strict enough to assert zero
      // of them (confirmed live: e2e/live-task-output.spec.ts's console-
      // error assertions were the first to notice). 204 is quieter than a
      // 404 without needing an actual icon file.
      if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });

      // No auth, same as /health — nothing in VersionInfo is sensitive.
      if (url.pathname === "/version") return json(getVersionInfo());

      if ((url.pathname === "/" || url.pathname === "/board") && req.method === "GET") {
        return new Response(Bun.file(new URL("board.html", PUBLIC_DIR)));
      }

      // The task-output row renderer (docs/SDD-live-task-output.md §3.5)
      // — a plain browser script, served as a static sibling file the
      // same way board.html itself is, so it's also directly `import`-able
      // by bun test with zero build step (see test/render-task-output.test.ts).
      if (url.pathname === "/render-task-output.js" && req.method === "GET") {
        return new Response(Bun.file(new URL("render-task-output.js", PUBLIC_DIR)));
      }

      // The merge-health banner's pure render decision (docs/SDD-crash-
      // recovery.md §3.2/§4) — same "static sibling file, zero build
      // step, directly import-able by bun test" reasoning as
      // render-task-output.js above.
      if (url.pathname === "/render-merge-health.js" && req.method === "GET") {
        return new Response(Bun.file(new URL("render-merge-health.js", PUBLIC_DIR)));
      }

      // Harness capacity + an agent's preferred harness list for the
      // fleet rows and the Manage harnesses panel (docs/SDD-agent-
      // harness-preference.md §3.7). Same static-sibling reasoning.
      if (url.pathname === "/render-harness-preference.js" && req.method === "GET") {
        return new Response(Bun.file(new URL("render-harness-preference.js", PUBLIC_DIR)));
      }

      // The board shell's hash routes (docs/SDD-ui-cleanup.md §3.1).
      // Same static-sibling reasoning.
      if (url.pathname === "/board-routes.js" && req.method === "GET") {
        return new Response(Bun.file(new URL("board-routes.js", PUBLIC_DIR)));
      }

      // The board's status→lane table and card placement (docs/SDD-ui-
      // cleanup.md §3.2). Same static-sibling reasoning.
      if (url.pathname === "/board-lanes.js" && req.method === "GET") {
        return new Response(Bun.file(new URL("board-lanes.js", PUBLIC_DIR)));
      }

      // The "+ New" drawer's live-card search (docs/SDD-ui-cleanup.md
      // §3.3). Same static-sibling reasoning.
      if (url.pathname === "/board-new.js" && req.method === "GET") {
        return new Response(Bun.file(new URL("board-new.js", PUBLIC_DIR)));
      }

      // The Pipelines page's rows (docs/SDD-ui-cleanup.md §3.4). Same
      // static-sibling reasoning.
      if (url.pathname === "/board-pipelines.js" && req.method === "GET") {
        return new Response(Bun.file(new URL("board-pipelines.js", PUBLIC_DIR)));
      }

      // One board card per pipeline run, and the run drawer's step rows
      // (docs/SDD-ui-cleanup.md §4.1). Same static-sibling reasoning.
      if (url.pathname === "/board-runs.js" && req.method === "GET") {
        return new Response(Bun.file(new URL("board-runs.js", PUBLIC_DIR)));
      }

      // A run's graph with live step statuses (docs/SDD-ui-cleanup.md
      // §4.3). Same static-sibling reasoning.
      if (url.pathname === "/board-run-canvas.js" && req.method === "GET") {
        return new Response(Bun.file(new URL("board-run-canvas.js", PUBLIC_DIR)));
      }

      // The run drawer's Quick read and Listen tabs for an AI news run
      // (docs/SDD-ai-news-podcast.md §3.5). Same static-sibling reasoning.
      if (url.pathname === "/board-news.js" && req.method === "GET") {
        return new Response(Bun.file(new URL("board-news.js", PUBLIC_DIR)));
      }

      if (url.pathname === "/agents" && req.method === "GET") {
        return json(registry.all());
      }

      // The merge-health scheduler's last-checked result (see
      // src/core/merge-health-scheduler.ts) — [] whenever the scheduler
      // isn't running (mergeHealthEnabled off, or no tick has resolved
      // yet) or nothing's actually dangling. Detection + visibility
      // only: resolving a reported entry is always a human (or a
      // separate, later integrator) action, never something this
      // endpoint or the scheduler behind it does on its own.
      if (url.pathname === "/merge-health" && req.method === "GET") {
        return json(mergeHealthScheduler?.getLast() ?? []);
      }

      if (url.pathname === "/harnesses" && req.method === "GET") {
        // A cache-miss for a given harness id is not an error — it just
        // hasn't been refreshed yet (e.g. WISSEL_MODEL_REFRESH never
        // ran) — reported as [], same "empty, not broken" contract the
        // model-setting endpoint below relies on to decide whether it
        // has anything to validate against.
        const cache = await readModelsCache(modelsCachePath);
        return json(
          harnesses.all().map((h) => ({
            ...h,
            activeCount: harnesses.activeCount(h.id),
            availableModels: cache[h.id]?.models ?? [],
          })),
        );
      }

      // The board's account line: every enabled harness, its live load,
      // and the model each running task on it uses (see
      // src/core/account-status.ts). Pipeline definitions are only read
      // when a running step card needs one to name its agent.
      if (url.pathname === "/status/accounts" && req.method === "GET") {
        const running = await board.list({ status: "running" });
        const needsPipelines = running.some((t) => !t.routedTo && t.pipelineId);
        return json(
          buildAccountStatus({
            harnesses: harnesses.all(),
            tasks: running,
            agents: registry,
            activeCount: (id) => harnesses.activeCount(id),
            pipelines: needsPipelines ? await pipelines.list() : [],
          }),
        );
      }

      // Current curated memory — curation (gatherSessionLessons,
      // writeMemoryLessons) always runs regardless of injection; whether
      // it's actually folded into an agent's prompt is reported here as
      // `injected`, which mirrors createApp's own `injectMemory` flag
      // (see docs/SDD-memory-injection-toggle.md §3.4, off by default).
      // `content: undefined` (never an error) means curation hasn't
      // produced a file yet — the board UI's Memory tab shows that as an
      // empty state, not a fetch failure.
      if (url.pathname === "/memory" && req.method === "GET") {
        const content = await readMemoryLessons(opts.memoryPath ?? DEFAULT_MEMORY_PATH);
        return json({ content, path: opts.memoryPath ?? DEFAULT_MEMORY_PATH, injected: opts.injectMemory ?? false });
      }

      // Every past curation run, most recent first, each carrying the
      // exact content it wrote at the time — durable history the current
      // file alone can't show, since every run wholesale-replaces it
      // (see getMemoryCurationHistory's own doc comment).
      if (url.pathname === "/memory/history" && req.method === "GET") {
        if (!telemetry) return json([]);
        const events = await getMemoryCurationHistory(telemetry.filePath);
        const runs = await Promise.all(
          events.map(async (e) => {
            const result = await board.getResult(e.taskId);
            return { taskId: e.taskId, at: e.at, actualCost: e.actualCost, harnessId: e.harnessId, summary: result?.summary };
          }),
        );
        return json(runs);
      }

      if (parts[0] === "harnesses" && parts.length === 3) {
        const harness = harnesses.get(parts[1]!);
        if (!harness) return notFound();

        // A human's own decision always wins, but an enable is only
        // ever granted for real — re-runs the exact same tool-specific
        // auth check validateHarness does at startup (see
        // checkHarnessAuth) before flipping enabled: true, and refuses
        // with a clear reason instead of a harness that would just fail
        // the moment a task actually tries to use it. See
        // docs/SDD-harness-enable-disable.md §6.
        if (parts[2] === "enable" && req.method === "POST") {
          const { authenticated } = await checkHarnessAuth(harness, { runner: harnessRunner });
          if (!authenticated) {
            harnesses.setEnabled(harness.id, false, "not authenticated");
            return json({ error: "still not authenticated" }, 409);
          }
          await setHarnessEnabled(harnessesPath, harness, true);
          const enabled = harnesses.setEnabled(harness.id, true);
          // Tasks held because no harness for this tool was enabled (see
          // Orchestrator.process) only get re-checked on a sweep, and a
          // harness toggle isn't a board event, so trigger one here.
          if (opts.orchestratorEnabled) void orchestrator.sweep();
          return json(enabled);
        }

        if (parts[2] === "disable" && req.method === "POST") {
          await setHarnessEnabled(harnessesPath, harness, false);
          return json(harnesses.setEnabled(harness.id, false));
        }

        // Sets/clears this harness's default model (Harness.model, see
        // the precedence order documented beside CostProfile in
        // types.ts). `model: null`/omitted clears the override back to
        // the agent default. Refuses (400) a `model` that isn't in this
        // harness's own cached `availableModels` — same "refuse, don't
        // silently accept" discipline `/enable`'s 409 already applies,
        // but only when the cache actually has an opinion: an empty
        // `availableModels` (never refreshed yet) means there's nothing
        // to validate against, so any string is accepted rather than
        // rejecting everything until a refresh has run once.
        if (parts[2] === "model" && req.method === "POST") {
          const { model } = (await req.json()) as { model?: string | null };
          const resolved = model ?? undefined;
          if (resolved !== undefined) {
            const cache = await readModelsCache(modelsCachePath);
            const availableModels = cache[harness.id]?.models ?? [];
            if (availableModels.length > 0 && !availableModels.includes(resolved)) {
              return json({ error: `model "${resolved}" is not in the known model list for harness "${harness.id}"` }, 400);
            }
          }
          await setHarnessModel(harnessesPath, harness, resolved);
          return json(harnesses.setModel(harness.id, resolved));
        }
      }

      // MCP servers — the external tool surface an agent can reach once
      // it's running (Slack, a database, a ticketing system), orthogonal
      // to harnesses above (which account runs the CLI process). See
      // docs/SDD-mcp-orchestration.md §3.1/§6.
      if (url.pathname === "/mcp-servers" && req.method === "GET") {
        return json(mcpServers.all().map((s) => ({ ...s, activeCount: mcpServers.activeCount(s.id) })));
      }

      // Registers a brand-new MCP server live, through the board's "Add
      // MCP server" form — mirrors POST /projects/local's own
      // validate-then-persist shape (docs/SDD-mcp-server-registration.md
      // §3.1), not harnesses' hand-edit-the-YAML-and-restart precedent.
      // A malformed body or an unreachable transport both refuse to
      // persist anything (§3.2/§3.3); a duplicate id 400s rather than
      // silently overwriting (§3.4).
      if (url.pathname === "/mcp-servers" && req.method === "POST") {
        const body = await req.json();
        const parsed = parseMcpServerCreateInput(body);
        if ("error" in parsed) return json({ error: parsed.error }, 400);

        if (mcpServers.get(parsed.server.id)) {
          return json({ error: `mcp server id "${parsed.server.id}" is already registered` }, 400);
        }

        const { reachable, reason } = await checkMcpServerReachable(parsed.server, mcpServerReachabilityOpts);
        if (!reachable) {
          return json({ error: reason ?? "not reachable" }, 400);
        }

        await addMcpServer(mcpServersPath, parsed.server);
        return json(mcpServers.add(parsed.server), 201);
      }

      if (parts[0] === "mcp-servers" && parts.length === 3) {
        const server = mcpServers.get(parts[1]!);
        if (!server) return notFound();

        // Same "a human's enable is only ever granted for real"
        // discipline `/harnesses/:id/enable` already holds — re-runs the
        // reachability check before flipping enabled: true, refusing
        // with a clear reason instead of a server that would just fail
        // the moment a task actually tries to call it.
        if (parts[2] === "enable" && req.method === "POST") {
          const { reachable, reason } = await checkMcpServerReachable(server, mcpServerReachabilityOpts);
          if (!reachable) {
            mcpServers.setEnabled(server.id, false, reason ?? "not reachable");
            return json({ error: reason ?? "not reachable" }, 409);
          }
          await setMcpServerEnabled(mcpServersPath, server, true);
          return json(mcpServers.setEnabled(server.id, true));
        }

        if (parts[2] === "disable" && req.method === "POST") {
          await setMcpServerEnabled(mcpServersPath, server, false);
          return json(mcpServers.setEnabled(server.id, false));
        }
      }

      // Per-tool trust-tier edit (board's Manage MCP Servers panel) —
      // the one piece of McpServer.tools[].trust not covered by
      // enable/disable above. 404s on an unknown server OR an unknown
      // tool name on that server, same "both halves must resolve for
      // real" discipline /enable's reachability re-check holds; 400s on
      // a body that isn't one of the two real trust values rather than
      // silently persisting garbage.
      if (parts[0] === "mcp-servers" && parts.length === 5 && parts[2] === "tools" && parts[4] === "trust" && req.method === "POST") {
        const server = mcpServers.get(parts[1]!);
        if (!server) return notFound();
        const toolName = parts[3]!;
        if (!server.tools.some((t) => t.name === toolName)) return notFound();

        const { trust } = (await req.json()) as { trust?: string };
        if (trust !== "auto" && trust !== "approval-required") {
          return json({ error: `trust must be "auto" or "approval-required", got ${JSON.stringify(trust)}` }, 400);
        }

        await setMcpServerToolTrust(mcpServersPath, server, toolName, trust);
        return json(mcpServers.setToolTrust(server.id, toolName, trust));
      }

      if (url.pathname === "/events" && req.method === "GET") {
        return sseStream(board);
      }

      if (url.pathname === "/route/preview" && req.method === "POST") {
        const body = (await req.json()) as { labels?: string[]; parentTaskId?: string };
        const labels = Array.isArray(body.labels) ? body.labels : [];
        const allowIds = await resolveHandoffAllowlist(board as Board, registry, body.parentTaskId);
        const decision = await router.route({ id: "preview", title: "", body: "", labels, repo: "", status: "inbox" }, allowIds);
        return json(decision);
      }

      // The pipeline-editor bundle (pipeline-editor/, its own Vite build —
      // see docs/SDD-pipelines.md §3.2, mounted in the board shell since
      // docs/SDD-ui-cleanup.md §4.2) — checked before the `/pipelines`
      // API block below so a request for `/pipelines/edit` (or the old
      // `/pipelines/edit/<id>` page URL, now a redirect) is never
      // mistaken for `GET /pipelines/:id` treating "edit" as a pipeline id.
      if (url.pathname === "/pipelines/edit" || url.pathname.startsWith("/pipelines/edit/")) {
        if (req.method !== "GET") return notFound();
        return servePipelineEditorAsset(url.pathname, pipelineEditorDist);
      }

      if (parts[0] === "pipelines") {
        if (parts.length === 1 && req.method === "GET") {
          return json(await pipelines.list());
        }

        if (parts.length === 1 && req.method === "POST") {
          const body = (await req.json()) as { name?: string; description?: string; graph?: PipelineGraph };
          if (!body.name || !body.graph) return json({ error: "name and graph are required" }, 400);
          const created = await pipelines.create({ name: body.name, description: body.description ?? "", graph: body.graph });
          return json(created, 201);
        }

        if (parts.length === 2 && req.method === "GET") {
          const pipeline = await pipelines.get(parts[1]!);
          return pipeline ? json(pipeline) : notFound();
        }

        if (parts.length === 2 && req.method === "PUT") {
          const existing = await pipelines.get(parts[1]!);
          if (!existing) return notFound();
          const body = (await req.json()) as { name?: string; description?: string; graph?: PipelineGraph };
          if (!body.name || !body.graph) return json({ error: "name and graph are required" }, 400);
          const updated = await pipelines.update(parts[1]!, { name: body.name, description: body.description ?? "", graph: body.graph });
          return json(updated);
        }

        if (parts.length === 2 && req.method === "DELETE") {
          const existing = await pipelines.get(parts[1]!);
          if (!existing) return notFound();
          await pipelines.delete(parts[1]!);
          return new Response(null, { status: 204 });
        }

        // Runs a pipeline right now — creates the root task and drives
        // every step (recursively, via pipeline-runner.ts) to
        // settlement before responding, unlike POST /tasks/:id/run
        // (which returns immediately and lets the caller watch SSE
        // events). A pipeline run in this phase has no "dispatched,
        // check back later" state — see docs/SDD-pipelines.md §5.
        if (parts.length === 3 && parts[2] === "run" && req.method === "POST") {
          const pipeline = await pipelines.get(parts[1]!);
          if (!pipeline) return notFound();
          const body = (await req.json()) as { repo?: unknown; input?: unknown };
          if ((body.repo !== undefined && typeof body.repo !== "string") || (body.input !== undefined && typeof body.input !== "string")) {
            return json({ error: "repo and input must be strings" }, 400);
          }
          // A pipeline whose steps are all readonly with no write/bash
          // access runs with no repo (scratch workspace per step) and an
          // optional input, e.g. "AI news podcast"
          // (docs/SDD-ai-news-podcast.md §3.3/§3.4). Anything else still
          // needs both, and fails here, before a root card exists.
          const repoless = stepsNeedingRepo(pipeline, registry).length === 0;
          if (!repoless && (!body.repo || !body.input)) {
            const names = stepsNeedingRepo(pipeline, registry).map((s) => `"${s.name}" (${s.agentId})`).join(", ");
            return json({ error: `repo and input are required: this pipeline has steps with file/bash access: ${names}` }, 400);
          }
          let root: TaskCard;
          try {
            root = await startPipelineRun(board as Board, registry, pipeline, body.repo || undefined, body.input ?? "", {
              executors: manualExecutors,
              pipelines,
              harnesses,
              telemetry,
              memoryPath: opts.memoryPath,
            });
          } catch (e) {
            if (e instanceof PipelineRepoRequiredError) return json({ error: e.message }, 400);
            throw e;
          }
          return json(root, 201);
        }

        // Every root task with this pipelineId, most recent first —
        // mirrors GET /memory/history's own shape. Filters to root tasks
        // specifically (no parentTaskId) so a run's own step cards don't
        // show up as if each were a separate run.
        if (parts.length === 3 && parts[2] === "runs" && req.method === "GET") {
          const pipeline = await pipelines.get(parts[1]!);
          if (!pipeline) return notFound();
          const tasks = await board.list();
          const runs = tasks.filter((t) => t.pipelineId === parts[1] && t.parentTaskId === undefined).reverse();
          return json(runs);
        }
      }

      // One run's steps with agent, harness, model, status, duration and
      // cost, for the board's run drawer (docs/SDD-ui-cleanup.md §4.1).
      // Read-only. 404 for anything that isn't a run root, including a
      // step card's own id.
      if (parts[0] === "pipeline-runs" && parts.length === 2 && req.method === "GET") {
        const summary = await buildPipelineRunSummary(
          {
            board: board as Board,
            pipelines,
            registry,
            harnesses,
            readOutput: (taskId) => getTaskOutput(taskId, opts.taskOutputDir),
            audioBytes: (runId) => pipelineAudioBytes(audioDir, runId),
          },
          parts[1]!,
        );
        return summary ? json(summary) : notFound();
      }

      // The run's MP3 from its "Make audio" step (docs/SDD-ai-news-podcast.md
      // §3.7), with Range support so phones can seek. The id must look like
      // a task id and be a run root on the board before any path is built,
      // so nothing but a real run's own file can be read. 404 otherwise,
      // and when the run has no audio.
      if (parts[0] === "pipeline-runs" && parts.length === 3 && parts[2] === "audio" && (req.method === "GET" || req.method === "HEAD")) {
        const runId = parts[1]!;
        if (!isSafeRunId(runId)) return notFound();
        const root = await board.get(runId);
        if (!root || !root.pipelineId || root.pipelineRunId) return notFound();
        return await pipelineAudioResponse(audioDir, root.id, req);
      }

      if (parts[0] === "projects") {
        if (parts.length === 1 && req.method === "GET") {
          return json(await projects.list());
        }

        if (parts.length === 2 && parts[1] === "local" && req.method === "POST") {
          const body = (await req.json()) as { path?: string; initGit?: boolean };
          if (!body.path || !body.path.trim()) return json({ error: "path is required" }, 400);
          const result = await projects.addLocalProject(body.path, { initGit: body.initGit }, commandRunner);
          if ("error" in result) return json({ error: result.error }, 400);
          return json(result.project, 201);
        }

        // Distinguishes a genuinely fresh clone (201) from the
        // already-cloned-here case (200 + alreadyExists: true) by status
        // code alone, so a client can branch on it without string-matching
        // a message — see SqliteProjectStore.addGithubProject's own
        // idempotent-by-sourceUrl behavior.
        if (parts.length === 2 && parts[1] === "clone" && req.method === "POST") {
          const body = (await req.json()) as { url?: string; name?: string };
          if (!body.url || !body.url.trim()) return json({ error: "url is required" }, 400);
          const result = await projects.addGithubProject(body.url, { name: body.name }, commandRunner);
          if ("error" in result) return json({ error: result.error }, 400);
          if (result.alreadyExists) return json({ project: result.project, alreadyExists: true }, 200);
          return json(result.project, 201);
        }

        // Unregisters the row only — never touches the filesystem, matching
        // ProjectStore.delete's own contract (see its doc comment).
        if (parts.length === 2 && req.method === "DELETE") {
          const existing = (await projects.list()).find((p) => p.id === parts[1]);
          if (!existing) return notFound();
          await projects.delete(parts[1]!);
          return new Response(null, { status: 204 });
        }

        // Real, deterministic git state — no LLM involved (see
        // src/services/project-status.ts's own doc comment). Recomputed
        // fresh on every call, unlike eli5 below: this is cheap local
        // git, not a paid API call, so there's nothing worth caching.
        if (parts.length === 3 && parts[2] === "status" && req.method === "GET") {
          const project = (await projects.list()).find((p) => p.id === parts[1]);
          if (!project) return notFound();
          const status = await getProjectGitStatus(project.path, commandRunner);
          if ("error" in status) return json({ error: status.error }, 400);
          return json(status);
        }

        // Lazily generates and caches a one-paragraph ELI5 summary
        // (src/services/project-eli5.ts) — the one part of this feature
        // that's a real LLM call, so it only ever runs once per project
        // and is reused after that. `?refresh=1` forces regeneration
        // (e.g. after the repo's README changed); otherwise a cached
        // summary is returned as-is, cost-free.
        if (parts.length === 3 && parts[2] === "eli5" && req.method === "GET") {
          const project = (await projects.list()).find((p) => p.id === parts[1]);
          if (!project) return notFound();
          const forceRefresh = url.searchParams.get("refresh") === "1";
          if (project.eli5 && !forceRefresh) {
            return json({ eli5: project.eli5, eli5UpdatedAt: project.eli5UpdatedAt, cached: true });
          }
          const generated = await generateProjectEli5(project.path, project.name, { clientFactory: projectEli5ClientFactory });
          if ("error" in generated) return json({ error: generated.error }, 502);
          const updated = await projects.setEli5(project.id, generated.eli5);
          return json({ eli5: updated.eli5, eli5UpdatedAt: updated.eli5UpdatedAt, cached: false });
        }
      }

      if (parts[0] === "tasks") {
        if (parts.length === 1 && req.method === "GET") {
          const status = url.searchParams.get("status") as TaskCard["status"] | null;
          const repo = url.searchParams.get("repo");
          const tasks = await board.list({
            ...(status ? { status } : {}),
            ...(repo ? { repo } : {}),
          });
          return json(tasks);
        }

        if (parts.length === 1 && req.method === "POST") {
          const body = (await req.json()) as Omit<TaskCard, "id" | "status">;
          // `harnessOverride` is validated eagerly, at creation time,
          // because we already know exactly which harness it names.
          // `model` with no `harnessOverride` is deliberately NOT
          // validated here — which harness/tool will actually run this
          // task isn't known until routing happens, so there's nothing
          // yet to check it against (see docs/SDD-model-selection.md §9,
          // and the fail-loud precedence resolution in
          // src/core/model-resolution.ts, which validates it for real at
          // dispatch time).
          if (body.harnessOverride) {
            const harness = harnesses.get(body.harnessOverride);
            if (!harness) return json({ error: `unknown harnessOverride "${body.harnessOverride}"` }, 400);
            if (body.model) {
              const cache = await readModelsCache(modelsCachePath);
              const availableModels = cache[harness.id]?.models ?? [];
              if (availableModels.length > 0 && !availableModels.includes(body.model)) {
                return json({ error: `model "${body.model}" is not in the known model list for harness "${harness.id}"` }, 400);
              }
            }
          }
          // `repo` is required only for a task that will route to a
          // write- or bash-capable agent — a readonly, no-file-access
          // agent (e.g. "check Jira, post to Slack") never touches a
          // filesystem, so forcing a repo on it would just be a directory
          // name nothing ever reads (see TaskCard.repo's own doc
          // comment). Resolved synchronously here, the same way
          // `/route/preview` already resolves a routing decision with no
          // side effects — routing itself normally happens later, inside
          // `sweep()`, but a confident resolution here lets a bad
          // no-repo submission 400 immediately instead of silently
          // stalling once sweep() actually routes it. A task that
          // doesn't resolve confidently yet (ambiguous/no-match labels)
          // is allowed through without a repo — see Orchestrator.process's
          // own write/bash-access check for the dispatch-time safety net
          // that covers this case if it's later routed to a write-tier
          // agent by a label edit.
          if (!body.repo) {
            const allowIds = await resolveHandoffAllowlist(board as Board, registry, body.parentTaskId);
            const previewTask: TaskCard = {
              id: "repo-check",
              title: body.title ?? "",
              body: body.body ?? "",
              labels: body.labels ?? [],
              status: "inbox",
            };
            const decision = await router.route(previewTask, allowIds);
            const agent = decision.confident && decision.selected ? registry.get(decision.selected) : undefined;
            if (agent && (agent.toolAccess.includes("write") || agent.toolAccess.includes("bash"))) {
              return json({ error: `repo is required — this task would route to "${agent.id}", which has file/bash access` }, 400);
            }
          }
          const task = await board.create(body);
          return json(task, 201);
        }

        if (parts.length === 2 && req.method === "GET") {
          const task = await board.get(parts[1]!);
          return task ? json(task) : notFound();
        }

        if (parts.length === 3 && parts[2] === "move" && req.method === "POST") {
          const { status } = (await req.json()) as { status: TaskCard["status"] };
          const task = await board.move(parts[1]!, status);
          return json(task);
        }

        if (parts.length === 3 && parts[2] === "depends-on" && req.method === "POST") {
          const { dependsOn } = (await req.json()) as { dependsOn: string[] };
          const task = await board.setDependencies(parts[1]!, dependsOn);
          return json(task);
        }

        if (parts.length === 3 && parts[2] === "decision" && req.method === "POST") {
          const body = (await req.json()) as Omit<RoutingDecision, "taskId">;
          await board.recordDecision({ ...body, taskId: parts[1]! });
          return new Response(null, { status: 204 });
        }

        if (parts.length === 3 && parts[2] === "decision" && req.method === "GET") {
          const decision = await board.getDecision(parts[1]!);
          return decision ? json(decision) : notFound();
        }

        if (parts.length === 3 && parts[2] === "result" && req.method === "POST") {
          const body = (await req.json()) as Omit<TaskResult, "taskId">;
          // memoryPath explicitly threaded through — found live the hard
          // way: without it, finishResult's own default (DEFAULT_MEMORY_PATH)
          // silently wins over whatever this app was configured with,
          // meaning any caller of this endpoint (including a fixture
          // server) writes memory-curator results into the real project's
          // memory/lessons.md regardless of opts.memoryPath.
          await finishResult(board as Board, registry, { ...body, taskId: parts[1]! }, telemetry, runViaBun, opts.memoryPath ?? DEFAULT_MEMORY_PATH);
          return new Response(null, { status: 204 });
        }

        if (parts.length === 3 && parts[2] === "result" && req.method === "GET") {
          const result = await board.getResult(parts[1]!);
          return result ? json(result) : notFound();
        }

        if (parts.length === 3 && parts[2] === "diff" && req.method === "GET") {
          const task = await board.get(parts[1]!);
          if (!task) return notFound();
          // A worktree-run task's changes live in its worktree, not
          // task.repo — getRepoDiff needs no changes of its own to
          // handle that: a worktree is a plain git working tree with
          // uncommitted edits, same shape it already reads for task.repo.
          const result = await board.getResult(parts[1]!);
          const diffPath = result?.worktree?.path ?? task.repo;
          // A readonly task with no repo (see TaskCard.repo's own doc
          // comment) never touches a filesystem at all — there's nothing
          // to diff, not just an empty one.
          if (!diffPath) return json({ error: "task has no filesystem workspace to diff" }, 409);
          return json(await getRepoDiff(diffPath));
        }

        if (parts.length === 3 && parts[2] === "mcp-calls" && req.method === "GET") {
          const task = await board.get(parts[1]!);
          if (!task) return notFound();
          const result = await board.getResult(parts[1]!);
          return json(result?.mcpCalls ?? []);
        }

        // Point-in-time snapshot of a task's raw agent output — every
        // JSONL line recorded so far, from the durable file (not the
        // capped in-memory ring buffer — see getTaskOutput's own doc
        // comment), oldest first. Useful for a task that already
        // finished, or a client that just wants to load-then-poll. See
        // docs/SDD-live-task-output.md §3.4.
        if (parts.length === 3 && parts[2] === "output" && req.method === "GET") {
          const task = await board.get(parts[1]!);
          if (!task) return notFound();
          const lines = await getTaskOutput(parts[1]!, opts.taskOutputDir);
          return json({ taskId: parts[1]!, lines });
        }

        // Live tail of a task's raw agent output — SSE, scoped
        // server-side to this one taskId (unlike /events' single global
        // board stream), mirroring sseStream's own shape below. Sends
        // the current ring-buffer backlog immediately on connect (so a
        // client never opens to a blank pane), then forwards every new
        // line as appendTaskOutput records it. Sends `event: done` and
        // closes once the task's own TaskResult lands (board.recordResult's
        // "task.result" BoardEvent) — the clean, board-level signal that
        // nothing more will ever be appended, rather than guessing from
        // the raw JSONL content itself. See docs/SDD-live-task-output.md §3.4.
        if (parts.length === 4 && parts[2] === "output" && parts[3] === "stream" && req.method === "GET") {
          const task = await board.get(parts[1]!);
          if (!task) return notFound();
          return taskOutputStream(parts[1]!, board);
        }

        // The board UI's "Run" button — an explicit, per-task human
        // decision to execute right now, distinct from the automatic
        // loop's blanket executeWriteTier gate (see Orchestrator.runNow).
        // Fires the run and returns immediately; the actual routing/
        // execution surfaces through the normal SSE task events, not
        // this response.
        if (parts.length === 3 && parts[2] === "run" && req.method === "POST") {
          try {
            await orchestrator.runNow(parts[1]!, manualExecutors);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return json({ error: message }, message.startsWith("task not found") ? 404 : 409);
          }
          return new Response(null, { status: 202 });
        }

        // The board UI's "Merge" action for a worktree-run task —
        // commits whatever's in the worktree (if anything), merges its
        // branch into whatever's checked out in task.repo, removes the
        // worktree, and moves the task to "done". The only place a
        // worktree's changes ever reach the live repo; never automatic.
        if (parts.length === 3 && parts[2] === "merge" && req.method === "POST") {
          const task = await board.get(parts[1]!);
          if (!task) return notFound();
          const result = await board.getResult(parts[1]!);
          if (!result?.worktree) return json({ error: "task has no worktree to merge" }, 409);
          // A worktree only ever exists for a write-tier run, which
          // requires `repo` at creation time (see POST /tasks) — never
          // reachable for a repo-less readonly task.
          const merge = await mergeTaskWorktree(task.repo!, result.worktree, task, runViaBun);
          if (!merge.ok) return json({ error: merge.message }, 409);
          const moved = await board.move(task.id, "done");
          return json({ merged: true, message: merge.message, task: moved });
        }

        // The board UI's "Discard" action for a worktree-run task —
        // removes the worktree and its branch without merging anything,
        // and moves the task to "failed" (closest existing status for
        // "reviewed, rejected").
        if (parts.length === 3 && parts[2] === "discard" && req.method === "POST") {
          const task = await board.get(parts[1]!);
          if (!task) return notFound();
          const result = await board.getResult(parts[1]!);
          if (!result?.worktree) return json({ error: "task has no worktree to discard" }, 409);
          // Same reasoning as the merge branch above — a worktree
          // implies this was a write-tier run, which guarantees `repo`.
          await removeTaskWorktree(task.repo!, result.worktree, runViaBun);
          const moved = await board.move(task.id, "failed");
          return json({ discarded: true, task: moved });
        }

        if (parts.length === 3 && parts[2] === "override" && req.method === "POST") {
          const { routerPick, humanPick } = (await req.json()) as { routerPick: string; humanPick: string };
          await board.recordOverride(parts[1]!, routerPick, humanPick);
          return new Response(null, { status: 204 });
        }

        // Human resolution actions for a task sitting in `escalated` —
        // the reviewer/implementer loop gave up on it (pushbackCount hit
        // its limit, see orchestrator.ts's handleReviewVerdict), so
        // these are the only ways it moves again. All three 400 when the
        // task isn't actually `escalated` — a stale board view must
        // never let a second click silently redo (or race) a resolution
        // that already happened.
        if (parts.length === 4 && parts[2] === "escalation") {
          const task = await board.get(parts[1]!);
          if (!task) return notFound();

          // The actual override: forces the task to `review` despite
          // whatever unresolved reviewer objections got it escalated in
          // the first place. Recorded through the same audit trail as a
          // router override (see board.recordOverride/task.override
          // BoardEvent), now carrying who did it and why — an escalation
          // exists precisely because the automated loop couldn't resolve
          // it safely, so the human decision that overrides it has to be
          // attributable, not just a bare status flip.
          if (parts[3] === "approve" && req.method === "POST") {
            if (task.status !== "escalated") return json({ error: "task is not escalated" }, 400);
            const { actor, reason } = (await req.json()) as { actor?: string; reason?: string };
            if (!actor || !reason) return json({ error: "actor and reason are required" }, 400);
            await board.recordOverride(task.id, "escalated", "review", actor, reason);
            const moved = await board.move(task.id, "review");
            return json(moved);
          }

          // Gives up on the task outright — closest existing status for
          // "a human looked at it and it's not worth pursuing," same
          // terminal state a discarded worktree lands on.
          if (parts[3] === "abandon" && req.method === "POST") {
            if (task.status !== "escalated") return json({ error: "task is not escalated" }, 400);
            const moved = await board.move(task.id, "failed");
            return json(moved);
          }

          // Human-edited instructions start a brand-new lineage —
          // pushbackCount back to 0 and a fresh reviewLineageId (never
          // the escalated task's own id/lineage, which is exactly the
          // exhausted one that got it here) so this reads as an explicit
          // restart, not a silent continuation of a chain that already
          // proved it couldn't converge. Mirrors spawnPushbackImplementer
          // (orchestrator.ts): new TaskCard, old one marked
          // `supersededBy` with its own status left untouched (see
          // TaskCard.supersededBy) rather than repurposed as a failure.
          if (parts[3] === "retry" && req.method === "POST") {
            if (task.status !== "escalated") return json({ error: "task is not escalated" }, 400);
            const { body } = (await req.json()) as { body?: string };
            if (!body) return json({ error: "body is required" }, 400);
            const nextAttempt = await board.create({
              title: task.title,
              body,
              labels: task.labels,
              repo: task.repo,
              pushbackCount: 0,
              reviewLineageId: randomUUID(),
            });
            await board.setSupersededBy(task.id, nextAttempt.id);
            return json(nextAttempt, 201);
          }
        }

        // Human resolution actions for a task sitting in `review` with a
        // `pendingMcpApproval` (docs/SDD-mcp-orchestration.md §3.5/§6) —
        // the agent described a blocked tool call and a human has to say
        // yes or no before anything actually calls it. Mirrors the
        // escalation endpoints' own shape immediately above: 400 when the
        // task isn't actually in this exact state, so a stale board view
        // can't double-fire a resolution that already happened.
        if (parts.length === 4 && parts[2] === "mcp-approval") {
          const task = await board.get(parts[1]!);
          if (!task) return notFound();

          // Creates a brand-new, narrow follow-up task — never a
          // resumption of the original session, per §3.5's own stated
          // v1 limitation — scoped via `mcpAccessOverride` to EXACTLY
          // the one approved server+tool (see TaskCard.mcpAccessOverride's
          // own doc comment for why this is a task-level override rather
          // than a literal `mcpAccess` field, which only AgentDef has).
          // `labels`/`repo` carried over from the original give the
          // follow-up the same routing chance the original task had;
          // `parentTaskId` is deliberately NOT set here — doing so would
          // restrict the follow-up's routing candidates to the original
          // routed agent's own declared `handoffs` (see
          // resolveHandoffAllowlist), which this follow-up has no reason
          // to be bound by. `setSupersededBy` is the grouping link
          // instead (mirrors `/escalation/retry`'s identical choice
          // immediately above) — it's UI-visible but never read by
          // routing.
          if (parts[3] === "approve" && req.method === "POST") {
            if (task.status !== "review" || !task.pendingMcpApproval) return json({ error: "task has no pending MCP approval request" }, 400);
            const request = task.pendingMcpApproval;
            const followUp = await board.create({
              title: `Approved MCP call: ${request.server}/${request.tool}`,
              body:
                `A human approved exactly one MCP tool call. Make exactly this one call, then end your turn — do not take any other action.\n\n` +
                `Server: ${request.server}\nTool: ${request.tool}\nArguments: ${JSON.stringify(request.args)}\n\n` +
                `Reason originally given for this call: ${request.reason}`,
              labels: task.labels,
              repo: task.repo,
              mcpAccessOverride: [{ server: request.server, tools: [request.tool] }],
            });
            await board.setSupersededBy(task.id, followUp.id);
            await board.move(task.id, "done");
            return json(followUp, 201);
          }

          // Denied: no follow-up, ever. Lands on `failed` rather than
          // `done` — same reasoning as escalation's own `abandon` action
          // above: the one thing this task was waiting to do got
          // rejected, so it didn't accomplish what it was asked to do.
          if (parts[3] === "deny" && req.method === "POST") {
            if (task.status !== "review" || !task.pendingMcpApproval) return json({ error: "task has no pending MCP approval request" }, 400);
            const moved = await board.move(task.id, "failed");
            return json(moved);
          }
        }

        // Manual archive — any task, any status (docs/SDD-task-archiving.md
        // §3.5). Cascades to id's own subtree (not necessarily the whole
        // lineage root's tree — see Board.archive) and returns every card
        // actually touched, so the board UI can update all of them at
        // once instead of waiting on the SSE refetch alone.
        if (parts.length === 3 && parts[2] === "archive" && req.method === "POST") {
          const archived = await board.archive(parts[1]!);
          return json(archived);
        }

        // Never cascades — restores exactly one card (§3.6).
        if (parts.length === 3 && parts[2] === "unarchive" && req.method === "POST") {
          const task = await board.unarchive(parts[1]!);
          return json(task);
        }

        if (parts.length === 2 && req.method === "DELETE") {
          await board.delete(parts[1]!);
          return new Response(null, { status: 204 });
        }
      }

      return notFound();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.startsWith("task not found") ? 404 : 400;
      return json({ error: message }, status);
    }
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function notFound(): Response {
  return new Response("not found", { status: 404 });
}

/**
 * SSE stream of one task's raw agent output — see the
 * `GET /tasks/:id/output/stream` route's own doc comment for the full
 * contract. `board` is passed in (rather than read from a module-level
 * singleton) so tests can drive it against a fixture board's own event
 * emitter, the same way sseStream already takes `board` as a parameter.
 */
function taskOutputStream(taskId: string, board: { events?: import("node:events").EventEmitter }): Response {
  const encoder = new TextEncoder();
  const chunkEvent = `chunk:${taskId}`;
  let chunkListener: ((line: string) => void) | undefined;
  let resultListener: ((event: BoardEvent) => void) | undefined;

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(": connected\n\n"));
      // Backlog first, then subscribe — both happen synchronously with
      // no `await` between them, so there's no window for a chunk to
      // land in neither (or both) of the backlog snapshot and the live
      // listener below.
      for (const line of getBufferedOutput(taskId)) {
        controller.enqueue(encoder.encode(`data: ${line}\n\n`));
      }
      chunkListener = (line: string) => {
        controller.enqueue(encoder.encode(`data: ${line}\n\n`));
      };
      TASK_OUTPUT_EVENTS.on(chunkEvent, chunkListener);

      resultListener = (event: BoardEvent) => {
        if (event.type !== "task.result" || event.result.taskId !== taskId) return;
        controller.enqueue(encoder.encode("event: done\ndata: {}\n\n"));
        // Unsubscribe explicitly before closing — controller.close()
        // (producer-initiated) never fires the stream's own cancel()
        // callback (that's only for consumer-initiated cancellation), so
        // without this both listeners would stay registered forever.
        cleanup();
        controller.close();
      };
      board.events?.on("event", resultListener);
    },
    cancel() {
      cleanup();
    },
  });

  function cleanup(): void {
    if (chunkListener) {
      TASK_OUTPUT_EVENTS.off(chunkEvent, chunkListener);
      chunkListener = undefined;
    }
    if (resultListener) {
      board.events?.off("event", resultListener);
      resultListener = undefined;
    }
  }

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

/** The bundle board.html imports to mount the editor inside its shell
 *  (docs/SDD-ui-cleanup.md §4.2). A fixed name, not Vite's hashed one,
 *  so the board can import it without reading a manifest — see
 *  pipeline-editor/vite.config.ts. */
export const PIPELINE_EDITOR_ENTRY = "pipeline-editor.js";

/** Where an old standalone-editor URL lives now, or null if `sub` (the
 *  path after `/pipelines/edit/`) looks like an asset. `/pipelines/edit`
 *  is the board's `#/pipelines/new`; `/pipelines/edit/<id>` is
 *  `#/pipelines/edit/<id>`. `<id>` is passed through still URL-encoded,
 *  and the board decodes it. */
function pipelineEditorRedirect(sub: string): string | null {
  const seg = sub.replace(/\/+$/, "");
  if (!seg) return "/board#/pipelines/new";
  if (seg.includes("/") || /\.[a-z0-9]+$/i.test(seg)) return null;
  return `/board#/pipelines/edit/${seg}`;
}

/** Serves pipeline-editor's built output for any `/pipelines/edit*`
 *  request. A real on-disk file under `distDir` (the entry bundle, a
 *  chunk, the standalone index.html) is served as-is. Since card B2 the
 *  editor runs inside the board shell, so the old page URLs
 *  (`/pipelines/edit`, `/pipelines/edit/<pipeline-id>`) redirect to the
 *  board's hash routes instead of serving an SPA entry point. A missing
 *  asset is 503 while the editor isn't built at all, else 404. Guards
 *  against a `..`-laden path escaping `distDir` the same way any static
 *  file server has to. */
export async function servePipelineEditorAsset(pathname: string, distDir: URL): Promise<Response> {
  const sub = pathname.slice("/pipelines/edit".length).replace(/^\/+/, "");
  const candidate = sub ? new URL(sub, distDir) : distDir;
  if (!candidate.pathname.startsWith(distDir.pathname)) return notFound();

  if (sub) {
    const file = Bun.file(candidate);
    // The entry's name never changes between builds, so the browser
    // must revalidate it or a rebuild stays invisible until a hard reload.
    if (await file.exists()) return new Response(file, sub === PIPELINE_EDITOR_ENTRY ? { headers: { "cache-control": "no-cache" } } : undefined);
  }

  const redirect = pipelineEditorRedirect(sub);
  if (redirect) return new Response(null, { status: 302, headers: { location: redirect } });

  if (!(await Bun.file(new URL(PIPELINE_EDITOR_ENTRY, distDir)).exists())) {
    return new Response("pipeline-editor not built — run `bun install && bun run build` inside pipeline-editor/", { status: 503 });
  }
  return notFound();
}

function sseStream(board: { events?: import("node:events").EventEmitter }): Response {
  const encoder = new TextEncoder();
  let listener: ((event: BoardEvent) => void) | undefined;

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(": connected\n\n"));
      listener = (event: BoardEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      board.events?.on("event", listener);
    },
    cancel() {
      if (listener) board.events?.off("event", listener);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

if (import.meta.main) {
  // First thing, before anything can spawn: SIGTERM/SIGINT stop every
  // agent subprocess this server started, then exit. Without this a
  // restart left `claude -p` running in its worktree while the next
  // start's crash recovery dispatched a second session into the same
  // one — see src/executors/child-processes.ts and
  // docs/SDD-crash-recovery.md §10.
  installShutdownHandlers();
  const port = Number(process.env.WISSEL_PORT ?? 8787);
  const dbPath = process.env.WISSEL_DB_PATH ?? join(homedir(), ".wissel", "board.sqlite");
  const telemetryPath = process.env.WISSEL_TELEMETRY_PATH ?? join(homedir(), ".wissel", "telemetry.jsonl");
  const board = new SqliteBoard(dbPath);
  const registry = await Registry.load();
  const telemetry = new TelemetryLog(telemetryPath);
  // Same "harnesses.yaml" relative-path default HarnessPool.load()/
  // autoload() always had — this override is new (see
  // docs/SDD-model-selection.md), needed so a test/e2e run can point
  // the whole harness manifest (both the initial autoload read below
  // AND every enable/disable/model-set persist through createApp) at a
  // disposable fixture file instead of this repo's own real,
  // git-committed harnesses.yaml.
  const harnessesPath = process.env.WISSEL_HARNESSES_PATH ?? "harnesses.yaml";
  // Auto-detects every already-authenticated account on this machine
  // (see harness-discovery.ts) and layers harnessesPath on top as
  // overrides — the file is optional either way; zero configured or
  // detected harnesses is a valid, common state, not a startup error.
  const harnesses = await HarnessPool.autoload(harnessesPath);

  // Same relative-path default/override convention as harnessesPath
  // above. Unlike harnesses, there's no auto-discovery concept for MCP
  // servers (no "already-authenticated local account" to probe for) —
  // a missing file is just an empty registry, mirroring
  // HarnessPool.autoload()'s own "missing manifest is a valid starting
  // point" tolerance for its own manual-entries layer.
  const mcpServersPath = process.env.WISSEL_MCP_SERVERS_PATH ?? "mcp-servers.yaml";
  const mcpServers = await McpServerPool.load(mcpServersPath).catch(() => McpServerPool.from([]));

  // Off by default: this loop routes eligible tasks automatically the
  // moment they appear. Read-only agents run in-process; write-tier
  // agents are only decided and handed off (unless executeWriteTier is
  // also on) — nothing here spawns or supervises execution beyond that,
  // so the blast radius is "an agent gets picked without a human
  // clicking route," not "unattended code changes." The board's manual
  // "Run" button works either way — see createApp's manualExecutors.
  const orchestratorEnabled = ["1", "true"].includes(process.env.WISSEL_ORCHESTRATOR ?? "");
  const executeWriteTier = ["1", "true"].includes(process.env.WISSEL_EXECUTE_WRITE_TIER ?? "");
  // Undefined (unlimited) unless explicitly set — see
  // Orchestrator.sweep's own doc comments for what each guards against.
  // Only meaningful once orchestratorEnabled is also on.
  const maxConcurrentTasks = process.env.WISSEL_MAX_CONCURRENT_TASKS ? Number(process.env.WISSEL_MAX_CONCURRENT_TASKS) : undefined;
  const spendCeilingUsd = process.env.WISSEL_SWEEP_SPEND_CEILING_USD ? Number(process.env.WISSEL_SWEEP_SPEND_CEILING_USD) : undefined;

  // Off by default: wissel learning from its own session history (see
  // docs/SDD-memory-curator.md). WISSEL_MEMORY_INTERVAL_HOURS only
  // matters once this is on.
  const memoryCurationEnabled = ["1", "true"].includes(process.env.WISSEL_MEMORY_CURATION ?? "");
  const memoryIntervalHours = process.env.WISSEL_MEMORY_INTERVAL_HOURS ? Number(process.env.WISSEL_MEMORY_INTERVAL_HOURS) : 24;
  // Undefined (falls back to DEFAULT_MEMORY_PATH, "memory/lessons.md"
  // relative to cwd) unless overridden — exists specifically so a test
  // fixture (see playwright.config.ts) can point this somewhere
  // disposable instead of writing into the real project file. Confirmed
  // live the hard way: an e2e run with this unset overwrote this
  // project's own real, git-committed memory/lessons.md with test
  // fixture content.
  const memoryPath = process.env.WISSEL_MEMORY_PATH;
  // Off by default: whether memoryPath's content is folded into every
  // claude-cli/codex-cli agent prompt (see
  // docs/SDD-memory-injection-toggle.md). Memory curation above keeps
  // running either way — this only gates whether agents actually see
  // the result.
  const injectMemory = ["1", "true"].includes(process.env.WISSEL_MEMORY_INJECTION ?? "");

  // Off by default: task cards auto-archiving 24h after they land on
  // `done` (see docs/SDD-task-archiving.md). WISSEL_ARCHIVE_CHECK_INTERVAL_HOURS
  // only matters once this is on — the 24h threshold itself is fixed,
  // not configurable (§3.3).
  const autoArchiveEnabled = ["1", "true"].includes(process.env.WISSEL_AUTO_ARCHIVE ?? "");
  const archiveCheckIntervalHours = process.env.WISSEL_ARCHIVE_CHECK_INTERVAL_HOURS ? Number(process.env.WISSEL_ARCHIVE_CHECK_INTERVAL_HOURS) : 1;

  // Off by default: the model catalog (which model ids are valid to pick
  // per harness) refreshing itself daily into ~/.wissel/models-cache.json
  // (see docs/SDD-model-selection.md §8). WISSEL_MODEL_REFRESH_INTERVAL_HOURS
  // and WISSEL_MODELS_CACHE_PATH only matter once this is on.
  const modelRefreshEnabled = ["1", "true"].includes(process.env.WISSEL_MODEL_REFRESH ?? "");
  const modelRefreshIntervalHours = process.env.WISSEL_MODEL_REFRESH_INTERVAL_HOURS ? Number(process.env.WISSEL_MODEL_REFRESH_INTERVAL_HOURS) : 24;
  const modelsCachePath = process.env.WISSEL_MODELS_CACHE_PATH;

  // Off by default: detecting repos left mid-merge (a dangling
  // `.git/MERGE_HEAD`) and surfacing them on the board — never
  // auto-resolving them (see docs/SDD-crash-recovery.md §3.2/§4).
  // WISSEL_MERGE_HEALTH_INTERVAL_HOURS only matters once this is on;
  // default matches archive-scheduler's own default (1h).
  const mergeHealthEnabled = ["1", "true"].includes(process.env.WISSEL_MERGE_HEALTH ?? "");
  const mergeHealthIntervalHours = process.env.WISSEL_MERGE_HEALTH_INTERVAL_HOURS ? Number(process.env.WISSEL_MERGE_HEALTH_INTERVAL_HOURS) : 1;

  // The "Make audio" pipeline step's local Kokoro service and where its
  // MP3s go (docs/SDD-ai-news-podcast.md §3.7). Unset means TtsExecutor's
  // defaults: http://127.0.0.1:8880, voice af_heart, ~/.wissel/audio.
  const tts = { url: process.env.WISSEL_TTS_URL || undefined, voice: process.env.WISSEL_TTS_VOICE || undefined };
  const audioDir = process.env.WISSEL_AUDIO_DIR || undefined;

  Bun.serve({
    port,
    fetch: createApp(board, registry, telemetry, {
      orchestratorEnabled,
      executeWriteTier,
      harnesses,
      harnessesPath,
      mcpServers,
      mcpServersPath,
      maxConcurrentTasks,
      spendCeilingUsd,
      memoryCurationEnabled,
      memoryIntervalHours,
      memoryPath,
      injectMemory,
      autoArchiveEnabled,
      archiveCheckIntervalHours,
      modelRefreshEnabled,
      modelRefreshIntervalHours,
      modelsCachePath,
      mergeHealthEnabled,
      mergeHealthIntervalHours,
      tts,
      audioDir,
    }),
  });
  console.log(`wissel board api on :${port} (db: ${dbPath})`);
  const v = getVersionInfo();
  console.log(`version: ${v.commitShort}${v.dirty ? "+dirty" : ""} (${v.branch})`);
  console.log(
    orchestratorEnabled
      ? `wissel orchestrator running${executeWriteTier ? " — executing write-tier work locally, no agetor handoff" : ""}`
      : "wissel orchestrator not started — set WISSEL_ORCHESTRATOR=1 to route tasks automatically",
  );
  console.log(
    harnesses.all().length
      ? `harnesses: ${harnesses.all().map((h) => (h.enabled ? h.id : `${h.id} (disabled: not authenticated here)`)).join(", ")}`
      : "no harnesses.yaml found — running with no named harness (ambient environment only)",
  );
  console.log(
    mcpServers.all().length
      ? `mcp servers: ${mcpServers.all().map((s) => (s.enabled ? s.id : `${s.id} (disabled${s.disabledReason ? `: ${s.disabledReason}` : ""})`)).join(", ")}`
      : "no mcp-servers.yaml found — running with no MCP servers registered",
  );
  console.log(
    memoryCurationEnabled
      ? `memory curation scheduled every ${memoryIntervalHours}h (WISSEL_MEMORY_CURATION=1)`
      : "memory curation not started — set WISSEL_MEMORY_CURATION=1 to let wissel learn from its own session history",
  );
  console.log(
    injectMemory
      ? "memory injection on: lessons are folded into every agent prompt (WISSEL_MEMORY_INJECTION=1)"
      : "memory injection off: lessons are curated but not added to agent prompts (set WISSEL_MEMORY_INJECTION=1 to re-enable)",
  );
  console.log(
    autoArchiveEnabled
      ? `auto-archive checking every ${archiveCheckIntervalHours}h for done tasks 24h+ past doneAt (WISSEL_AUTO_ARCHIVE=1)`
      : "auto-archive not started — set WISSEL_AUTO_ARCHIVE=1 to archive done tasks automatically after 24h",
  );
  console.log(
    modelRefreshEnabled
      ? `model catalog refreshing every ${modelRefreshIntervalHours}h into ${modelsCachePath ?? join(homedir(), ".wissel", "models-cache.json")} (WISSEL_MODEL_REFRESH=1)`
      : "model catalog refresh not started — set WISSEL_MODEL_REFRESH=1 to refresh known model lists daily",
  );
  console.log(
    mergeHealthEnabled
      ? `merge-health checking every ${mergeHealthIntervalHours}h for repos left mid-merge (WISSEL_MERGE_HEALTH=1)`
      : "merge-health checking not started — set WISSEL_MERGE_HEALTH=1 to surface repos left mid-merge on the board",
  );
  console.log(
    `pipeline audio: Kokoro TTS at ${tts.url ?? DEFAULT_TTS_URL} (voice ${tts.voice ?? DEFAULT_TTS_VOICE}), MP3s in ${audioDir ?? defaultAudioDir()} (WISSEL_TTS_URL, WISSEL_TTS_VOICE, WISSEL_AUDIO_DIR)`,
  );
}
