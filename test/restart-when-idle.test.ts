import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { Router } from "../src/core/router.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { Orchestrator } from "../src/core/orchestrator.ts";
import { detectSupervisor, RESTART_EXIT_CODE, RestartWhenIdle } from "../src/services/restart-when-idle.ts";
import type { AgentDef, Executor } from "../src/core/types.ts";

// docs/SDD-coordinator.md §4.12, phase 1 card 5: stop new dispatches,
// wait for running cards, exit 75 for the supervisor to start Wissel
// again; refuse when nothing would.

function restartWith(running: () => number, supervisor: "systemd" | "script" | null = "systemd") {
  const exits: number[] = [];
  const lines: string[] = [];
  const r = new RestartWhenIdle({ runningCount: async () => running(), supervisor: supervisor ?? undefined, exit: (c) => void exits.push(c), log: (l) => void lines.push(l), pollMs: 60_000, now: () => new Date("2026-11-27T12:00:00Z") });
  return { r, exits, lines };
}

describe("detectSupervisor", () => {
  test("systemd from INVOCATION_ID, the wrapper from WISSEL_SUPERVISOR, otherwise none", () => {
    expect(detectSupervisor({ INVOCATION_ID: "abc" })).toBe("systemd");
    expect(detectSupervisor({ WISSEL_SUPERVISOR: "script" })).toBe("script");
    expect(detectSupervisor({ WISSEL_SUPERVISOR: "script", INVOCATION_ID: "abc" })).toBe("script");
    expect(detectSupervisor({})).toBeUndefined();
    expect(detectSupervisor({ INVOCATION_ID: " " })).toBeUndefined();
  });
});

describe("RestartWhenIdle", () => {
  test("refuses with no supervisor, and holds nothing", async () => {
    const { r, exits } = restartWith(() => 0, null);
    const out = await r.request();
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error).toContain("nothing would start Wissel again");
    expect(r.holding()).toBeUndefined();
    expect(exits).toEqual([]);
  });

  test("an idle board exits 75 at once", async () => {
    const { r, exits } = restartWith(() => 0);
    await r.request();
    expect(exits).toEqual([RESTART_EXIT_CODE]);
  });

  test("with cards running it holds new work and waits; the last one finishing triggers the exit", async () => {
    let running = 2;
    const { r, exits, lines } = restartWith(() => running);
    const out = await r.request();
    expect(out.ok && out.state).toEqual({ pending: true, requestedAt: "2026-11-27T12:00:00.000Z", running: 2, supervisor: "systemd" });
    expect(r.holding()).toContain("a restart is pending");
    expect(exits).toEqual([]);
    running = 1;
    await r.check();
    expect(exits).toEqual([]);
    running = 0;
    await r.check();
    await r.check();
    expect(exits).toEqual([75]);
    expect(lines.at(-1)).toContain("exiting with 75 for the systemd supervisor");
    await r.cancel();
  });

  test("cancel releases the hold and nothing exits", async () => {
    let running = 1;
    const { r, exits } = restartWith(() => running);
    await r.request();
    expect((await r.cancel()).pending).toBe(false);
    expect(r.holding()).toBeUndefined();
    running = 0;
    await r.check();
    expect(exits).toEqual([]);
  });
});

describe("while a restart is pending", () => {
  const agent: AgentDef = {
    id: "reader",
    name: "reader",
    kind: "agent",
    tier: "readonly",
    description: "t",
    whenToUse: "t",
    tags: ["intake"],
    executor: "readonly",
    inputs: [],
    outputs: [],
    trustLevel: "low",
    toolAccess: ["read"],
    costProfile: { model: "claude-sonnet-5-5", estUsdPerTask: 0.01 },
  };

  test("the sweep starts nothing and Run is refused; after cancel both work again", async () => {
    const ran: string[] = [];
    const exec: Executor = { id: "fake", canHandle: () => true, run: async (t, a) => (ran.push(t.title), { taskId: t.id, agentId: a.id, ok: true, summary: "ok" }) };
    let hold: string | undefined = "a restart is pending";
    const board = new SqliteBoard();
    const registry = Registry.from([agent]);
    const orch = new Orchestrator(board, registry, new Router(registry), [exec], undefined, { holdNewWork: () => hold });
    const card = await board.create({ title: "queued", body: "", labels: ["intake"], repo: "r" });
    await orch.sweep();
    expect(ran).toEqual([]);
    await expect(orch.runNow(card.id, [exec])).rejects.toThrow("a restart is pending");
    hold = undefined;
    await orch.sweep();
    expect(ran).toEqual(["queued"]);
  });

  test("the API: GET shows the state, POST asks (409 with no supervisor), DELETE cancels; Run and pipeline runs answer 409", async () => {
    const exits: number[] = [];
    const board = new SqliteBoard();
    const restart = new RestartWhenIdle({ runningCount: async () => (await board.list({ status: "running" })).length, supervisor: "script", exit: (c) => void exits.push(c), log: () => {}, pollMs: 60_000 });
    const app = createApp(board, Registry.from([agent]), undefined, { harnesses: HarnessPool.from([]), restart });
    const call = (method: string, path: string, body?: unknown) => app(new Request(`http://x${path}`, { method, ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }));

    const busy = await board.create({ title: "busy", body: "", labels: [], repo: "r" });
    await board.move(busy.id, "running");
    const queued = await board.create({ title: "queued", body: "", labels: ["intake"], repo: "r" });
    expect(await (await call("GET", "/admin/restart-when-idle")).json()).toEqual({ pending: false, running: 1, supervisor: "script" });
    const asked = await call("POST", "/admin/restart-when-idle");
    expect(asked.status).toBe(202);
    expect(exits).toEqual([]);
    const run = await call("POST", `/tasks/${queued.id}/run`);
    expect(run.status).toBe(409);
    expect(((await run.json()) as { error: string }).error).toContain("a restart is pending");
    const pipeline = await call("POST", "/pipelines/whatever/run", { repo: "r", input: "x" });
    expect([404, 409]).toContain(pipeline.status);

    // The running card finishing is a board event, which triggers the exit.
    await board.move(busy.id, "done");
    await new Promise((r) => setTimeout(r, 20));
    expect(exits).toEqual([75]);
    expect((await (await call("DELETE", "/admin/restart-when-idle")).json()).pending).toBe(false);

    const none = createApp(new SqliteBoard(), Registry.from([agent]), undefined, {
      harnesses: HarnessPool.from([]),
      restart: new RestartWhenIdle({ runningCount: async () => 0, supervisor: undefined, exit: (c) => void exits.push(c), log: () => {} }),
    });
    expect((await none(new Request("http://x/admin/restart-when-idle", { method: "POST" }))).status).toBe(409);
  });
});

describe("scripts/serve-supervised.sh", () => {
  test("starts serve again after exit 75, stops on any other code with that code, and marks itself as the supervisor", () => {
    const dir = mkdtempSync(join(tmpdir(), "wissel-supervised-"));
    try {
      // A fake `bun`: exits 75 on its first run, 3 on its second, and
      // records its arguments and WISSEL_SUPERVISOR each time.
      writeFileSync(
        join(dir, "bun"),
        `#!/bin/sh\nn=$(cat "${dir}/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${dir}/n"\necho "$* $WISSEL_SUPERVISOR" >> "${dir}/calls"\n[ $n -eq 1 ] && exit 75\nexit 3\n`,
      );
      chmodSync(join(dir, "bun"), 0o755);
      const r = Bun.spawnSync(["sh", join(import.meta.dir, "..", "scripts", "serve-supervised.sh")], { env: { PATH: `${dir}:/usr/bin:/bin` } });
      expect(r.exitCode).toBe(3);
      expect(readFileSync(join(dir, "calls"), "utf8").trim().split("\n")).toEqual(["run serve script", "run serve script"]);
      expect(r.stderr.toString()).toContain("asked to restart (exit 75)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
