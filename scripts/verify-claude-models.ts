#!/usr/bin/env bun
/**
 * Checks that every id in CLAUDE_CLI_STATIC_MODELS actually runs on one
 * claude-cli harness: `claude -p --model <id> "reply ok"` under that
 * harness's CLAUDE_CONFIG_DIR, one id at a time, then an ok/fail table.
 * Manual only. It spends real tokens (one short prompt per model), so it
 * is not a gate test. docs/SDD-model-selection.md §7.
 *
 *   bun run scripts/verify-claude-models.ts                     # harness "claude"
 *   bun run scripts/verify-claude-models.ts --harness <id>
 *   bun run scripts/verify-claude-models.ts --models claude-haiku-5-5,claude-opus-5-5
 *
 * claude-work is the corporate account. The script refuses to touch
 * it (by id, or by a harness whose CLAUDE_CONFIG_DIR is .claude-work)
 * unless `--harness claude-work` is passed explicitly.
 *
 * Exits 1 when any model fails. WISSEL_HARNESSES_PATH as for the server.
 */
import { tmpdir } from "node:os";
import { basename } from "node:path";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { CLAUDE_CLI_STATIC_MODELS } from "../src/core/model-catalog.ts";
import type { Harness } from "../src/core/types.ts";
import { runViaBun, type CommandRunner } from "../src/executors/claude-cli.ts";

export const DEFAULT_HARNESS = "claude";
export const CORPORATE_HARNESS = process.env.WISSEL_CORPORATE_HARNESS || "claude-work";
export const PROMPT = "reply ok";

export interface VerifyArgs {
  harness: string;
  /** True only when `--harness` was on the command line. */
  explicitHarness: boolean;
  models: string[];
}

export function parseArgs(argv: string[]): VerifyArgs | string {
  const args: VerifyArgs = { harness: DEFAULT_HARNESS, explicitHarness: false, models: CLAUDE_CLI_STATIC_MODELS };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--harness" || flag === "--models") {
      if (!value || value.startsWith("--")) return `${flag} needs a value`;
      i++;
      if (flag === "--harness") {
        args.harness = value;
        args.explicitHarness = true;
      } else {
        args.models = value.split(",").map((m) => m.trim()).filter(Boolean);
        if (args.models.length === 0) return "--models needs at least one id";
      }
    } else {
      return `unknown argument: ${flag}`;
    }
  }
  return args;
}

/** True when `harness` is the corporate account, by id or by its config dir. */
export function isCorporate(harness: Pick<Harness, "id" | "env">): boolean {
  const configDir = harness.env?.CLAUDE_CONFIG_DIR;
  return harness.id === CORPORATE_HARNESS || (configDir !== undefined && basename(configDir) === `.${CORPORATE_HARNESS}`);
}

/** Why `harness` can't be verified, or undefined when it can. The
 *  corporate account needs the exact `--harness claude-work`. */
export function refusal(harness: Harness | undefined, args: VerifyArgs): string | undefined {
  if (!harness) return `no harness "${args.harness}" (run \`bun run models:refresh\` to list the harnesses on this machine)`;
  if (harness.tool !== "claude-cli") return `harness "${harness.id}" is ${harness.tool}, not claude-cli`;
  if (isCorporate(harness) && !(args.explicitHarness && args.harness === CORPORATE_HARNESS)) {
    return `harness "${harness.id}" is the corporate account; pass --harness ${CORPORATE_HARNESS} explicitly to verify it`;
  }
  if (!harness.enabled) return `harness "${harness.id}" is disabled${harness.disabledReason ? ` (${harness.disabledReason})` : ""}`;
  return undefined;
}

export interface VerifyRow {
  model: string;
  ok: boolean;
  detail: string;
}

/** One `claude -p` per model, in order (sequential, so a burst never
 *  trips a rate limit). ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN are
 *  forced empty for the same reason runClaudeCli does it: an ambient key
 *  would override CLAUDE_CONFIG_DIR's login. Runs from `cwd` (default a
 *  temp dir) so no project CLAUDE.md gets loaded into the probe. */
export async function verifyModels(
  harness: Harness,
  models: string[],
  runner: CommandRunner = runViaBun,
  cwd: string = tmpdir(),
): Promise<VerifyRow[]> {
  const env = { ...(harness.env ?? {}), ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" };
  const rows: VerifyRow[] = [];
  for (const model of models) {
    try {
      const result = await runner(["claude", "-p", "--model", model, "--output-format", "json", PROMPT], { cwd, env });
      rows.push({ model, ...judge(model, result.exitCode, result.stdout, result.stderr) });
    } catch (e) {
      rows.push({ model, ok: false, detail: `spawn failed: ${(e as Error).message}` });
    }
  }
  return rows;
}

interface ClaudeJsonResult {
  is_error?: boolean;
  result?: string;
  modelUsage?: Record<string, unknown>;
}

/** ok = exit 0, a non-error JSON result, and (when claude reports
 *  modelUsage) the requested model among the models that ran. The last
 *  check catches a silent fallback to a different model. */
export function judge(model: string, exitCode: number, stdout: string, stderr: string): { ok: boolean; detail: string } {
  let parsed: ClaudeJsonResult | undefined;
  try {
    parsed = JSON.parse(stdout) as ClaudeJsonResult;
  } catch {
    parsed = undefined;
  }
  const text = oneLine(parsed?.result ?? (stderr || stdout));
  if (exitCode !== 0 || !parsed || parsed.is_error) return { ok: false, detail: `exit ${exitCode}: ${text || "(no output)"}` };
  const used = Object.keys(parsed.modelUsage ?? {});
  if (used.length > 0 && !used.some((id) => sameModel(model, id))) {
    return { ok: false, detail: `ran on ${used.join(", ")} instead` };
  }
  return { ok: true, detail: text };
}

/** A modelUsage key matches the requested id when it is that id, or that
 *  id plus a `-<YYYYMMDD>` snapshot suffix and/or a `[...]` context tag
 *  (`claude-opus-5-5[1m]`). A plain prefix is not enough: requesting
 *  `claude-opus-5` must fail when `claude-opus-5-5` ran. */
export function sameModel(requested: string, used: string): boolean {
  if (!used.startsWith(requested)) return false;
  return /^(-\d{8})?(\[[^\]]*\])?$/.test(used.slice(requested.length));
}

function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 100 ? `${flat.slice(0, 97)}...` : flat;
}

export function formatTable(harness: Harness, rows: VerifyRow[]): string {
  const width = Math.max("model".length, ...rows.map((r) => r.model.length));
  const lines = [`harness: ${harness.id} (CLAUDE_CONFIG_DIR=${harness.env?.CLAUDE_CONFIG_DIR ?? "ambient"})`, ""];
  lines.push(`${"model".padEnd(width)}  result  detail`);
  for (const r of rows) lines.push(`${r.model.padEnd(width)}  ${(r.ok ? "ok" : "FAIL").padEnd(6)}  ${r.detail}`.trimEnd());
  lines.push("", `${rows.filter((r) => r.ok).length}/${rows.length} ok`);
  return lines.join("\n");
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args === "string") {
    console.error(args);
    process.exit(2);
  }
  const pool = await HarnessPool.autoload(process.env.WISSEL_HARNESSES_PATH ?? "harnesses.yaml");
  const harness = pool.get(args.harness);
  const refused = refusal(harness, args);
  if (refused) {
    console.error(refused);
    process.exit(2);
  }
  const rows = await verifyModels(harness!, args.models);
  console.log(formatTable(harness!, rows));
  process.exitCode = rows.every((r) => r.ok) ? 0 : 1;
}
