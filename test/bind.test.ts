import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BIND, isLoopback, OPEN_BIND_TASK_TITLE, resolveBind } from "../src/core/bind.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { raiseOpenBindTask } from "../src/services/open-bind-task.ts";

describe("isLoopback", () => {
  test.each(["127.0.0.1", "127.1.2.3", "localhost", "LOCALHOST", "::1", "[::1]"])("%s is loopback", (h) => {
    expect(isLoopback(h)).toBe(true);
  });
  test.each(["0.0.0.0", "::", "192.168.1.10", "10.0.0.1", "128.0.0.1", "127.0.0.256", "example.com", "localhost.example.com"])("%s is not", (h) => {
    expect(isLoopback(h)).toBe(false);
  });
});

describe("resolveBind", () => {
  test("defaults to loopback with nothing set", () => {
    expect(resolveBind({})).toEqual({ ok: true, hostname: DEFAULT_BIND, open: false });
    expect(resolveBind({ WISSEL_BIND: "  " })).toEqual({ ok: true, hostname: DEFAULT_BIND, open: false });
  });

  test("an explicit loopback bind needs no flag", () => {
    expect(resolveBind({ WISSEL_BIND: "::1" })).toEqual({ ok: true, hostname: "::1", open: false });
  });

  test("a wider bind without the flag refuses to start and says how to fix it", () => {
    const r = resolveBind({ WISSEL_BIND: "0.0.0.0" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("WISSEL_BIND=0.0.0.0");
    expect(r.error).toContain("WISSEL_ALLOW_OPEN_BIND=1");
  });

  test("the flag must be exactly on, not merely present", () => {
    expect(resolveBind({ WISSEL_BIND: "0.0.0.0", WISSEL_ALLOW_OPEN_BIND: "0" }).ok).toBe(false);
    expect(resolveBind({ WISSEL_BIND: "0.0.0.0", WISSEL_ALLOW_OPEN_BIND: "" }).ok).toBe(false);
  });

  test("a wider bind with the flag starts open, with a warning", () => {
    const r = resolveBind({ WISSEL_BIND: "0.0.0.0", WISSEL_ALLOW_OPEN_BIND: "1" });
    expect(r).toMatchObject({ ok: true, hostname: "0.0.0.0", open: true });
    if (r.ok && r.open) expect(r.warning).toContain("no sign-in");
  });

  test("the flag alone does not widen anything", () => {
    expect(resolveBind({ WISSEL_ALLOW_OPEN_BIND: "1" })).toEqual({ ok: true, hostname: DEFAULT_BIND, open: false });
  });
});

describe("raiseOpenBindTask", () => {
  test("lands in review, never inbox, and is not stacked on restart", async () => {
    const board = new SqliteBoard(":memory:");
    const first = await raiseOpenBindTask(board, "0.0.0.0", 8787);
    expect(first.created).toBe(true);
    expect(first.task.status).toBe("review");
    expect(first.task.title).toBe(OPEN_BIND_TASK_TITLE);
    expect(first.task.body).toContain("0.0.0.0");

    const second = await raiseOpenBindTask(board, "0.0.0.0", 8787);
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);
    expect((await board.list()).filter((t) => t.title === OPEN_BIND_TASK_TITLE)).toHaveLength(1);
  });

  test("a done one does not suppress a new one", async () => {
    const board = new SqliteBoard(":memory:");
    const first = await raiseOpenBindTask(board, "0.0.0.0", 8787);
    await board.move(first.task.id, "done");
    const again = await raiseOpenBindTask(board, "0.0.0.0", 8787);
    expect(again.created).toBe(true);
    expect(again.task.id).not.toBe(first.task.id);
  });
});

describe("server start", () => {
  test("a refused bind exits non-zero before opening the database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wissel-bind-"));
    try {
      const dbPath = join(dir, "board.sqlite");
      const proc = Bun.spawn(["bun", "run", "src/api/server.ts"], {
        env: { PATH: process.env.PATH ?? "", HOME: dir, WISSEL_BIND: "0.0.0.0", WISSEL_PORT: "1", WISSEL_DB_PATH: dbPath, WISSEL_TELEMETRY_PATH: join(dir, "t.jsonl") },
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = setTimeout(() => proc.kill(), 20_000);
      const code = await proc.exited;
      clearTimeout(timer);
      expect(code).toBe(1);
      expect(await new Response(proc.stderr).text()).toContain("refusing to start");
      expect(existsSync(dbPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
