import { expect, test } from "bun:test";
import type { Harness } from "../src/core/types.ts";
import type { CommandRunner } from "../src/executors/claude-cli.ts";
import { CLAUDE_CLI_STATIC_MODELS } from "../src/core/model-catalog.ts";
import { formatTable, isCorporate, judge, parseArgs, refusal, sameModel, verifyModels, type VerifyArgs } from "../scripts/verify-claude-models.ts";

// scripts/verify-claude-models.ts: the manual, token-spending model
// probe. Everything here runs on an injected runner; nothing spawns claude.

const claude: Harness = { id: "claude", tool: "claude-cli", label: "Claude", enabled: true, env: { CLAUDE_CONFIG_DIR: "/home/x/.claude" } };
const work: Harness = { id: "claude-work", tool: "claude-cli", label: "Corp", enabled: true, env: { CLAUDE_CONFIG_DIR: "/home/x/.claude-work" } };
const args = (a: string[]) => parseArgs(a) as VerifyArgs;
const okJson = (model: string) => JSON.stringify({ is_error: false, result: "ok", modelUsage: { [model]: { inputTokens: 3 } } });

test("parseArgs defaults to harness claude and the full static list", () => {
  expect(parseArgs([])).toEqual({ harness: "claude", explicitHarness: false, models: CLAUDE_CLI_STATIC_MODELS });
});

test("parseArgs reads --harness and --models", () => {
  expect(parseArgs(["--harness", "claude-personal", "--models", "a, b,"])).toEqual({ harness: "claude-personal", explicitHarness: true, models: ["a", "b"] });
});

test("parseArgs rejects unknown flags and missing values", () => {
  expect(parseArgs(["--nope"])).toBe("unknown argument: --nope");
  expect(parseArgs(["--harness"])).toBe("--harness needs a value");
  expect(parseArgs(["--harness", "--models", "a"])).toBe("--harness needs a value");
  expect(parseArgs(["--models", ","])).toBe("--models needs at least one id");
});

test("isCorporate matches the corporate id or its config dir", () => {
  expect(isCorporate(work)).toBe(true);
  expect(isCorporate({ id: "work", env: { CLAUDE_CONFIG_DIR: "/home/x/.claude-work" } })).toBe(true);
  expect(isCorporate({ id: "work", env: { CLAUDE_CONFIG_DIR: "/home/x/.claude-work/" } })).toBe(true);
  expect(isCorporate(claude)).toBe(false);
  expect(isCorporate({ id: "claude-personal" })).toBe(false);
});

test("refuses the corporate account unless --harness claude-work is explicit", () => {
  expect(refusal(work, args(["--harness", "claude-work"]))).toBeUndefined();
  // Reached without the explicit flag (e.g. a harness renamed onto the corp config dir).
  const renamed: Harness = { ...work, id: "work" };
  expect(refusal(renamed, args(["--harness", "work"]))).toContain("corporate account");
  expect(refusal(work, { harness: "claude-work", explicitHarness: false, models: [] })).toContain("pass --harness claude-work");
});

test("refuses a missing, non-claude-cli or disabled harness", () => {
  expect(refusal(undefined, args(["--harness", "ghost"]))).toContain('no harness "ghost"');
  expect(refusal({ id: "codex", tool: "codex-cli", label: "C", enabled: true }, args([]))).toBe('harness "codex" is codex-cli, not claude-cli');
  expect(refusal({ ...claude, enabled: false, disabledReason: "not authenticated" }, args([]))).toBe('harness "claude" is disabled (not authenticated)');
  expect(refusal(claude, args([]))).toBeUndefined();
});

test("verifyModels runs claude -p per model under the harness's CLAUDE_CONFIG_DIR, in order", async () => {
  const calls: { cmd: string[]; cwd: string; env?: Record<string, string> }[] = [];
  const runner: CommandRunner = async (cmd, opts) => {
    calls.push({ cmd, cwd: opts.cwd, env: opts.env });
    const model = cmd[cmd.indexOf("--model") + 1]!;
    return { exitCode: 0, stdout: okJson(model), stderr: "" };
  };

  const rows = await verifyModels(claude, ["claude-opus-5-5", "claude-haiku-5-5"], runner, "/tmp/probe");

  expect(rows).toEqual([
    { model: "claude-opus-5-5", ok: true, detail: "ok" },
    { model: "claude-haiku-5-5", ok: true, detail: "ok" },
  ]);
  expect(calls.map((c) => c.cmd)).toEqual([
    ["claude", "-p", "--model", "claude-opus-5-5", "--output-format", "json", "reply ok"],
    ["claude", "-p", "--model", "claude-haiku-5-5", "--output-format", "json", "reply ok"],
  ]);
  for (const c of calls) {
    expect(c.cwd).toBe("/tmp/probe");
    expect(c.env).toEqual({ CLAUDE_CONFIG_DIR: "/home/x/.claude", ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" });
  }
});

test("verifyModels reports a failing model and keeps going", async () => {
  const runner: CommandRunner = async (cmd) => {
    const model = cmd[cmd.indexOf("--model") + 1]!;
    if (model === "claude-bogus") return { exitCode: 1, stdout: "", stderr: "API Error: 404 model: claude-bogus not found\n" };
    if (model === "claude-crash") throw new Error("ENOENT claude");
    return { exitCode: 0, stdout: okJson(model), stderr: "" };
  };

  const rows = await verifyModels(claude, ["claude-bogus", "claude-crash", "claude-sonnet-5-5"], runner);

  expect(rows).toEqual([
    { model: "claude-bogus", ok: false, detail: "exit 1: API Error: 404 model: claude-bogus not found" },
    { model: "claude-crash", ok: false, detail: "spawn failed: ENOENT claude" },
    { model: "claude-sonnet-5-5", ok: true, detail: "ok" },
  ]);
});

test("judge fails an is_error result, unparseable output and a silent model fallback", () => {
  expect(judge("m", 0, JSON.stringify({ is_error: true, result: "There's an issue with the selected model" }), "")).toEqual({
    ok: false,
    detail: "exit 0: There's an issue with the selected model",
  });
  expect(judge("m", 0, "not json", "")).toEqual({ ok: false, detail: "exit 0: not json" });
  expect(judge("claude-haiku-5-5", 0, okJson("claude-sonnet-5-5"), "")).toEqual({ ok: false, detail: "ran on claude-sonnet-5-5 instead" });
});

test("judge accepts a suffixed modelUsage key and a result with no modelUsage", () => {
  expect(judge("claude-opus-5-5", 0, okJson("claude-opus-5-5[1m]"), "").ok).toBe(true);
  expect(judge("m", 0, JSON.stringify({ is_error: false, result: "OK" }), "")).toEqual({ ok: true, detail: "OK" });
});

test("judge matches the exact id, not a prefix of a newer model", () => {
  expect(judge("claude-opus-5", 0, okJson("claude-opus-5-5"), "")).toEqual({ ok: false, detail: "ran on claude-opus-5-5 instead" });
  expect(sameModel("claude-opus-5", "claude-opus-5-5")).toBe(false);
  expect(sameModel("claude-opus-5", "claude-opus-5[1m]")).toBe(true);
  expect(sameModel("claude-haiku-4-5", "claude-haiku-4-5-20251001")).toBe(true);
  expect(sameModel("claude-haiku-4-5", "claude-haiku-4-5-20251001[1m]")).toBe(true);
  expect(sameModel("claude-haiku-4-5", "claude-haiku-4-5-2025")).toBe(false);
});

test("formatTable lists ok/FAIL per model and a total", () => {
  const out = formatTable(claude, [
    { model: "claude-opus-5-5", ok: true, detail: "ok" },
    { model: "claude-x", ok: false, detail: "exit 1: nope" },
  ]);
  expect(out).toContain("harness: claude (CLAUDE_CONFIG_DIR=/home/x/.claude)");
  expect(out).toMatch(/claude-opus-5-5\s+ok\s+ok/);
  expect(out).toMatch(/claude-x\s+FAIL\s+exit 1: nope/);
  expect(out.trimEnd().endsWith("1/2 ok")).toBe(true);
});
