import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Board, BoardEvent } from "../services/board.ts";
import { SqliteBoard } from "../services/board.ts";
import type { PipelineStore } from "../services/pipelines.ts";
import { SqlitePipelineStore } from "../services/pipelines.ts";
import { TelemetryLog } from "../services/telemetry.ts";
import { HarnessPool } from "../core/harness-pool.ts";
import { Registry } from "../core/registry.ts";
import { Router } from "../core/router.ts";
import { Orchestrator, finishResult, resolveHandoffAllowlist, wireAutoIntegrator } from "../core/orchestrator.ts";
import { startPipelineRun } from "../core/pipeline-runner.ts";
import { startMemoryScheduler, getMemoryCurationHistory } from "../core/memory-scheduler.ts";
import { startArchiveScheduler } from "../core/archive-scheduler.ts";
import { startModelRefreshScheduler, readModelsCache, DEFAULT_MODELS_CACHE_PATH } from "../core/model-refresh-scheduler.ts";
import { readMemoryLessons, DEFAULT_MEMORY_PATH } from "../services/memory.ts";
import { ReadOnlyExecutor } from "../executors/readonly.ts";
import { WriteExecutor } from "../executors/write.ts";
import { ApiExecutor } from "../executors/anthropic-api.ts";
import { CodexReadOnlyExecutor } from "../executors/codex-readonly.ts";
import { CodexWriteExecutor } from "../executors/codex-write.ts";
import { getRepoDiff } from "../services/repo-diff.ts";
import { mergeTaskWorktree, removeTaskWorktree } from "../services/worktree.ts";
import { runViaBun, type CommandRunner } from "../executors/claude-cli.ts";
import { checkHarnessAuth } from "../core/harness-discovery.ts";
import { setHarnessEnabled, setHarnessModel } from "../core/harness-manifest.ts";
import { getVersionInfo } from "../core/version.ts";
import type { Executor, PipelineGraph, RoutingDecision, TaskCard, TaskResult } from "../core/types.ts";

const PUBLIC_DIR = new URL("./public/", import.meta.url);

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
  // Same default the refresh scheduler itself falls back to — read here
  // too so `GET /harnesses`/`POST /harnesses/:id/model`/`POST /tasks`
  // validate against exactly the file the scheduler (or a real refresh
  // run) actually wrote, whether or not `modelRefreshEnabled` is on.
  const modelsCachePath = opts.modelsCachePath ?? DEFAULT_MODELS_CACHE_PATH;

  const executeWriteTier = opts.executeWriteTier ?? false;
  // ApiExecutor and CodexReadOnlyExecutor are unconditional, like
  // ReadOnlyExecutor — all three are tier-gated to "readonly" agents
  // (see their canHandle), so there's no write risk to gate behind
  // executeWriteTier the way WriteExecutor/CodexWriteExecutor are.
  const autoExecutors: Executor[] = [
    new ReadOnlyExecutor({ memoryPath: opts.memoryPath }),
    new ApiExecutor(),
    new CodexReadOnlyExecutor({ memoryPath: opts.memoryPath }),
  ];
  if (executeWriteTier) autoExecutors.push(new WriteExecutor({ memoryPath: opts.memoryPath }), new CodexWriteExecutor({ memoryPath: opts.memoryPath }));
  const manualExecutors: Executor[] = opts.manualExecutors ?? [
    new ReadOnlyExecutor({ memoryPath: opts.memoryPath }),
    new ApiExecutor(),
    new CodexReadOnlyExecutor({ memoryPath: opts.memoryPath }),
    new WriteExecutor({ memoryPath: opts.memoryPath }),
    new CodexWriteExecutor({ memoryPath: opts.memoryPath }),
  ];

  // A pipeline run always executes every step in-process, the same way
  // a human's manual "Run" click does — a pipeline never hands a step
  // off to agetor in this phase (see docs/SDD-pipelines.md §3.3), so it
  // reuses this exact pool rather than the automatic loop's
  // executeWriteTier-gated one.
  const pipelines: PipelineStore = opts.pipelines ?? new SqlitePipelineStore((board as SqliteBoard).db);

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
  if (opts.orchestratorEnabled) orchestrator.start();
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

  return async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);

    try {
      if (url.pathname === "/health") return new Response("ok");

      // No auth, same as /health — nothing in VersionInfo is sensitive.
      if (url.pathname === "/version") return json(getVersionInfo());

      if ((url.pathname === "/" || url.pathname === "/board") && req.method === "GET") {
        return new Response(Bun.file(new URL("board.html", PUBLIC_DIR)));
      }

      if (url.pathname === "/agents" && req.method === "GET") {
        return json(registry.all());
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

      // Current curated memory — what's actually injected into every
      // agent's prompt right now (see buildAgentPrompt/readMemoryLessons).
      // `content: undefined` (never an error) means curation hasn't
      // produced a file yet — the board UI's Memory tab shows that as an
      // empty state, not a fetch failure.
      if (url.pathname === "/memory" && req.method === "GET") {
        const content = await readMemoryLessons(opts.memoryPath ?? DEFAULT_MEMORY_PATH);
        return json({ content, path: opts.memoryPath ?? DEFAULT_MEMORY_PATH });
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
          return json(harnesses.setEnabled(harness.id, true));
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
          const body = (await req.json()) as { repo?: string; input?: string };
          if (!body.repo || !body.input) return json({ error: "repo and input are required" }, 400);
          const root = await startPipelineRun(board as Board, registry, pipeline, body.repo, body.input, {
            executors: manualExecutors,
            pipelines,
            harnesses,
            telemetry,
            memoryPath: opts.memoryPath,
          });
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
          return json(await getRepoDiff(result?.worktree?.path ?? task.repo));
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
          const merge = await mergeTaskWorktree(task.repo, result.worktree, task, runViaBun);
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
          await removeTaskWorktree(task.repo, result.worktree, runViaBun);
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

  Bun.serve({
    port,
    fetch: createApp(board, registry, telemetry, {
      orchestratorEnabled,
      executeWriteTier,
      harnesses,
      harnessesPath,
      maxConcurrentTasks,
      spendCeilingUsd,
      memoryCurationEnabled,
      memoryIntervalHours,
      memoryPath,
      autoArchiveEnabled,
      archiveCheckIntervalHours,
      modelRefreshEnabled,
      modelRefreshIntervalHours,
      modelsCachePath,
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
    memoryCurationEnabled
      ? `memory curation scheduled every ${memoryIntervalHours}h (WISSEL_MEMORY_CURATION=1)`
      : "memory curation not started — set WISSEL_MEMORY_CURATION=1 to let wissel learn from its own session history",
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
}
