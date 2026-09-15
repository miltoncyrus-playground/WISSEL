import type { AgentDef, TaskCard } from "./types.ts";

/** Shared framing for every headless `claude -p` call, read-only or write. */
export function buildAgentPrompt(task: TaskCard, agent: AgentDef): string {
  return [
    `You are acting as the "${agent.name}" agent: ${agent.description}`,
    `When to use you: ${agent.whenToUse}`,
    "",
    `Task: ${task.title}`,
    task.body,
  ].join("\n");
}
