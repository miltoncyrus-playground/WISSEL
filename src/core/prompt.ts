import type { AgentDef, TaskCard } from "./types.ts";

/** Shared framing for every headless `claude -p` call, read-only or write. */
export function buildAgentPrompt(task: TaskCard, agent: AgentDef): string {
  const lines = [
    `You are acting as the "${agent.name}" agent: ${agent.description}`,
    `When to use you: ${agent.whenToUse}`,
    "",
    `Task: ${task.title}`,
    task.body,
  ];
  // Appended verbatim, not merged into the framing above — see
  // AgentDef.outputContract. Keeping it a separate trailing block makes
  // it unambiguous to both the model and a reviewer diffing the prompt.
  if (agent.outputContract) {
    lines.push("", agent.outputContract);
  }
  if (agent.verificationContract) {
    lines.push("", agent.verificationContract);
  }
  return lines.join("\n");
}
