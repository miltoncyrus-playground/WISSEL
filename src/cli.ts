#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";
import { parse } from "yaml";
import { Registry } from "./core/registry.ts";
import { applyTeamPreset, renderTeamPresetYaml } from "./core/team-preset.ts";
import type { AgentDef, RoutingDecision } from "./core/types.ts";
import { getVersionInfo } from "./core/version.ts";

const apiUrl = process.env.WISSEL_API_URL ?? "http://localhost:8787";
const MANIFEST_PATH = "agents/manifest.yaml";
const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "--version":
  case "-v": {
    const v = getVersionInfo();
    console.log(`wissel ${v.commitShort}${v.dirty ? "+dirty" : ""} (${v.branch}, pkg ${v.packageVersion})`);
    break;
  }
  case "agents": {
    const registry = await Registry.load();
    for (const agent of registry.all()) {
      console.log(`${agent.kind.padEnd(6)} ${agent.id.padEnd(24)} ${agent.tier.padEnd(9)} ${agent.tags.join(", ")}`);
    }
    break;
  }
  case "why": {
    const taskId = args[0];
    if (!taskId) {
      console.log("usage: wissel why <task-id>");
      process.exit(1);
    }
    await printWhy(taskId);
    break;
  }
  case "team": {
    const [sub, prefix] = args;
    if (sub !== "create" || !prefix) {
      console.log("usage: wissel team create <prefix>");
      process.exit(1);
    }
    await teamCreate(prefix);
    break;
  }
  default:
    console.log("usage: wissel <agents|why|team|--version> ...");
    console.log("  wissel agents             list the fleet");
    console.log("  wissel why <task-id>      show the routing decision — what matched, and why");
    console.log("  wissel team create <pfx>  scaffold a coordinator + 3 specialists into the manifest");
    console.log("  wissel --version, -v      print the commit/branch this build is running");
    process.exit(1);
}

/**
 * `wissel why <id>` — the ADR's non-optional requirement: every routing
 * decision shows what matched and why, in the same output, always. Talks
 * to the board API rather than the router directly, since the recorded
 * decision (not a fresh recompute) is what actually happened.
 */
async function printWhy(taskId: string): Promise<void> {
  const res = await fetch(`${apiUrl}/tasks/${taskId}/decision`);
  if (res.status === 404) {
    console.log(`no routing decision recorded for task ${taskId}`);
    return;
  }
  if (!res.ok) {
    console.log(`could not fetch decision: ${res.status} ${await res.text()}`);
    process.exitCode = 1;
    return;
  }

  const decision = (await res.json()) as RoutingDecision;
  console.log(`task ${decision.taskId}`);
  console.log(decision.confident ? `routed to: ${decision.selected}` : `NOT routed — ${decision.reason}`);
  console.log(`reason:    ${decision.reason}`);
  console.log(`strategy:  ${decision.strategy}`);
  console.log(`decided:   ${decision.decidedAt}`);
  console.log("candidates:");
  for (const c of decision.candidates) {
    const marker = decision.confident && c.agentId === decision.selected ? "→" : " ";
    console.log(`  ${marker} ${c.agentId.padEnd(18)} score=${c.score.toFixed(2)}  ${c.reason}`);
  }
}

/**
 * `wissel team create <prefix>` — OpenClaw's `agents team create`,
 * translated: appends a coordinator + 3 specialists to
 * agents/manifest.yaml with the delegation graph pre-wired
 * (coordinator.handoffs -> the three specialists; each specialist
 * declares handoffs: [], so a follow-up task under one of them is
 * correctly restricted to zero further candidates rather than falling
 * back to the whole registry — see Router.route's `allowIds`).
 *
 * Appends raw text to the existing file rather than parsing and
 * re-serializing it, so the manifest's header/section comments survive
 * untouched — this command only ever adds bytes, never rewrites them.
 */
async function teamCreate(prefix: string): Promise<void> {
  const raw = await readFile(MANIFEST_PATH, "utf8");
  const parsed = parse(raw) as { agents?: AgentDef[] };
  const result = applyTeamPreset(parsed.agents ?? [], prefix);

  if (!result.ok) {
    console.log(`team create: id already exists — ${result.conflicts!.join(", ")}`);
    console.log("no changes made.");
    process.exitCode = 1;
    return;
  }

  const block = renderTeamPresetYaml(result.added!);
  const updated = raw.replace(/\n+$/, "\n") + block;

  // Sanity check before ever touching disk: the file we're about to
  // write must itself parse, and contain every id we intended to add.
  const reparsed = parse(updated) as { agents: { id: string }[] };
  const gotIds = new Set(reparsed.agents.map((a) => a.id));
  for (const a of result.added!) {
    if (!gotIds.has(a.id)) {
      throw new Error(`team create: generated YAML for "${a.id}" failed to round-trip — aborting write`);
    }
  }

  await writeFile(MANIFEST_PATH, updated);
  const [coordinator, ...specialists] = result.added!;
  console.log(`created team "${prefix}": ${result.added!.map((a) => a.id).join(", ")}`);
  console.log(`${coordinator!.id} hands off to: ${specialists.map((a) => a.id).join(", ")}`);
  console.log(`${specialists.map((a) => a.id).join(", ")} hand off to no one (handoffs: [])`);
}
