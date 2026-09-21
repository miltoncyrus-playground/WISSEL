import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { createApp, type CreateAppOptions } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import type { AgentDef, Executor, Harness, TaskCard, TaskResult } from "../src/core/types.ts";
import type { CommandRunner } from "../src/executors/claude-cli.ts";

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

async function makeApp(board = new SqliteBoard(), opts?: CreateAppOptions) {
  const registry = await Registry.load();
  return createApp(board, registry, undefined, opts);
}

/** A fake write executor for `/tasks/:id/run` tests — never spawns a
 *  real `claude` process. */
function fakeWriteExecutor(run: Executor["run"]): Executor {
  return { id: "fake-write", canHandle: (agent: AgentDef) => agent.tier === "write", run };
}

test("GET /health", async () => {
  const app = await makeApp();
  const res = await app(req("/health"));
  expect(await res.text()).toBe("ok");
});

test("GET /version", async () => {
  const app = await makeApp();
  const res = await app(req("/version"));
  const body = (await res.json()) as {
    commit: string;
    commitShort: string;
    branch: string;
    dirty: boolean;
    packageVersion: string;
    startedAt: string;
  };
  // Shape/types only, not the literal SHA — that would flake on every commit.
  expect(typeof body.commit).toBe("string");
  expect(typeof body.commitShort).toBe("string");
  expect(typeof body.branch).toBe("string");
  expect(typeof body.dirty).toBe("boolean");
  expect(body.packageVersion).toBe("0.0.0");
  expect(typeof body.startedAt).toBe("string");
});

test("GET / and GET /board serve the board UI", async () => {
  const app = await makeApp();
  for (const path of ["/", "/board"]) {
    const res = await app(req(path));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<title>wissel board</title>");
  }
});

test("GET /agents returns the fleet from the manifest", async () => {
  const app = await makeApp();
  const res = await app(req("/agents"));
  const agents = (await res.json()) as { id: string }[];
  expect(agents.some((a) => a.id === "triager")).toBe(true);
});

test("GET /harnesses defaults to empty, and returns configured harnesses with a live activeCount", async () => {
  const empty = await makeApp();
  expect(await (await empty(req("/harnesses"))).json()).toEqual([]);

  const harnesses = HarnessPool.from([{ id: "claude-personal", tool: "claude-cli", label: "Claude — personal", enabled: true }]);
  const withHarness = await makeApp(new SqliteBoard(), { harnesses });
  const res = await withHarness(req("/harnesses"));
  const body = (await res.json()) as { id: string; tool: string; label: string; enabled: boolean; activeCount: number }[];
  expect(body).toEqual([{ id: "claude-personal", tool: "claude-cli", label: "Claude — personal", enabled: true, activeCount: 0 }]);
});

async function harnessesFixture(content: string): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "wissel-api-harnesses-test-"));
  const path = join(dir, "harnesses.yaml");
  await writeFile(path, content);
  return { dir, path };
}

test("POST /harnesses/:id/disable persists to harnesses.yaml and updates the live pool, no re-validation needed", async () => {
  const { dir, path } = await harnessesFixture("harnesses:\n  - id: a\n    tool: claude-cli\n    label: A\n    enabled: true\n");
  try {
    const harnesses = HarnessPool.from([{ id: "a", tool: "claude-cli", label: "A", enabled: true }]);
    let runnerCalled = false;
    const app = await makeApp(new SqliteBoard(), {
      harnesses,
      harnessesPath: path,
      harnessRunner: async () => {
        runnerCalled = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    const res = await app(req("/harnesses/a/disable", { method: "POST" }));

    expect(res.status).toBe(200);
    expect(((await res.json()) as Harness).enabled).toBe(false);
    expect(harnesses.get("a")?.enabled).toBe(false);
    expect(runnerCalled).toBe(false);
    const onDisk = parse(await readFile(path, "utf8")) as { harnesses: Harness[] };
    expect(onDisk.harnesses.find((h) => h.id === "a")?.enabled).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /harnesses/:id/enable re-validates first — succeeds and clears disabledReason when still authenticated", async () => {
  const { dir, path } = await harnessesFixture("harnesses:\n  - id: a\n    tool: claude-cli\n    label: A\n    enabled: false\n    disabledReason: not authenticated\n");
  try {
    const harnesses = HarnessPool.from([{ id: "a", tool: "claude-cli", label: "A", enabled: false, disabledReason: "not authenticated" }]);
    const runner: CommandRunner = async () => ({ stdout: JSON.stringify({ loggedIn: true }), stderr: "", exitCode: 0 });
    const app = await makeApp(new SqliteBoard(), { harnesses, harnessesPath: path, harnessRunner: runner });

    const res = await app(req("/harnesses/a/enable", { method: "POST" }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as Harness;
    expect(body.enabled).toBe(true);
    expect(body.disabledReason).toBeUndefined();
    expect(harnesses.get("a")?.enabled).toBe(true);
    const onDisk = parse(await readFile(path, "utf8")) as { harnesses: Harness[] };
    expect(onDisk.harnesses.find((h) => h.id === "a")?.enabled).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /harnesses/:id/enable refuses with 409 when still not authenticated, and never touches harnesses.yaml", async () => {
  const { dir, path } = await harnessesFixture("harnesses:\n  - id: a\n    tool: claude-cli\n    label: A\n    enabled: false\n");
  const before = await readFile(path, "utf8");
  try {
    const harnesses = HarnessPool.from([{ id: "a", tool: "claude-cli", label: "A", enabled: false }]);
    const runner: CommandRunner = async () => ({ stdout: JSON.stringify({ loggedIn: false }), stderr: "", exitCode: 0 });
    const app = await makeApp(new SqliteBoard(), { harnesses, harnessesPath: path, harnessRunner: runner });

    const res = await app(req("/harnesses/a/enable", { method: "POST" }));

    expect(res.status).toBe(409);
    expect(harnesses.get("a")?.enabled).toBe(false);
    expect(harnesses.get("a")?.disabledReason).toBe("not authenticated");
    expect(await readFile(path, "utf8")).toBe(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /harnesses/:id/enable and /disable 404 for an unknown id", async () => {
  const app = await makeApp(new SqliteBoard(), { harnesses: HarnessPool.from([]) });
  expect((await app(req("/harnesses/missing/enable", { method: "POST" }))).status).toBe(404);
  expect((await app(req("/harnesses/missing/disable", { method: "POST" }))).status).toBe(404);
});

test("POST /tasks then GET /tasks round-trips, defaulting dependsOn to []", async () => {
  const app = await makeApp();
  const create = await app(
    req("/tasks", {
      method: "POST",
      body: JSON.stringify({ title: "t", body: "b", labels: ["x"], repo: "r" }),
    }),
  );
  expect(create.status).toBe(201);
  const created = (await create.json()) as TaskCard;
  expect(created.status).toBe("inbox");
  expect(created.dependsOn).toEqual([]);

  const list = await app(req("/tasks"));
  expect(await list.json()).toEqual([created]);

  const single = await app(req(`/tasks/${created.id}`));
  expect(await single.json()).toEqual(created);
});

test("GET /tasks/:id 404s for unknown id", async () => {
  const app = await makeApp();
  const res = await app(req("/tasks/nope"));
  expect(res.status).toBe(404);
});

test("POST /tasks/:id/move updates status, 404s on unknown id", async () => {
  const app = await makeApp();
  const create = await app(
    req("/tasks", { method: "POST", body: JSON.stringify({ title: "t", body: "", labels: [], repo: "r" }) }),
  );
  const created = (await create.json()) as TaskCard;

  const move = await app(req(`/tasks/${created.id}/move`, { method: "POST", body: JSON.stringify({ status: "running" }) }));
  expect(((await move.json()) as TaskCard).status).toBe("running");

  const missing = await app(req("/tasks/nope/move", { method: "POST", body: JSON.stringify({ status: "done" }) }));
  expect(missing.status).toBe(404);
});

test("DELETE /tasks/:id removes the task, 404s on unknown id", async () => {
  const app = await makeApp();
  const created = (await (await app(req("/tasks", { method: "POST", body: JSON.stringify({ title: "t", body: "", labels: [], repo: "r" }) }))).json()) as TaskCard;

  const del = await app(req(`/tasks/${created.id}`, { method: "DELETE" }));
  expect(del.status).toBe(204);
  expect((await app(req(`/tasks/${created.id}`))).status).toBe(404);

  const missing = await app(req("/tasks/nope", { method: "DELETE" }));
  expect(missing.status).toBe(404);
});

test("POST /tasks/:id/depends-on updates dependsOn, 404s on unknown id", async () => {
  const app = await makeApp();
  const a = (await (await app(req("/tasks", { method: "POST", body: JSON.stringify({ title: "a", body: "", labels: [], repo: "r" }) }))).json()) as TaskCard;
  const b = (await (await app(req("/tasks", { method: "POST", body: JSON.stringify({ title: "b", body: "", labels: [], repo: "r" }) }))).json()) as TaskCard;

  const dep = await app(req(`/tasks/${b.id}/depends-on`, { method: "POST", body: JSON.stringify({ dependsOn: [a.id] }) }));
  expect(((await dep.json()) as TaskCard).dependsOn).toEqual([a.id]);

  const missing = await app(req("/tasks/nope/depends-on", { method: "POST", body: JSON.stringify({ dependsOn: [] }) }));
  expect(missing.status).toBe(404);
});

test("POST /tasks/:id/decision, /result, /override return 204 and fan out over SSE", async () => {
  const board = new SqliteBoard();
  const app = await makeApp(board);
  const create = await app(
    req("/tasks", { method: "POST", body: JSON.stringify({ title: "t", body: "", labels: [], repo: "r" }) }),
  );
  const created = (await create.json()) as TaskCard;

  const sse = await app(req("/events"));
  const reader = sse.body!.getReader();
  await reader.read(); // ": connected" preamble

  const decision = await app(
    req(`/tasks/${created.id}/decision`, {
      method: "POST",
      body: JSON.stringify({
        matchedTags: [],
        candidates: [],
        selected: "a",
        confident: true,
        reason: "r",
        strategy: "rule",
        decidedAt: new Date().toISOString(),
      }),
    }),
  );
  expect(decision.status).toBe(204);

  const result = await app(
    req(`/tasks/${created.id}/result`, {
      method: "POST",
      body: JSON.stringify({ agentId: "a", ok: true, summary: "done" }),
    }),
  );
  expect(result.status).toBe(204);

  const override = await app(
    req(`/tasks/${created.id}/override`, {
      method: "POST",
      body: JSON.stringify({ routerPick: "a", humanPick: "b" }),
    }),
  );
  expect(override.status).toBe(204);

  const decoder = new TextDecoder();
  const chunk = decoder.decode((await reader.read()).value);
  expect(chunk).toContain("task.decided");
  await reader.cancel();
});

test("GET /tasks/:id/decision returns the recorded decision, 404s with none", async () => {
  const app = await makeApp();
  const create = await app(
    req("/tasks", { method: "POST", body: JSON.stringify({ title: "t", body: "", labels: [], repo: "r" }) }),
  );
  const created = (await create.json()) as TaskCard;

  const before = await app(req(`/tasks/${created.id}/decision`));
  expect(before.status).toBe(404);

  await app(
    req(`/tasks/${created.id}/decision`, {
      method: "POST",
      body: JSON.stringify({
        matchedTags: ["x"],
        candidates: [{ agentId: "triager", score: 1, reason: "tag match" }],
        selected: "triager",
        confident: true,
        reason: "tag match",
        strategy: "rule",
        decidedAt: new Date().toISOString(),
      }),
    }),
  );

  const after = await app(req(`/tasks/${created.id}/decision`));
  expect(after.status).toBe(200);
  const decision = (await after.json()) as { selected: string; confident: boolean };
  expect(decision.selected).toBe("triager");
  expect(decision.confident).toBe(true);
});

test("POST /route/preview confidently matches real manifest tags without creating a task", async () => {
  const app = await makeApp();
  const res = await app(req("/route/preview", { method: "POST", body: JSON.stringify({ labels: ["intake"] }) }));
  expect(res.status).toBe(200);
  const decision = (await res.json()) as { selected: string; confident: boolean; candidates: unknown[] };
  expect(decision.confident).toBe(true);
  expect(decision.selected).toBe("triager");
  expect(decision.candidates.length).toBeGreaterThan(1);
});

test("POST /route/preview reports no-match without confident selection, and empty labels the same way", async () => {
  const app = await makeApp();

  const noMatch = await app(req("/route/preview", { method: "POST", body: JSON.stringify({ labels: ["totally-unknown"] }) }));
  const noMatchDecision = (await noMatch.json()) as { selected: string | null; confident: boolean };
  expect(noMatchDecision.confident).toBe(false);
  expect(noMatchDecision.selected).toBeNull();

  const empty = await app(req("/route/preview", { method: "POST", body: JSON.stringify({ labels: [] }) }));
  const emptyDecision = (await empty.json()) as { selected: string | null; confident: boolean };
  expect(emptyDecision.confident).toBe(false);
  expect(emptyDecision.selected).toBeNull();

  const missing = await app(req("/route/preview", { method: "POST", body: JSON.stringify({}) }));
  expect(missing.status).toBe(200);
});

test("POST /route/preview restricts to a routed parent's declared handoffs", async () => {
  const app = await makeApp();

  const parent = await app(
    req("/tasks", { method: "POST", body: JSON.stringify({ title: "p", body: "", labels: [], repo: "r" }) }),
  );
  const parentTask = (await parent.json()) as TaskCard;
  await app(
    req(`/tasks/${parentTask.id}/decision`, {
      method: "POST",
      body: JSON.stringify({
        matchedTags: ["intake"], candidates: [], selected: "triager", confident: true,
        reason: "r", strategy: "rule", decidedAt: new Date().toISOString(),
      }),
    }),
  );

  // "ci" matches fixer perfectly, but triager's only declared handoff is planner.
  const res = await app(
    req("/route/preview", { method: "POST", body: JSON.stringify({ labels: ["ci"], parentTaskId: parentTask.id }) }),
  );
  const decision = (await res.json()) as { selected: string | null; confident: boolean; candidates: { agentId: string }[]; reason: string };
  expect(decision.candidates.map((c) => c.agentId)).toEqual(["planner"]);
  expect(decision.confident).toBe(false);
  expect(decision.reason).toContain("restricted to declared handoffs: planner");
});

test("POST /tasks round-trips parentTaskId", async () => {
  const app = await makeApp();
  const parent = await app(
    req("/tasks", { method: "POST", body: JSON.stringify({ title: "p", body: "", labels: [], repo: "r" }) }),
  );
  const parentTask = (await parent.json()) as TaskCard;

  const child = await app(
    req("/tasks", { method: "POST", body: JSON.stringify({ title: "c", body: "", labels: [], repo: "r", parentTaskId: parentTask.id }) }),
  );
  const childTask = (await child.json()) as TaskCard;
  expect(childTask.parentTaskId).toBe(parentTask.id);

  const fetched = await app(req(`/tasks/${childTask.id}`));
  expect(((await fetched.json()) as TaskCard).parentTaskId).toBe(parentTask.id);
});

test("POST /tasks/:id/result routes a write-tier report to review, a readonly one to done", async () => {
  const app = await makeApp();

  const writeTask = (await (
    await app(req("/tasks", { method: "POST", body: JSON.stringify({ title: "w", body: "", labels: [], repo: "r" }) }))
  ).json()) as TaskCard;
  await app(
    req(`/tasks/${writeTask.id}/result`, {
      method: "POST",
      body: JSON.stringify({ agentId: "implementer", ok: true, summary: "opened a PR" }),
    }),
  );
  expect((await (await app(req(`/tasks/${writeTask.id}`))).json() as TaskCard).status).toBe("review");

  const readonlyTask = (await (
    await app(req("/tasks", { method: "POST", body: JSON.stringify({ title: "r", body: "", labels: [], repo: "r" }) }))
  ).json()) as TaskCard;
  await app(
    req(`/tasks/${readonlyTask.id}/result`, {
      method: "POST",
      body: JSON.stringify({ agentId: "triager", ok: true, summary: "triaged" }),
    }),
  );
  expect((await (await app(req(`/tasks/${readonlyTask.id}`))).json() as TaskCard).status).toBe("done");
});

test("GET /tasks/:id/result returns the most recent result, 404s with none", async () => {
  const app = await makeApp();
  const created = (await (
    await app(req("/tasks", { method: "POST", body: JSON.stringify({ title: "t", body: "", labels: [], repo: "r" }) }))
  ).json()) as TaskCard;

  const before = await app(req(`/tasks/${created.id}/result`));
  expect(before.status).toBe(404);

  await app(req(`/tasks/${created.id}/result`, { method: "POST", body: JSON.stringify({ agentId: "triager", ok: true, summary: "triaged" }) }));

  const after = await app(req(`/tasks/${created.id}/result`));
  expect(after.status).toBe(200);
  expect(((await after.json()) as TaskResult).summary).toBe("triaged");
});

test("GET /tasks/:id/diff reports isGitRepo: false for a task whose repo isn't a git working tree, 404s on unknown id", async () => {
  const app = await makeApp();
  const created = (await (
    await app(req("/tasks", { method: "POST", body: JSON.stringify({ title: "t", body: "", labels: [], repo: "/tmp" }) }))
  ).json()) as TaskCard;

  const res = await app(req(`/tasks/${created.id}/diff`));
  expect(res.status).toBe(200);
  const diff = (await res.json()) as { isGitRepo: boolean };
  expect(diff.isGitRepo).toBe(false);

  const missing = await app(req("/tasks/nope/diff"));
  expect(missing.status).toBe(404);
});

test("POST /tasks/:id/run routes and runs a task on the injected manual executor, 404s on unknown id", async () => {
  const seen: TaskCard[] = [];
  const app = await makeApp(new SqliteBoard(), {
    manualExecutors: [
      fakeWriteExecutor(async (task, agent) => {
        seen.push(task);
        return { taskId: task.id, agentId: agent.id, ok: true, summary: "opened a PR" };
      }),
    ],
  });

  const created = (await (
    await app(req("/tasks", { method: "POST", body: JSON.stringify({ title: "t", body: "", labels: ["code"], repo: "r" }) }))
  ).json()) as TaskCard;

  const run = await app(req(`/tasks/${created.id}/run`, { method: "POST" }));
  expect(run.status).toBe(202);

  // /run returns once the task is in flight, not once it's done — poll
  // for the background process() to land, same as the real board UI would.
  const deadline = Date.now() + 1000;
  let status: TaskCard["status"] = "inbox";
  while (Date.now() < deadline) {
    status = ((await (await app(req(`/tasks/${created.id}`))).json()) as TaskCard).status;
    if (status !== "inbox" && status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(status).toBe("review");
  expect(seen.map((t) => t.id)).toEqual([created.id]);

  const missing = await app(req("/tasks/nope/run", { method: "POST" }));
  expect(missing.status).toBe(404);
});

test("POST /tasks/:id/run 409s when a run for that task is already in flight", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const app = await makeApp(new SqliteBoard(), {
    manualExecutors: [
      fakeWriteExecutor(async (task, agent) => {
        await blocked;
        return { taskId: task.id, agentId: agent.id, ok: true, summary: "ok" };
      }),
    ],
  });

  const created = (await (
    await app(req("/tasks", { method: "POST", body: JSON.stringify({ title: "t", body: "", labels: ["code"], repo: "r" }) }))
  ).json()) as TaskCard;

  const first = await app(req(`/tasks/${created.id}/run`, { method: "POST" }));
  expect(first.status).toBe(202);

  const second = await app(req(`/tasks/${created.id}/run`, { method: "POST" }));
  expect(second.status).toBe(409);
  release();
});
