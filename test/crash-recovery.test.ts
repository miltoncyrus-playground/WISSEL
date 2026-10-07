import { expect, test } from "bun:test";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { createApp } from "../src/api/server.ts";
import { isAgentProcess, killExternalProcess, listProcProcesses, reconcileOrphanedTasks } from "../src/core/crash-recovery.ts";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskCard } from "../src/core/types.ts";

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

// --- reconcileOrphanedTasks: direct unit coverage against a real SqliteBoard ---

test("reconcileOrphanedTasks: a running task is reset to inbox with routedTo cleared", async () => {
  const board = new SqliteBoard();
  const created = await board.create({ title: "t", body: "", labels: [], repo: "r" });
  await board.move(created.id, "running");
  // move() doesn't touch routedTo, so set it directly the way sweep() does.
  const db = (board as SqliteBoard).db;
  db.run("UPDATE tasks SET routedTo = ? WHERE id = ?", ["implementer", created.id]);

  const count = await reconcileOrphanedTasks(board);
  expect(count).toBe(1);

  const after = await board.get(created.id);
  expect(after?.status).toBe("inbox");
  expect(after?.routedTo).toBeUndefined();
});

test("reconcileOrphanedTasks: a dispatched task is completely untouched (regression)", async () => {
  const board = new SqliteBoard();
  const created = await board.create({ title: "t", body: "", labels: [], repo: "r" });
  await board.move(created.id, "dispatched");
  const db = (board as SqliteBoard).db;
  db.run("UPDATE tasks SET routedTo = ? WHERE id = ?", ["integrator", created.id]);

  const count = await reconcileOrphanedTasks(board);
  expect(count).toBe(0);

  const after = await board.get(created.id);
  expect(after?.status).toBe("dispatched");
  expect(after?.routedTo).toBe("integrator");
});

test("reconcileOrphanedTasks: every other status is untouched — full board distribution, only running tasks reset", async () => {
  const board = new SqliteBoard();
  const statuses: TaskCard["status"][] = [
    "inbox",
    "ready",
    "running",
    "running",
    "dispatched",
    "review",
    "done",
    "failed",
    "escalated",
    "no-match",
    "pending-review",
  ];
  const ids: string[] = [];
  for (const status of statuses) {
    const created = await board.create({ title: status, body: "", labels: [], repo: "r" });
    await board.move(created.id, status);
    ids.push(created.id);
  }

  const before = await board.list();
  const beforeDistribution = before.map((t) => ({ id: t.id, status: t.status })).sort((a, b) => a.id.localeCompare(b.id));

  const count = await reconcileOrphanedTasks(board);
  expect(count).toBe(2);

  const after = await board.list();
  const afterDistribution = after.map((t) => ({ id: t.id, status: t.status })).sort((a, b) => a.id.localeCompare(b.id));

  const expectedDistribution = beforeDistribution.map((t) => (t.status === "running" ? { ...t, status: "inbox" as const } : t));
  expect(afterDistribution).toEqual(expectedDistribution);
});

// --- Integration: the real createApp/startup path, no server process needed ---

test("createApp startup path: a seeded running task is reset to inbox before any request is served", async () => {
  const board = new SqliteBoard();
  const registry = await Registry.load();
  const running = await board.create({ title: "orphaned", body: "", labels: [], repo: "r" });
  await board.move(running.id, "running");
  const db = (board as SqliteBoard).db;
  db.run("UPDATE tasks SET routedTo = ? WHERE id = ?", ["implementer", running.id]);

  const dispatched = await board.create({ title: "handed-off", body: "", labels: [], repo: "r" });
  await board.move(dispatched.id, "dispatched");
  db.run("UPDATE tasks SET routedTo = ? WHERE id = ?", ["integrator", dispatched.id]);

  const app = createApp(board, registry);
  const res = await app(req("/tasks"));
  expect(res.status).toBe(200);
  const tasks = (await res.json()) as TaskCard[];

  const reconciled = tasks.find((t) => t.id === running.id);
  expect(reconciled?.status).toBe("inbox");
  expect(reconciled?.routedTo).toBeUndefined();

  const untouched = tasks.find((t) => t.id === dispatched.id);
  expect(untouched?.status).toBe("dispatched");
  expect(untouched?.routedTo).toBe("integrator");
});

// --- reconcileOrphanedTasks: live agent processes left in the worktree (docs/SDD-crash-recovery.md §10) ---

const HOME = "/home/fake";

async function seedRunning(board: SqliteBoard, title = "t"): Promise<TaskCard> {
  const created = await board.create({ title, body: "", labels: [], repo: "r" });
  await board.move(created.id, "running");
  return created;
}

function worktreeOf(id: string): string {
  return `${HOME}/.wissel/worktrees/${id}`;
}

test("reconcileOrphanedTasks: a live claude process in the task's worktree is killed before the reset", async () => {
  const board = new SqliteBoard();
  const task = await seedRunning(board);
  const order: string[] = [];
  const realReset = board.resetToInbox.bind(board);
  board.resetToInbox = async (id: string) => {
    order.push(`reset ${id}`);
    return realReset(id);
  };
  const lines: string[] = [];

  const count = await reconcileOrphanedTasks(board, {
    homeDir: HOME,
    listProcesses: () => [
      { pid: 158838, cwd: worktreeOf(task.id), argv: ["claude", "-p", "--output-format", "stream-json"] },
      { pid: 158900, cwd: `${worktreeOf(task.id)}/src`, argv: ["/usr/bin/node", "/opt/codex/bin/codex.js", "exec"] },
    ],
    killProcess: async (pid) => {
      order.push(`kill ${pid}`);
      return true;
    },
    log: (l) => lines.push(l),
  });

  expect(count).toBe(1);
  expect(order).toEqual(["kill 158838", "kill 158900", `reset ${task.id}`]);
  expect(lines.some((l) => l.includes("killed orphaned agent process 158838") && l.includes(task.id))).toBe(true);
  expect((await board.get(task.id))?.status).toBe("inbox");
});

test("reconcileOrphanedTasks: a pushback re-attempt's process is matched by its lineage worktree", async () => {
  const board = new SqliteBoard();
  const task = await seedRunning(board);
  board.db.run("UPDATE tasks SET reviewLineageId = ? WHERE id = ?", ["lineage-1", task.id]);
  const killed: number[] = [];

  await reconcileOrphanedTasks(board, {
    homeDir: HOME,
    listProcesses: () => [{ pid: 4242, cwd: worktreeOf("lineage-1"), argv: ["claude", "-p"] }],
    killProcess: async (pid) => (killed.push(pid), true),
    log: () => {},
  });

  expect(killed).toEqual([4242]);
});

test("reconcileOrphanedTasks: non-matching processes are left alone (other worktree, prefix lookalike, non-agent binary)", async () => {
  const board = new SqliteBoard();
  const task = await seedRunning(board);
  const killed: number[] = [];

  const count = await reconcileOrphanedTasks(board, {
    homeDir: HOME,
    listProcesses: () => [
      { pid: 1, cwd: worktreeOf("some-other-task"), argv: ["claude", "-p"] },
      { pid: 2, cwd: `${worktreeOf(task.id)}-sibling`, argv: ["claude", "-p"] },
      { pid: 3, cwd: worktreeOf(task.id), argv: ["bash"] },
      { pid: 4, cwd: worktreeOf(task.id), argv: ["bun", "test", "test/"] },
      { pid: process.pid, cwd: worktreeOf(task.id), argv: ["claude"] },
    ],
    killProcess: async (pid) => (killed.push(pid), true),
    log: () => {},
  });

  expect(killed).toEqual([]);
  expect(count).toBe(1);
  expect((await board.get(task.id))?.status).toBe("inbox");
});

test("reconcileOrphanedTasks: a failing process lister falls back to today's behavior — logged, every task still reset", async () => {
  const board = new SqliteBoard();
  const a = await seedRunning(board, "a");
  const b = await seedRunning(board, "b");
  const errors: string[] = [];

  const count = await reconcileOrphanedTasks(board, {
    homeDir: HOME,
    listProcesses: () => {
      throw new Error("EACCES: permission denied, scandir '/proc'");
    },
    killProcess: async () => {
      throw new Error("must not be called");
    },
    logError: (l) => errors.push(l),
  });

  expect(count).toBe(2);
  expect((await board.get(a.id))?.status).toBe("inbox");
  expect((await board.get(b.id))?.status).toBe("inbox");
  expect(errors.some((l) => l.includes("can't check for live agent processes") && l.includes("EACCES"))).toBe(true);
});

test("reconcileOrphanedTasks: a live process that can't be stopped leaves its task at running (fails closed), others still reset", async () => {
  const board = new SqliteBoard();
  const stuck = await seedRunning(board, "stuck");
  const fine = await seedRunning(board, "fine");
  const errors: string[] = [];

  const count = await reconcileOrphanedTasks(board, {
    homeDir: HOME,
    listProcesses: () => [{ pid: 999, cwd: worktreeOf(stuck.id), argv: ["claude"] }],
    killProcess: async () => {
      throw new Error("EPERM");
    },
    log: () => {},
    logError: (l) => errors.push(l),
  });

  expect(count).toBe(1);
  expect((await board.get(stuck.id))?.status).toBe("running");
  expect((await board.get(fine.id))?.status).toBe("inbox");
  expect(errors.some((l) => l.includes("failed to kill live agent process 999") && l.includes("EPERM"))).toBe(true);
  expect(errors.some((l) => l.includes(stuck.id) && l.includes("needs a human"))).toBe(true);
});

test("reconcileOrphanedTasks: no running tasks means the process lister never runs", async () => {
  const board = new SqliteBoard();
  let listed = false;
  const count = await reconcileOrphanedTasks(board, {
    listProcesses: () => ((listed = true), []),
  });
  expect(count).toBe(0);
  expect(listed).toBe(false);
});

test("isAgentProcess: claude/codex binaries and node shims match; anything else doesn't", () => {
  expect(isAgentProcess(["claude", "-p"])).toBe(true);
  expect(isAgentProcess(["/home/u/.local/bin/claude", "--resume"])).toBe(true);
  expect(isAgentProcess(["codex", "exec"])).toBe(true);
  expect(isAgentProcess(["node", "/usr/lib/node_modules/@openai/codex/bin/codex.js"])).toBe(true);
  expect(isAgentProcess(["sleep", "300"])).toBe(false);
  expect(isAgentProcess(["bun", "run", "claude-cli.ts"])).toBe(false);
  expect(isAgentProcess([])).toBe(false);
});

test("listProcProcesses + killExternalProcess: real /proc sees a real child's cwd, and the kill makes it gone", async () => {
  if (process.platform !== "linux") return;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wissel-orphan-")));
  const proc = Bun.spawn(["sleep", "30.2"], { cwd: dir, stdout: "ignore", stderr: "ignore" });
  try {
    const found = listProcProcesses().find((p) => p.pid === proc.pid);
    expect(found?.cwd).toBe(dir);
    expect(found?.argv).toEqual(["sleep", "30.2"]);

    expect(await killExternalProcess(proc.pid, 1000)).toBe(true);
    await proc.exited;
    expect(listProcProcesses().some((p) => p.pid === proc.pid)).toBe(false);
  } finally {
    proc.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("killExternalProcess: an already-gone pid counts as stopped", async () => {
  const proc = Bun.spawn(["true"]);
  await proc.exited;
  await Bun.sleep(20);
  expect(await killExternalProcess(proc.pid, 100)).toBe(true);
});
