import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkClaudeCliAuth,
  checkCodexCliAuth,
  discoverApiKeyHarnesses,
  discoverCodexHarnesses,
  discoverHarnesses,
  validateHarness,
} from "../src/core/harness-discovery.ts";
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

// Reproduces a real bug found while adding the anthropic-api harness:
// the real `claude auth status` treats ANY set ANTHROPIC_API_KEY as
// valid auth (authMethod: "api_key") independent of CLAUDE_CONFIG_DIR
// — confirmed by hand against the real binary. Once wissel started
// holding an ANTHROPIC_API_KEY for its own separate anthropic-api
// harness, that key leaked into every claude-cli probe's spawned
// environment and made every CLAUDE_CONFIG_DIR read as authenticated,
// including ones that were never logged into. This fake mirrors that
// real behavior: loggedIn: true whenever it sees a non-empty API key
// in the env it's given, regardless of CLAUDE_CONFIG_DIR.
function apiKeyLeakSensitiveRunner(): CommandRunner {
  return async (_cmd, opts) => {
    if (opts.env?.ANTHROPIC_API_KEY) {
      return { stdout: JSON.stringify({ loggedIn: true }), stderr: "", exitCode: 0 };
    }
    return { stdout: JSON.stringify({ loggedIn: false }), stderr: "", exitCode: 1 };
  };
}

test("checkClaudeCliAuth always scrubs ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN before probing, so wissel's own key can't leak into a claude-cli auth check", async () => {
  const runner = apiKeyLeakSensitiveRunner();
  // Passed explicitly, exactly as a real caller's own process.env would
  // carry it through the runner's ambient-merge behavior.
  const result = await checkClaudeCliAuth(runner, "/tmp", { CLAUDE_CONFIG_DIR: "/never/logged/in", ANTHROPIC_API_KEY: "sk-ant-real-key" });
  expect(result.authenticated).toBe(false);
});

test("discoverHarnesses never reports a candidate as logged in purely because ANTHROPIC_API_KEY leaked into the probe", async () => {
  const home = await fakeHome([".claude-never-logged-in"]);
  try {
    const harnesses = await discoverHarnesses({ runner: apiKeyLeakSensitiveRunner(), homeDir: home });
    expect(harnesses).toEqual([]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
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

  expect(result).toEqual({ ...h, enabled: false, disabledReason: "not authenticated" });
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

test("discoverApiKeyHarnesses finds ANTHROPIC_API_KEY and every named variant, ignoring unrelated/empty vars", () => {
  const harnesses = discoverApiKeyHarnesses({
    env: {
      ANTHROPIC_API_KEY: "sk-ant-bare",
      ANTHROPIC_API_KEY_PERSONAL: "sk-ant-personal",
      ANTHROPIC_API_KEY_WORK: "",
      SOME_OTHER_VAR: "sk-ant-unrelated",
    },
  });

  expect(harnesses).toEqual([
    { id: "anthropic-api", tool: "anthropic-api", label: "Anthropic API", enabled: true, apiKeyEnv: "ANTHROPIC_API_KEY" },
    { id: "anthropic-api-personal", tool: "anthropic-api", label: "Anthropic API — PERSONAL", enabled: true, apiKeyEnv: "ANTHROPIC_API_KEY_PERSONAL" },
  ]);
});

test("discoverApiKeyHarnesses returns nothing when no matching env var is set", () => {
  expect(discoverApiKeyHarnesses({ env: {} })).toEqual([]);
});

test("validateHarness keeps an anthropic-api entry enabled when its apiKeyEnv is set", async () => {
  const h: Harness = { id: "personal", tool: "anthropic-api", label: "Personal", enabled: true, apiKeyEnv: "MY_KEY" };
  expect(await validateHarness(h, { env: { MY_KEY: "sk-ant-x" } })).toEqual(h);
});

test("validateHarness disables an anthropic-api entry whose apiKeyEnv isn't set here (the same checked-in-wrong-machine case, for API keys)", async () => {
  const h: Harness = { id: "personal", tool: "anthropic-api", label: "Personal", enabled: true, apiKeyEnv: "MY_KEY" };
  const result = await validateHarness(h, { env: {} });
  expect(result).toEqual({ ...h, enabled: false, disabledReason: "not authenticated" });
});

test("validateHarness trusts an anthropic-api entry with no apiKeyEnv at all — ambient resolution, same as every other unconfigured case", async () => {
  const h: Harness = { id: "ambient", tool: "anthropic-api", label: "Ambient", enabled: true };
  expect(await validateHarness(h, { env: {} })).toEqual(h);
});

// codex-cli's own auth-status output isn't JSON (§5 of
// docs/SDD-codex-cli-harness.md — codex login status has no reliable
// --json support on this version), so the fake runner here returns one
// of the four fixed plain-text lines instead of a JSON blob.
function codexStatusFor(loggedInDirs: Record<string, string>): CommandRunner {
  return async (_cmd, opts) => {
    const configDir = opts.env?.CODEX_HOME ?? "";
    const line = Object.entries(loggedInDirs).find(([dir]) => configDir.endsWith(dir))?.[1];
    if (line === undefined) return { stdout: "Not logged in", stderr: "", exitCode: 0 };
    return { stdout: line, stderr: "", exitCode: 0 };
  };
}

test("discoverCodexHarnesses returns a Harness only for candidate dirs codex login status reports as logged in", async () => {
  const home = await fakeHome([".codex", ".codex-personal", ".not-codex-at-all"]);
  try {
    const runner = codexStatusFor({
      ".codex": "Not logged in",
      ".codex-personal": "Logged in using ChatGPT",
    });
    const harnesses = await discoverCodexHarnesses({ runner, homeDir: home });
    expect(harnesses).toEqual([
      {
        id: "codex-personal",
        tool: "codex-cli",
        label: "Codex — ChatGPT",
        enabled: true,
        env: { CODEX_HOME: join(home, ".codex-personal") },
      },
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("discoverCodexHarnesses falls back to the derived id as the label when the logged-in string doesn't match any known auth mode", async () => {
  const home = await fakeHome([".codex-future"]);
  try {
    const runner = codexStatusFor({ ".codex-future": "Logged in using some future auth method" });
    const harnesses = await discoverCodexHarnesses({ runner, homeDir: home });
    expect(harnesses[0]!.label).toBe("codex-future");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("discoverCodexHarnesses degrades to zero discovered harnesses on an unreadable $HOME or a runner that throws, never a crash", async () => {
  const unreadable = await discoverCodexHarnesses({ homeDir: "/definitely/does/not/exist", runner: async () => ({ stdout: "", stderr: "", exitCode: 0 }) });
  expect(unreadable).toEqual([]);

  const home = await fakeHome([".codex-a"]);
  try {
    const harnesses = await discoverCodexHarnesses({
      runner: async () => {
        throw new Error("ENOENT");
      },
      homeDir: home,
    });
    expect(harnesses).toEqual([]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("checkCodexCliAuth reports authenticated + the matched auth mode for each of the three known logged-in strings", async () => {
  for (const [line, authMode] of [
    ["Logged in using an API key", "API key"],
    ["Logged in using ChatGPT", "ChatGPT"],
    ["Logged in using Agent Identity", "Agent Identity"],
  ] as const) {
    const runner: CommandRunner = async () => ({ stdout: line, stderr: "", exitCode: 0 });
    expect(await checkCodexCliAuth(runner, "/tmp")).toEqual({ authenticated: true, authMode });
  }
});

test("checkCodexCliAuth reports not authenticated on 'Not logged in', non-zero exit, and a throw", async () => {
  const notLoggedIn: CommandRunner = async () => ({ stdout: "Not logged in", stderr: "", exitCode: 0 });
  const nonZero: CommandRunner = async () => ({ stdout: "", stderr: "no config", exitCode: 1 });
  const throws: CommandRunner = async () => {
    throw new Error("ENOENT");
  };

  expect((await checkCodexCliAuth(notLoggedIn, "/tmp")).authenticated).toBe(false);
  expect((await checkCodexCliAuth(nonZero, "/tmp")).authenticated).toBe(false);
  expect((await checkCodexCliAuth(throws, "/tmp")).authenticated).toBe(false);
});

test("validateHarness keeps a codex-cli entry enabled when its declared env is actually authenticated", async () => {
  const runner: CommandRunner = async (_cmd, opts) =>
    opts.env?.CODEX_HOME === "/real/path" ? { stdout: "Logged in using ChatGPT", stderr: "", exitCode: 0 } : { stdout: "Not logged in", stderr: "", exitCode: 0 };

  const h: Harness = { id: "codex-real", tool: "codex-cli", label: "codex-real", enabled: true, env: { CODEX_HOME: "/real/path" } };
  expect(await validateHarness(h, { runner })).toEqual(h);
});

test("validateHarness disables a codex-cli entry whose declared env is not authenticated (the checked-in-wrong-machine case)", async () => {
  const runner: CommandRunner = async () => ({ stdout: "Not logged in", stderr: "", exitCode: 0 });
  const h: Harness = { id: "codex-personal", tool: "codex-cli", label: "codex-personal", enabled: true, env: { CODEX_HOME: "~/.codex" } };

  const result = await validateHarness(h, { runner });
  expect(result).toEqual({ ...h, enabled: false, disabledReason: "not authenticated" });
});
