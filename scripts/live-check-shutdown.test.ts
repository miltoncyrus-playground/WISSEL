/**
 * Live check for docs/SDD-crash-recovery.md §10: a real server, a real
 * agent spawn, a real SIGTERM, and no agent process left behind.
 *
 *   bun run live-check:shutdown   (= bun test scripts/live-check-shutdown.test.ts)
 *
 * Deliberately outside test/ so the gate lane (`bun test test/`) never
 * runs it: it boots a whole server process and takes a few seconds.
 *
 * Puts a fake `claude` first on PATH (any `claude -p` run becomes
 * `exec sleep 300`), starts the server on a spare port
 * (LIVE_CHECK_PORT, default 8799) against an in-memory board, creates a
 * task and runs it, waits for the `sleep` child to appear under the
 * server, sends the server SIGTERM, and asserts that child is gone.
 * Linux only (reads /proc to find the child).
 */
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.LIVE_CHECK_PORT ?? 8799);
const base = `http://localhost:${PORT}`;
const repoRoot = join(import.meta.dir, "..");
const serverEntry = join(repoRoot, "src", "api", "server.ts");

function sh(cmd: string[], cwd: string): void {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "ignore", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
}

function ppidOf(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  } catch {
    return undefined;
  }
}

function sleepChildrenOf(parent: number): number[] {
  return readdirSync("/proc")
    .filter((e) => /^\d+$/.test(e))
    .map(Number)
    .filter((pid) => {
      try {
        const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
        return argv[0] === "sleep" && argv[1] === "300" && ppidOf(pid) === parent;
      } catch {
        return false;
      }
    });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return !readFileSync(`/proc/${pid}/stat`, "utf8").includes(") Z ");
  } catch {
    return false;
  }
}

async function until<T>(what: string, fn: () => T | undefined | Promise<T | undefined>, ms: number): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== undefined) return v;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

test.skipIf(process.platform !== "linux")(
  "SIGTERM to a real server kills its running agent subprocess",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "wissel-live-check-"));
    const bin = join(dir, "bin");
    const repo = join(dir, "repo");
    mkdirSync(bin);
    mkdirSync(repo);
    // HOME is this temp dir, so harness autoload finds exactly one
    // claude-cli account (.claude) and nothing of the real machine's.
    mkdirSync(join(dir, ".claude"));
    writeFileSync(
      join(bin, "claude"),
      [
        "#!/bin/sh",
        `case " $* " in *" auth status "*) echo '{"loggedIn":true,"email":"live@check"}'; exit 0 ;; esac`,
        `case " $* " in *" -p "*) exec sleep 300 ;; esac`,
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "claude"), 0o755);
    sh(["git", "init", "-q"], repo);
    sh(["git", "-c", "user.email=l@c", "-c", "user.name=lc", "commit", "-q", "--allow-empty", "-m", "init"], repo);

    const server = Bun.spawn(["bun", "run", serverEntry], {
      cwd: repoRoot, // agents/manifest.yaml is loaded relative to cwd
      env: {
        // Ambient WISSEL_* (orchestrator, memory curation, ...) would
        // start background work that has nothing to do with this check.
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("WISSEL_"))),
        HOME: dir,
        PATH: `${bin}:${process.env.PATH}`,
        WISSEL_PORT: String(PORT),
        WISSEL_DB_PATH: ":memory:",
        WISSEL_HARNESSES_PATH: join(dir, "harnesses.yaml"),
        WISSEL_MCP_SERVERS_PATH: join(dir, "mcp-servers.yaml"),
        WISSEL_TELEMETRY_PATH: join(dir, "telemetry.jsonl"),
        WISSEL_MEMORY_PATH: join(dir, "lessons.md"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const serverLog = Promise.all([new Response(server.stdout).text(), new Response(server.stderr).text()]).then(([o, e]) => o + e);

    let sleepPid: number | undefined;
    try {
      await until("server up", async () => ((await fetch(`${base}/tasks`).catch(() => undefined))?.ok ? true : undefined), 15000);
      const created = (await (
        await fetch(`${base}/tasks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          // `intake` routes straight to the read-only triager (claude-cli).
          body: JSON.stringify({ title: "live check", body: "triage this", labels: ["intake"], repo }),
        })
      ).json()) as { id: string };
      const run = await fetch(`${base}/tasks/${created.id}/run`, { method: "POST" });
      console.log(`task ${created.id}: POST /run -> ${run.status}`);

      [sleepPid] = await until("sleep child under the server", () => {
        const kids = sleepChildrenOf(server.pid);
        return kids.length ? kids : undefined;
      }, 15000);
      console.log(`server ${server.pid} has agent child sleep ${sleepPid}; sending SIGTERM`);

      server.kill("SIGTERM");
      const code = await server.exited;
      await Bun.sleep(300);
      console.log(`server exited ${code}; sleep ${sleepPid} ${alive(sleepPid!) ? "SURVIVED" : "is gone"}`);
      console.log((await serverLog).split("\n").filter((l) => l.startsWith("shutdown:")).join("\n") || "(no shutdown: lines)");

      expect(code).toBe(143);
      expect(alive(sleepPid!)).toBe(false);
      expect(sleepChildrenOf(server.pid)).toEqual([]);
    } catch (e) {
      const tasks = await fetch(`${base}/tasks`).then((r) => r.text()).catch(() => "(board unreachable)");
      server.kill("SIGKILL");
      console.error(`board: ${tasks}\n--- server log\n${await serverLog}`);
      throw e;
    } finally {
      server.kill("SIGKILL");
      if (sleepPid !== undefined && alive(sleepPid)) process.kill(sleepPid, "SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  },
  45000,
);
