import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WriteExecutor } from "../src/executors/write.ts";
import { ReadOnlyExecutor } from "../src/executors/readonly.ts";
import type { CommandRunner } from "../src/executors/claude-cli.ts";
import {
  buildSandboxSettings,
  GIT_WRITE_DENY,
  harnessConfigDirs,
  mergeAllowedDomains,
  probeSandbox,
  SANDBOX_ALLOWED_DOMAINS,
  sandboxStartupLines,
  type SandboxProbes,
} from "../src/executors/sandbox.ts";
import { grantError, readProjectAllowRules } from "../src/core/allowed-tools.ts";
import { finishResult } from "../src/core/orchestrator.ts";
import { Registry } from "../src/core/registry.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { TelemetryLog } from "../src/services/telemetry.ts";
import { Database } from "bun:sqlite";
import { SqliteProjectStore } from "../src/services/projects.ts";
import { domainError, validateProjectSettings } from "../src/services/project-settings.ts";
import type { AgentDef, Harness, TaskCard } from "../src/core/types.ts";

// The write-tier Bash sandbox (docs/SDD-write-tier-sandbox.md): the
// settings WriteExecutor passes, the fallback, project allow rules, the
// preflight and the telemetry trace.

const implementer: AgentDef = {
  id: "implementer",
  name: "Implementer",
  kind: "agent",
  tier: "write",
  description: "Writes code.",
  whenToUse: "Code.",
  tags: ["code"],
  executor: "handoff",
  inputs: ["task-card"],
  outputs: ["diff"],
  trustLevel: "high",
  toolAccess: ["read", "write", "bash"],
  costProfile: { model: "claude-fable-5-1", estUsdPerTask: 1 },
};
const triager: AgentDef = { ...implementer, id: "triager", tier: "readonly", executor: "readonly", toolAccess: ["read"] };

const RESULT = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", ...extra });

/** Fakes git (worktree creation) and captures the claude argv. */
function capture(stdout = RESULT()) {
  const seen: { cmd: string[] } = { cmd: [] };
  const runner: CommandRunner = async (cmd) => {
    if (cmd[0] === "git") return { stdout: "", stderr: "", exitCode: 0 };
    seen.cmd = cmd;
    return { stdout, stderr: "", exitCode: 0 };
  };
  return { runner, seen };
}

function flagValues(cmd: string[], flag: string): string[] {
  const i = cmd.indexOf(flag);
  if (i === -1) return [];
  const out: string[] = [];
  for (let j = i + 1; j < cmd.length && !cmd[j]!.startsWith("--"); j++) out.push(cmd[j]!);
  return out;
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "wissel-sandbox-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const ON = { state: "on" as const, problems: [] };

test("buildSandboxSettings: strict sandbox, exact deny/allow lists, git writes denied", () => {
  expect(buildSandboxSettings({ repo: "/r/wissel", extraDenyRead: ["/home/u/.claude-x", "~/.ssh"] })).toEqual({
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      filesystem: {
        denyRead: [
          "~/.ssh",
          "~/.aws",
          "~/.gnupg",
          "~/.config/gh",
          "~/.claude",
          "~/.claude.json",
          "~/.claude-adevinta",
          "~/.codex",
          "~/.wissel/board.sqlite*",
          "/home/u/.claude-x",
        ],
        denyWrite: ["/r/wissel/.git"],
      },
      network: { allowedDomains: ["registry.npmjs.org", "github.com"], strictAllowlist: true },
    },
    permissions: { deny: GIT_WRITE_DENY },
  });
  expect(GIT_WRITE_DENY).toContain("Bash(git commit *)");
  expect(GIT_WRITE_DENY).toContain("Bash(git push *)");
  expect(GIT_WRITE_DENY).toContain("Bash(git stash *)");
  // No setting that loosens the sandbox ever appears.
  const json = JSON.stringify(buildSandboxSettings({ repo: "/r" }));
  for (const loose of ["excludedCommands", "dangerouslyDisableSandbox", "allowWrite", "enableWeakerNestedSandbox", "allowAllUnixSockets", "allowLocalBinding"]) {
    expect(json).not.toContain(loose);
  }
});

// ---------- per-project allowed domains (docs/SDD-write-tier-sandbox.md §11) ----------

/** What finn-platform sets through POST /projects/:id/settings. */
const FINN_DOMAINS = ["pypi.org", "files.pythonhosted.org", "registry.terraform.io", "releases.hashicorp.com"];

test("mergeAllowedDomains: fixed hosts first, then the project's in order, each once; nothing given is today's list", () => {
  expect(mergeAllowedDomains()).toEqual(["registry.npmjs.org", "github.com"]);
  expect(mergeAllowedDomains([])).toEqual([...SANDBOX_ALLOWED_DOMAINS]);
  expect(mergeAllowedDomains(FINN_DOMAINS)).toEqual(["registry.npmjs.org", "github.com", ...FINN_DOMAINS]);
  // A project repeating a fixed host, or itself, adds nothing; the first
  // occurrence keeps its place.
  expect(mergeAllowedDomains(["github.com", "pypi.org", "pypi.org", "registry.npmjs.org", "*.hashicorp.com"])).toEqual([
    "registry.npmjs.org",
    "github.com",
    "pypi.org",
    "*.hashicorp.com",
  ]);
  expect(mergeAllowedDomains(["", "pypi.org"])).toEqual(["registry.npmjs.org", "github.com", "pypi.org"]);
  // The input is not mutated and the fixed list is not shared.
  const input = ["pypi.org"];
  const merged = mergeAllowedDomains(input);
  merged.push("evil.example");
  expect(input).toEqual(["pypi.org"]);
  expect(SANDBOX_ALLOWED_DOMAINS).toEqual(["registry.npmjs.org", "github.com"]);
  // Every host finn needs passes the settings validation that guards the list.
  for (const d of FINN_DOMAINS) expect(domainError(d)).toBeUndefined();
});

test("buildSandboxSettings: project domains land in network.allowedDomains, strict stays on; none given is byte-identical to today", () => {
  const base = buildSandboxSettings({ repo: "/r/finn" });
  expect(JSON.stringify(buildSandboxSettings({ repo: "/r/finn", allowedDomains: [] }))).toBe(JSON.stringify(base));
  expect(JSON.stringify(buildSandboxSettings({ repo: "/r/finn", allowedDomains: undefined }))).toBe(JSON.stringify(base));

  const withFinn = buildSandboxSettings({ repo: "/r/finn", allowedDomains: FINN_DOMAINS });
  expect((withFinn.sandbox as { network: unknown }).network).toEqual({
    allowedDomains: ["registry.npmjs.org", "github.com", ...FINN_DOMAINS],
    strictAllowlist: true,
  });
  // Only the network block differs from today's settings.
  const { sandbox: baseSandbox, ...baseRest } = base;
  const { sandbox: finnSandbox, ...finnRest } = withFinn;
  expect(finnRest).toEqual(baseRest);
  const { network: _b, ...baseSandboxRest } = baseSandbox as Record<string, unknown>;
  const { network: _f, ...finnSandboxRest } = finnSandbox as Record<string, unknown>;
  expect(finnSandboxRest).toEqual(baseSandboxRest);
});

/** A registered local project at `repo` (an existing directory) with
 *  the given settings body, in an in-memory store. */
async function projectWith(repo: string, body: unknown): Promise<SqliteProjectStore> {
  const store = new SqliteProjectStore(new Database(":memory:"));
  const added = await store.addLocalProject(repo, {}, async () => ({ stdout: "true", stderr: "", exitCode: 0 }));
  if ("error" in added) throw new Error(added.error);
  const check = validateProjectSettings(body);
  if (!check.ok) throw new Error(check.error);
  await store.setSettings(added.project.id, check.patch);
  return store;
}

test("settingsFor: by normalised path; undefined for an unregistered repo, no keys for a project with none set", async () => {
  await withTmp(async (dir) => {
    const repo = join(dir, "finn");
    await mkdir(repo);
    const store = await projectWith(repo, { sandboxAllowedDomains: FINN_DOMAINS, worktreeSetup: [["uv", "sync"]] });
    expect(await store.settingsFor(repo)).toEqual({ sandboxAllowedDomains: FINN_DOMAINS, worktreeSetup: [["uv", "sync"]] });
    expect(await store.settingsFor(`${repo}/`)).toEqual({ sandboxAllowedDomains: FINN_DOMAINS, worktreeSetup: [["uv", "sync"]] });
    expect(await store.settingsFor(join(repo, "..", "finn"))).toEqual({ sandboxAllowedDomains: FINN_DOMAINS, worktreeSetup: [["uv", "sync"]] });
    expect(await store.settingsFor(join(dir, "other"))).toBeUndefined();
    // Never the whole Project: only the four setting fields.
    const bare = new SqliteProjectStore(new Database(":memory:"));
    const added = await bare.addLocalProject(repo, {}, async () => ({ stdout: "true", stderr: "", exitCode: 0 }));
    if ("error" in added) throw new Error(added.error);
    expect(await bare.settingsFor(repo)).toEqual({});
  });
});

test("sandbox on: the project's sandboxAllowedDomains flow from POST /projects/:id/settings through WriteExecutor into --settings", async () => {
  await withTmp(async (dir) => {
    const repo = join(dir, "finn");
    await mkdir(repo);
    const home = join(dir, "home");
    // github.com repeated on purpose: it must not appear twice.
    const store = await projectWith(repo, { sandboxAllowedDomains: [...FINN_DOMAINS, "github.com"] });
    const lookups: string[] = [];
    const projectSettings = async (r: string) => {
      lookups.push(r);
      return store.settingsFor(r);
    };

    const { runner, seen } = capture();
    const task: TaskCard = { id: "t1", title: "T", body: "B", labels: [], repo, status: "dispatched" };
    const result = await new WriteExecutor({ homeDir: home, runner, sandbox: ON, projectSettings }).run(task, implementer);
    expect(result.sandbox).toBe("on");
    // Looked up by task.repo (the main checkout), not the worktree.
    expect(lookups).toEqual([repo]);
    const settings = JSON.parse(flagValues(seen.cmd, "--settings")[0]!);
    expect(settings.sandbox.network).toEqual({
      allowedDomains: ["registry.npmjs.org", "github.com", ...FINN_DOMAINS],
      strictAllowlist: true,
    });
    expect(settings).toEqual(buildSandboxSettings({ repo, extraDenyRead: [], allowedDomains: FINN_DOMAINS }));

    // A later edit takes effect on the next run, no restart.
    const check = validateProjectSettings({ sandboxAllowedDomains: ["pypi.org"] });
    if (!check.ok) throw new Error(check.error);
    await store.setSettings((await store.list())[0]!.id, check.patch);
    const second = capture();
    await new WriteExecutor({ homeDir: home, runner: second.runner, sandbox: ON, projectSettings }).run(task, implementer);
    expect(JSON.parse(flagValues(second.seen.cmd, "--settings")[0]!).sandbox.network.allowedDomains).toEqual(["registry.npmjs.org", "github.com", "pypi.org"]);

    // Cleared: today's list.
    await store.setSettings((await store.list())[0]!.id, { sandboxAllowedDomains: null });
    const third = capture();
    await new WriteExecutor({ homeDir: home, runner: third.runner, sandbox: ON, projectSettings }).run(task, implementer);
    expect(JSON.parse(flagValues(third.seen.cmd, "--settings")[0]!).sandbox.network.allowedDomains).toEqual(["registry.npmjs.org", "github.com"]);
  });
});

test("sandbox on, repo not a registered project or no lookup wired: today's --settings exactly", async () => {
  await withTmp(async (dir) => {
    const repo = join(dir, "finn");
    await mkdir(repo);
    const other = join(dir, "other");
    await mkdir(other);
    const home = join(dir, "home");
    const store = await projectWith(repo, { sandboxAllowedDomains: FINN_DOMAINS });
    const today = buildSandboxSettings({ repo: other, extraDenyRead: [] });

    const unregistered = capture();
    await new WriteExecutor({ homeDir: home, runner: unregistered.runner, sandbox: ON, projectSettings: (r) => store.settingsFor(r) }).run(
      { id: "t1", title: "T", body: "B", labels: [], repo: other, status: "dispatched" },
      implementer,
    );
    expect(JSON.parse(flagValues(unregistered.seen.cmd, "--settings")[0]!)).toEqual(today);

    const unwired = capture();
    await new WriteExecutor({ homeDir: home, runner: unwired.runner, sandbox: ON }).run({ id: "t1", title: "T", body: "B", labels: [], repo: other, status: "dispatched" }, implementer);
    expect(JSON.parse(flagValues(unwired.seen.cmd, "--settings")[0]!)).toEqual(today);
  });
});

test("sandbox off or unavailable: the project settings are never read and no --settings is passed", async () => {
  await withTmp(async (dir) => {
    const repo = join(dir, "finn");
    await mkdir(repo);
    const home = join(dir, "home");
    let lookups = 0;
    const projectSettings = async () => {
      lookups++;
      return { sandboxAllowedDomains: FINN_DOMAINS };
    };
    for (const sandbox of [undefined, { state: "off" as const, problems: [] }, { state: "unavailable" as const, problems: ["socat is not installed"] }]) {
      const { runner, seen } = capture();
      await new WriteExecutor({ homeDir: home, runner, sandbox, projectSettings }).run({ id: "t1", title: "T", body: "B", labels: [], repo, status: "dispatched" }, implementer);
      expect(seen.cmd).not.toContain("--settings");
      expect(seen.cmd.join(" ")).not.toContain("pypi.org");
    }
    expect(lookups).toBe(0);
  });
});

test("harnessConfigDirs collects CLAUDE_CONFIG_DIR and CODEX_HOME once each", () => {
  expect(
    harnessConfigDirs([{ CLAUDE_CONFIG_DIR: "/h/.claude-a" }, undefined, { CODEX_HOME: "/h/.codex" }, { CLAUDE_CONFIG_DIR: "/h/.claude-a" }]),
  ).toEqual(["/h/.claude-a", "/h/.codex"]);
});

test("sandbox on: WriteExecutor passes --settings with the harness's config dir denied, and records sandbox on", async () => {
  await withTmp(async (home) => {
    const { runner, seen } = capture(RESULT({ permission_denials: [{ tool_name: "Bash", tool_input: { command: "git commit -m x" } }] }));
    const executor = new WriteExecutor({ homeDir: home, runner, sandbox: ON, sandboxDenyRead: ["/home/u/.claude-other", "/home/u/.wissel/board.sqlite*"] });
    const harness = { id: "h", tool: "claude-cli", label: "h", enabled: true, env: { CLAUDE_CONFIG_DIR: "/home/u/.claude-run" } } as Harness;
    const task: TaskCard = { id: "t1", title: "T", body: "B", labels: [], repo: "/repo/main", status: "dispatched" };
    const result = await executor.run(task, implementer, harness);

    const settings = JSON.parse(flagValues(seen.cmd, "--settings")[0]!);
    expect(settings).toEqual(buildSandboxSettings({ repo: "/repo/main", extraDenyRead: ["/home/u/.claude-other", "/home/u/.wissel/board.sqlite*", "/home/u/.claude-run"] }));
    // Still acceptEdits, still the allowlist pair, still no unsandboxed path.
    expect(seen.cmd[seen.cmd.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(flagValues(seen.cmd, "--allowedTools").slice(0, 2)).toEqual(["Bash(bun test:*)", "Bash(bun run typecheck:*)"]);
    expect(seen.cmd.join(" ")).not.toContain("dangerously");
    expect(result.sandbox).toBe("on");
    expect(result.denials).toBe(1);
  });
});

test("sandbox unavailable: no --settings, allowlist only, recorded as unavailable", async () => {
  await withTmp(async (home) => {
    const { runner, seen } = capture();
    const executor = new WriteExecutor({ homeDir: home, runner, sandbox: { state: "unavailable", problems: ["socat is not installed"] } });
    const result = await executor.run({ id: "t1", title: "T", body: "B", labels: [], repo: "/tmp", status: "dispatched" }, implementer);
    expect(seen.cmd).not.toContain("--settings");
    expect(flagValues(seen.cmd, "--allowedTools")).toEqual(["Bash(bun test:*)", "Bash(bun run typecheck:*)"]);
    expect(result.sandbox).toBe("unavailable");
  });
});

test("no sandbox option (tests, evals): today's argv exactly, recorded as off", async () => {
  await withTmp(async (home) => {
    const { runner, seen } = capture();
    const result = await new WriteExecutor({ homeDir: home, runner }).run({ id: "t1", title: "T", body: "B", labels: [], repo: "/tmp", status: "dispatched" }, implementer);
    expect(seen.cmd).not.toContain("--settings");
    expect(result.sandbox).toBe("off");
  });
});

test("readonly executor is untouched: plan mode, no --settings, sandbox off", async () => {
  let cmd: string[] = [];
  const executor = new ReadOnlyExecutor({
    runner: async (c) => {
      cmd = c;
      return { stdout: RESULT(), stderr: "", exitCode: 0 };
    },
  });
  const result = await executor.run({ id: "t1", title: "T", body: "B", labels: [], repo: "/tmp", status: "dispatched" }, triager);
  expect(cmd[cmd.indexOf("--permission-mode") + 1]).toBe("plan");
  expect(cmd).not.toContain("--settings");
  expect(result.sandbox).toBe("off");
});

test("project allow rules: valid ones forwarded, invalid ones refused, worktree copy ignored", async () => {
  await withTmp(async (dir) => {
    const repo = join(dir, "repo");
    await mkdir(join(repo, ".claude"), { recursive: true });
    await writeFile(
      join(repo, ".claude", "settings.json"),
      JSON.stringify({
        permissions: {
          allow: ["Bash(bunx playwright test:*)", "Bash(bun run test:e2e:*)", "Bash(rm:*)", "Bash", "Read(~/.ssh/**)", "Bash(bun -e:*)", 7, "Bash(bunx playwright test:*)"],
        },
      }),
    );
    const rules = await readProjectAllowRules(repo);
    expect(rules.allowed).toEqual(["Bash(bunx playwright test:*)", "Bash(bun run test:e2e:*)"]);
    expect(rules.refused.map((r) => r.rule)).toEqual(["Bash(rm:*)", "Bash", "Read(~/.ssh/**)", "Bash(bun -e:*)"]);

    // This repo's own four rules all pass.
    const own = await readProjectAllowRules(process.cwd());
    expect(own.refused).toEqual([]);
    expect(own.allowed).toContain("Bash(bunx playwright test:*)");

    // Forwarded by WriteExecutor via --allowedTools, from task.repo (the
    // main checkout), after the base pair and the card's own grants.
    const home = join(dir, "home");
    const worktree = join(home, ".wissel", "worktrees", "t1");
    await mkdir(join(worktree, ".claude"), { recursive: true });
    await writeFile(join(worktree, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(bun install:*)"] } }));
    const { runner, seen } = capture();
    const task: TaskCard = { id: "t1", title: "T", body: "B", labels: [], repo, status: "dispatched", extraAllowedTools: ["Bash(bun run build:*)"] };
    await new WriteExecutor({ homeDir: home, runner }).run(task, implementer);
    expect(flagValues(seen.cmd, "--allowedTools")).toEqual([
      "Bash(bun test:*)",
      "Bash(bun run typecheck:*)",
      "Bash(bun run build:*)",
      "Bash(bunx playwright test:*)",
      "Bash(bun run test:e2e:*)",
    ]);
  });
});

test("readProjectAllowRules: missing, malformed or rule-less settings mean no rules", async () => {
  await withTmp(async (dir) => {
    expect(await readProjectAllowRules(join(dir, "nope"))).toEqual({ allowed: [], refused: [] });
    await mkdir(join(dir, ".claude"));
    await writeFile(join(dir, ".claude", "settings.json"), "{not json");
    expect(await readProjectAllowRules(dir)).toEqual({ allowed: [], refused: [] });
    await writeFile(join(dir, ".claude", "settings.json"), "null");
    expect(await readProjectAllowRules(dir)).toEqual({ allowed: [], refused: [] });
    await writeFile(join(dir, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: "Bash(ls)" } }));
    expect(await readProjectAllowRules(dir)).toEqual({ allowed: [], refused: [] });
  });
});

test("grantError is the per-entry form of validateExtraAllowedTools", () => {
  expect(grantError("Bash(bun install:*)")).toBeUndefined();
  expect(grantError("Bash(sudo ls)")).toContain("never granted");
  expect(grantError("Bash(npx cowsay)")).toContain("may only run");
});

/** Probes for a host where everything is in place; override per test. */
function probes(over: Partial<SandboxProbes> & { bins?: string[]; bwrapExit?: number; apparmor?: string | null } = {}): SandboxProbes & { ran: string[][] } {
  const bins = over.bins ?? ["bwrap", "socat"];
  const ran: string[][] = [];
  return {
    platform: over.platform ?? "linux",
    which: over.which ?? ((b) => (bins.includes(b) ? `/usr/bin/${b}` : null)),
    readFile: over.readFile ?? (async () => (over.apparmor === undefined ? "0\n" : over.apparmor)),
    run:
      over.run ??
      (async (cmd) => {
        ran.push(cmd);
        return over.bwrapExit ?? 0;
      }),
    ran,
  };
}

test("preflight: bwrap + socat + a working namespace is on, and runs bwrap for real", async () => {
  const p = probes();
  expect(await probeSandbox(p)).toEqual({ state: "on", problems: [] });
  expect(p.ran).toEqual([["/usr/bin/bwrap", "--ro-bind", "/", "/", "--unshare-user", "--unshare-net", "true"]]);
});

test("preflight: missing bwrap and socat are each named with their install command", async () => {
  const status = await probeSandbox(probes({ bins: [] }));
  expect(status.state).toBe("unavailable");
  expect(status.problems).toEqual([
    "bubblewrap is not installed (sudo apt-get install bubblewrap)",
    "socat is not installed (sudo apt-get install socat)",
  ]);
  const noSocat = await probeSandbox(probes({ bins: ["bwrap"] }));
  expect(noSocat.problems).toEqual(["socat is not installed (sudo apt-get install socat)"]);
});

test("preflight: the AppArmor userns restriction without a bwrap profile is detected", async () => {
  const status = await probeSandbox(probes({ bwrapExit: 1, apparmor: "1\n" }));
  expect(status.state).toBe("unavailable");
  expect(status.problems).toHaveLength(1);
  expect(status.problems[0]).toContain("kernel.apparmor_restrict_unprivileged_userns=1");
  expect(status.problems[0]).toContain("/etc/apparmor.d/bwrap");
  // Restriction on but the profile loaded: bwrap works, so it's on.
  expect((await probeSandbox(probes({ bwrapExit: 0, apparmor: "1\n" }))).state).toBe("on");
  // bwrap failing for another reason is reported with its exit code.
  expect((await probeSandbox(probes({ bwrapExit: 2, apparmor: null }))).problems).toEqual(["bwrap can't create a sandbox here (exit 2)"]);
});

test("preflight: macOS is on, other platforms unavailable, WISSEL_WRITE_SANDBOX=off is off", async () => {
  expect((await probeSandbox(probes({ platform: "darwin", bins: [] }))).state).toBe("on");
  expect(await probeSandbox(probes({ platform: "win32" }))).toEqual({ state: "unavailable", problems: ["the sandbox doesn't run on win32"] });
  const off = probes();
  expect((await probeSandbox(off, true)).state).toBe("off");
  expect(off.ran).toEqual([]);
});

test("startup lines: unavailable is loud and names every problem", () => {
  expect(sandboxStartupLines(ON)[0]).toContain("on");
  const lines = sandboxStartupLines({ state: "unavailable", problems: ["a", "b"] });
  expect(lines[0]).toContain("UNAVAILABLE");
  expect(lines.slice(1)).toEqual(["!!!   a", "!!!   b"]);
});

test("every write-tier agent's contract steers it to the file tools and plain test commands; readonly agents get none of it", async () => {
  const registry = await Registry.load();
  const write = registry.all().filter((a) => a.tier === "write");
  expect(write.map((a) => a.id).sort()).toEqual(["fixer", "implementer", "integrator", "lint-fixer"]);
  for (const a of write) {
    const c = a.verificationContract ?? "";
    expect({ id: a.id, steers: ["Read, Grep and Glob", "Edit and Write", "no pipes, no `time`, no", "`bun -e` or `node -e`"].every((s) => c.includes(s)) }).toEqual({ id: a.id, steers: true });
  }
  for (const a of registry.all().filter((a) => a.tier !== "write")) expect(a.verificationContract ?? "").not.toContain("Read, Grep and Glob");
});

test("telemetry: the result event carries the raw denial count and the sandbox state", async () => {
  await withTmp(async (dir) => {
    const board = new SqliteBoard();
    const registry = Registry.from([triager]);
    const telemetry = new TelemetryLog(join(dir, "t.jsonl"));
    const card = await board.create({ title: "x", body: "", labels: [] });
    // Three raw denials, two of them the same command: denials is 3,
    // permissionDenials (the keys) is 1.
    const same = { tool_name: "Bash", tool_input: { command: "bun install" } };
    const result = await new ReadOnlyExecutor({
      runner: async () => ({ stdout: RESULT({ permission_denials: [same, same, same] }), stderr: "", exitCode: 0 }),
    }).run(card, triager);
    expect(result.permissionDenials).toEqual(["Bash: bun install"]);
    await finishResult(board, registry, result, telemetry);
    const [event] = (await readFile(join(dir, "t.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(event.type).toBe("result");
    expect(event.denials).toBe(3);
    expect(event.sandbox).toBe("off");
  });
});
