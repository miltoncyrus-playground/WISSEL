import { homedir } from "node:os";
import { join } from "node:path";
import type { Board, BoardEvent } from "../services/board.ts";
import { SqliteBoard } from "../services/board.ts";
import { TelemetryLog } from "../services/telemetry.ts";
import { HarnessPool } from "../core/harness-pool.ts";
import { Registry } from "../core/registry.ts";
import { Router } from "../core/router.ts";
import { Orchestrator, finishResult, resolveHandoffAllowlist } from "../core/orchestrator.ts";
import { ReadOnlyExecutor } from "../executors/readonly.ts";
import { WriteExecutor } from "../executors/write.ts";
import { ApiExecutor } from "../executors/anthropic-api.ts";
import { CodexReadOnlyExecutor } from "../executors/codex-readonly.ts";
import { CodexWriteExecutor } from "../executors/codex-write.ts";
import { getRepoDiff } from "../services/repo-diff.ts";
import { mergeTaskWorktree, removeTaskWorktree } from "../services/worktree.ts";
import { runViaBun, type CommandRunner } from "../executors/claude-cli.ts";
import { checkHarnessAuth } from "../core/harness-discovery.ts";
import { setHarnessEnabled } from "../core/harness-manifest.ts";
import { getVersionInfo } from "../core/version.ts";
import type { Executor, RoutingDecision, TaskCard, TaskResult } from "../core/types.ts";

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
   *  /harnesses/:id/enable`/`/disable` persist a human's decision (see
   *  docs/SDD-harness-enable-disable.md). Defaults to the same
   *  "harnesses.yaml" relative path HarnessPool.load()/autoload()
   *  already default to. */
  harnessesPath?: string;
  /** Used only by `POST /harnesses/:id/enable`'s re-validation check —
   *  injectable so tests never spawn a real `claude`/`codex` process.
   *  Defaults to the real one. */
  harnessRunner?: CommandRunner;
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

  const executeWriteTier = opts.executeWriteTier ?? false;
  // ApiExecutor and CodexReadOnlyExecutor are unconditional, like
  // ReadOnlyExecutor — all three are tier-gated to "readonly" agents
  // (see their canHandle), so there's no write risk to gate behind
  // executeWriteTier the way WriteExecutor/CodexWriteExecutor are.
  const autoExecutors: Executor[] = [new ReadOnlyExecutor(), new ApiExecutor(), new CodexReadOnlyExecutor()];
  if (executeWriteTier) autoExecutors.push(new WriteExecutor(), new CodexWriteExecutor());
  const manualExecutors: Executor[] = opts.manualExecutors ?? [
    new ReadOnlyExecutor(),
    new ApiExecutor(),
    new CodexReadOnlyExecutor(),
    new WriteExecutor(),
    new CodexWriteExecutor(),
  ];

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
    { executeWriteTier, harnesses },
  );
  if (opts.orchestratorEnabled) orchestrator.start();

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
        return json(harnesses.all().map((h) => ({ ...h, activeCount: harnesses.activeCount(h.id) })));
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
          await finishResult(board as Board, registry, { ...body, taskId: parts[1]! }, telemetry);
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
  // Auto-detects every already-authenticated account on this machine
  // (see harness-discovery.ts) and layers harnesses.yaml on top as
  // overrides — the file is optional either way; zero configured or
  // detected harnesses is a valid, common state, not a startup error.
  const harnesses = await HarnessPool.autoload();

  // Off by default: this loop routes eligible tasks automatically the
  // moment they appear. Read-only agents run in-process; write-tier
  // agents are only decided and handed off (unless executeWriteTier is
  // also on) — nothing here spawns or supervises execution beyond that,
  // so the blast radius is "an agent gets picked without a human
  // clicking route," not "unattended code changes." The board's manual
  // "Run" button works either way — see createApp's manualExecutors.
  const orchestratorEnabled = ["1", "true"].includes(process.env.WISSEL_ORCHESTRATOR ?? "");
  const executeWriteTier = ["1", "true"].includes(process.env.WISSEL_EXECUTE_WRITE_TIER ?? "");

  Bun.serve({ port, fetch: createApp(board, registry, telemetry, { orchestratorEnabled, executeWriteTier, harnesses }) });
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
}
