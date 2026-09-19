import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkClaudeCliAuth, discoverHarnesses, validateHarness } from "../src/core/harness-discovery.ts";
import type { CommandRunner } from "../src/executors/claude-cli.ts";
import type { Harness } from "../src/core/types.ts";

/** A fake $HOME with the given `.claude*`-named subdirectories, cleaned
 *  up by the caller. Mirrors this machine's own layout (a logged-in
 *  ~/.claude-personal alongside an untouched default ~/.claude) closely
 *  enough to exercise the real heuristic, without touching the real
 *  filesystem or spawning a real `claude` process. */
async function fakeHome(dirNames: string[]): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "wissel-harness-discovery-"));
  for (const name of dirNames) await mkdir(join(home, name));
  return home;
}

function statusFor(loggedInDirs: Record<string, { loggedIn: boolean; email?: string }>): CommandRunner {
  return async (_cmd, opts) => {
    const configDir = opts.env?.CLAUDE_CONFIG_DIR ?? "";
    const status = Object.entries(loggedInDirs).find(([dir]) => configDir.endsWith(dir))?.[1];
    if (!status) return { stdout: "", stderr: "not found", exitCode: 1 };
    return { stdout: JSON.stringify(status), stderr: "", exitCode: 0 };
  };
}

test("returns a Harness only for candidate dirs claude auth status reports as logged in", async () => {
  const home = await fakeHome([".claude", ".claude-personal", ".not-claude-at-all"]);
  try {
    const runner = statusFor({
      ".claude": { loggedIn: false },
      ".claude-personal": { loggedIn: true, email: "milton.cyrus@gmail.com" },
    });
    const harnesses = await discoverHarnesses({ runner, homeDir: home });
    expect(harnesses).toEqual([
      {
        id: "claude-personal",
        tool: "claude-cli",
        label: "Claude — milton.cyrus@gmail.com",
        enabled: true,
        env: { CLAUDE_CONFIG_DIR: join(home, ".claude-personal") },
      },
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("falls back to the derived id as the label when no email is reported", async () => {
  const home = await fakeHome([".claude-work"]);
  try {
    const runner = statusFor({ ".claude-work": { loggedIn: true } });
    const harnesses = await discoverHarnesses({ runner, homeDir: home });
    expect(harnesses[0]!.label).toBe("claude-work");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("an unreadable $HOME degrades to zero discovered harnesses, never a throw", async () => {
  const harnesses = await discoverHarnesses({ homeDir: "/definitely/does/not/exist", runner: async () => ({ stdout: "", stderr: "", exitCode: 0 }) });
  expect(harnesses).toEqual([]);
});

test("a runner that throws for one candidate doesn't take down the others", async () => {
  const home = await fakeHome([".claude-a", ".claude-b"]);
  try {
    const runner: CommandRunner = async (_cmd, opts) => {
      if (opts.env?.CLAUDE_CONFIG_DIR?.endsWith(".claude-a")) throw new Error("ENOENT");
      return { stdout: JSON.stringify({ loggedIn: true, email: "b@example.com" }), stderr: "", exitCode: 0 };
    };
    const harnesses = await discoverHarnesses({ runner, homeDir: home });
    expect(harnesses.map((h) => h.id)).toEqual(["claude-b"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("checkClaudeCliAuth reports authenticated + email on a logged-in status", async () => {
  const runner: CommandRunner = async () => ({ stdout: JSON.stringify({ loggedIn: true, email: "a@example.com" }), stderr: "", exitCode: 0 });
  expect(await checkClaudeCliAuth(runner, "/tmp")).toEqual({ authenticated: true, email: "a@example.com" });
});

test("checkClaudeCliAuth reports not authenticated on loggedIn: false, non-zero exit, and a throw", async () => {
  const notLoggedIn: CommandRunner = async () => ({ stdout: JSON.stringify({ loggedIn: false }), stderr: "", exitCode: 0 });
  const nonZero: CommandRunner = async () => ({ stdout: "", stderr: "no config", exitCode: 1 });
  const throws: CommandRunner = async () => { throw new Error("ENOENT"); };

  expect((await checkClaudeCliAuth(notLoggedIn, "/tmp")).authenticated).toBe(false);
  expect((await checkClaudeCliAuth(nonZero, "/tmp")).authenticated).toBe(false);
  expect((await checkClaudeCliAuth(throws, "/tmp")).authenticated).toBe(false);
});

function harness(overrides: Partial<Harness> & Pick<Harness, "id">): Harness {
  return { tool: "claude-cli", label: overrides.id, enabled: true, ...overrides };
}

test("validateHarness keeps an entry enabled when its declared env is actually authenticated", async () => {
  const runner: CommandRunner = async (_cmd, opts) =>
    opts.env?.CLAUDE_CONFIG_DIR === "/real/path"
      ? { stdout: JSON.stringify({ loggedIn: true }), stderr: "", exitCode: 0 }
      : { stdout: JSON.stringify({ loggedIn: false }), stderr: "", exitCode: 0 };

  const h = harness({ id: "real", env: { CLAUDE_CONFIG_DIR: "/real/path" } });
  expect(await validateHarness(h, { runner })).toEqual(h);
});

test("validateHarness disables an entry whose declared env is not authenticated (the checked-in-wrong-machine case)", async () => {
  const runner: CommandRunner = async () => ({ stdout: JSON.stringify({ loggedIn: false }), stderr: "", exitCode: 0 });
  const h = harness({ id: "claude-personal", env: { CLAUDE_CONFIG_DIR: "/Users/milton.cyrus/.claude-personal" } });

  const result = await validateHarness(h, { runner });

  expect(result).toEqual({ ...h, enabled: false });
});

test("validateHarness leaves an already-disabled entry alone without probing", async () => {
  let calls = 0;
  const runner: CommandRunner = async () => {
    calls++;
    return { stdout: JSON.stringify({ loggedIn: true }), stderr: "", exitCode: 0 };
  };
  const h = harness({ id: "off", enabled: false });

  expect(await validateHarness(h, { runner })).toEqual(h);
  expect(calls).toBe(0);
});
