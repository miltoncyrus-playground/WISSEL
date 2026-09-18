import { homedir } from "node:os";
import { join } from "node:path";
import type { Board, BoardEvent } from "../services/board.ts";
import { SqliteBoard } from "../services/board.ts";
import { TelemetryLog } from "../services/telemetry.ts";
import { Registry } from "../core/registry.ts";
import { Router } from "../core/router.ts";
import { Orchestrator, finishResult } from "../core/orchestrator.ts";
import { ReadOnlyExecutor } from "../executors/readonly.ts";
import type { RoutingDecision, TaskCard, TaskResult } from "../core/types.ts";

const PUBLIC_DIR = new URL("./public/", import.meta.url);

/**
 * Board API. One SSE stream per board carries card moves and routing
 * decisions, so the fleet view, the routing decision panel, and whatever
 * actually runs write-tier work (agetor) all watch the same feed. wissel
 * decides and dispatches here; it never spawns or supervises execution
 * itself — write-tier results arrive as a plain POST from whoever ran
 * the work.
 *
 * Exported as a plain fetch handler (not bound to a port) so tests can
 * exercise routing without opening a socket.
 */
export function createApp(
  board: Board & { events?: import("node:events").EventEmitter },
  registry: Registry,
  telemetry?: TelemetryLog,
) {
  return async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);

    try {
      if (url.pathname === "/health") return new Response("ok");

      if ((url.pathname === "/" || url.pathname === "/board") && req.method === "GET") {
        return new Response(Bun.file(new URL("board.html", PUBLIC_DIR)));
      }

      if (url.pathname === "/agents" && req.method === "GET") {
        return json(registry.all());
      }

      if (url.pathname === "/events" && req.method === "GET") {
        return sseStream(board);
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

        if (parts.length === 3 && parts[2] === "override" && req.method === "POST") {
          const { routerPick, humanPick } = (await req.json()) as { routerPick: string; humanPick: string };
          await board.recordOverride(parts[1]!, routerPick, humanPick);
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
  Bun.serve({ port, fetch: createApp(board, registry, telemetry) });
  console.log(`wissel board api on :${port} (db: ${dbPath})`);

  // Off by default: this loop routes eligible tasks automatically the
  // moment they appear. Read-only agents run in-process; write-tier
  // agents are only decided and handed off — nothing here spawns or
  // supervises execution, so the blast radius is "an agent gets picked
  // without a human clicking route," not "unattended code changes."
  const orchestratorEnabled = ["1", "true"].includes(process.env.WISSEL_ORCHESTRATOR ?? "");
  if (orchestratorEnabled) {
    const router = new Router(registry);
    const executors = [new ReadOnlyExecutor()];
    new Orchestrator(board, registry, router, executors, telemetry).start();
    console.log("wissel orchestrator running");
  } else {
    console.log("wissel orchestrator not started — set WISSEL_ORCHESTRATOR=1 to route tasks automatically");
  }
}
