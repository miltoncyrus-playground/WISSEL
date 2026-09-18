#!/usr/bin/env bun
import { Registry } from "./core/registry.ts";
import type { RoutingDecision } from "./core/types.ts";

const apiUrl = process.env.WISSEL_API_URL ?? "http://localhost:8787";
const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "agents": {
    const registry = await Registry.load();
    for (const agent of registry.all()) {
      console.log(`${agent.id.padEnd(20)} ${agent.tier.padEnd(9)} ${agent.tags.join(", ")}`);
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
  default:
    console.log("usage: wissel <agents|why> ...");
    console.log("  wissel agents          list the fleet");
    console.log("  wissel why <task-id>   show the routing decision — what matched, and why");
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
