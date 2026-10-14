#!/usr/bin/env bun
/**
 * Moves every LLM entry in agents/manifest.yaml to the model the house
 * rule requires (`expectedModelFor` in src/core/model-catalog.ts: the
 * best model for its tool, or its row in APPROVED_DOWNGRADES) and scales
 * its `estUsdPerTask` by the price change. Prints a before/after table.
 * docs/SDD-model-selection.md §7.3.
 *
 *   bun run scripts/apply-best-models.ts            # dry run, table only
 *   bun run scripts/apply-best-models.ts --write    # rewrite the manifest
 *
 * Run it when `test/model-catalog-manifest.test.ts`'s policy test fails
 * because a better model was ranked in MODEL_RANK.
 *
 * Cost scaling: new = old x (new input price / old input price), rounded
 * to the cent. That is exact for any input/output token mix only when
 * both models price output at the same multiple of input (every model in
 * MODEL_PRICING today: 5x). When they differ the script stops instead of
 * guessing; re-estimate that entry from real token counts by hand.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Registry } from "../src/core/registry.ts";
import { APPROVED_DOWNGRADES, expectedModelFor, toolForExecutor, type ApprovedDowngrade } from "../src/core/model-catalog.ts";
import type { AgentDef } from "../src/core/types.ts";
import { MODEL_PRICING } from "../src/executors/anthropic-api.ts";

export const MANIFEST_PATH = "agents/manifest.yaml";

export interface RemapRow {
  id: string;
  kind: AgentDef["kind"];
  tool: string;
  oldModel: string;
  newModel: string;
  oldUsd: number;
  newUsd: number;
  /** e.g. "0.08 x 10/4"; "unchanged" when the model already matches. */
  arithmetic: string;
}

export interface RemapPlan {
  rows: RemapRow[];
  /** The manifest text with every row's costProfile line rewritten. */
  text: string;
  oldTotal: number;
  newTotal: number;
}

const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * Pure: computes the remap for `agents` against `manifestText` without
 * touching disk. Throws when a model has no price, when the two models'
 * output/input price ratios differ, or when an entry's costProfile line
 * can't be found in the text (so the text and the registry disagree).
 */
export function planBestModels(
  agents: AgentDef[],
  manifestText: string,
  pricing: Record<string, { input: number; output: number }> = MODEL_PRICING,
  downgrades: Record<string, ApprovedDowngrade> = APPROVED_DOWNGRADES,
): RemapPlan {
  let text = manifestText;
  const rows: RemapRow[] = [];
  for (const a of agents) {
    const tool = toolForExecutor(a.executor);
    const newModel = expectedModelFor(a, downgrades);
    if (!tool || !newModel) continue;
    const oldModel = a.costProfile.model;
    const oldUsd = a.costProfile.estUsdPerTask;
    if (oldModel === newModel) {
      rows.push({ id: a.id, kind: a.kind, tool, oldModel, newModel, oldUsd, newUsd: oldUsd, arithmetic: "unchanged" });
      continue;
    }
    const oldP = pricing[oldModel];
    const newP = pricing[newModel];
    if (!oldP || !newP) throw new Error(`${a.id}: no price for ${!oldP ? oldModel : newModel}; add it to MODEL_PRICING first`);
    if (oldP.output / oldP.input !== newP.output / newP.input) {
      throw new Error(`${a.id}: ${oldModel} and ${newModel} price output at different multiples of input; re-estimate estUsdPerTask from real token counts`);
    }
    const newUsd = cents((oldUsd * newP.input) / oldP.input);
    const line = new RegExp(`(\\n  - id: ${a.id}\\n(?:(?!\\n  - id: )[\\s\\S])*?costProfile: \\{ model: )${oldModel.replace(/[.]/g, "\\.")}, estUsdPerTask: [0-9.]+ \\}`);
    if (!line.test(text)) throw new Error(`${a.id}: no "costProfile: { model: ${oldModel}, estUsdPerTask: ... }" line under its entry`);
    text = text.replace(line, `$1${newModel}, estUsdPerTask: ${newUsd.toFixed(2)} }`);
    rows.push({ id: a.id, kind: a.kind, tool, oldModel, newModel, oldUsd, newUsd, arithmetic: `${oldUsd.toFixed(2)} x ${newP.input}/${oldP.input}` });
  }
  const sum = (k: "oldUsd" | "newUsd") => cents(rows.reduce((s, r) => s + r[k], 0));
  return { rows, text, oldTotal: sum("oldUsd"), newTotal: sum("newUsd") };
}

/** The before/after table as markdown, totals last. */
export function renderPlan(plan: RemapPlan): string {
  const lines = [
    "| Agent | Kind | Tool | Old model | New model | Old est | New est | Arithmetic |",
    "|---|---|---|---|---|---|---|---|",
    ...plan.rows.map((r) => `| ${r.id} | ${r.kind} | ${r.tool} | ${r.oldModel} | ${r.newModel} | $${r.oldUsd.toFixed(2)} | $${r.newUsd.toFixed(2)} | ${r.arithmetic} |`),
  ];
  const delta = cents(plan.newTotal - plan.oldTotal);
  const factor = plan.oldTotal > 0 ? ` (x${(plan.newTotal / plan.oldTotal).toFixed(2)})` : "";
  lines.push("", `One task on every entry: $${plan.oldTotal.toFixed(2)} -> $${plan.newTotal.toFixed(2)}, ${delta >= 0 ? "+" : ""}$${delta.toFixed(2)}${factor}.`);
  return lines.join("\n");
}

if (import.meta.main) {
  const write = process.argv.includes("--write");
  const registry = await Registry.load(MANIFEST_PATH);
  const plan = planBestModels(registry.all(), readFileSync(MANIFEST_PATH, "utf8"));
  console.log(renderPlan(plan));
  if (write) {
    writeFileSync(MANIFEST_PATH, plan.text);
    console.log(`\nwrote ${MANIFEST_PATH}`);
  } else {
    console.log("\ndry run; pass --write to rewrite the manifest");
  }
}
