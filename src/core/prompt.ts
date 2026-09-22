import type { AgentDef, TaskCard } from "./types.ts";

/**
 * Shared framing for every headless `claude -p`/`codex exec` call,
 * read-only or write. `memory`, when given, is the current contents of
 * the global memory/lessons.md file (see src/services/memory.ts) — the
 * caller (runClaude/runCodex) reads that file itself and passes its
 * content through here; this function stays pure and file-I/O-free.
 * Omitted or empty means no section is added at all — the common case
 * before anything has ever been curated (docs/SDD-memory-curator.md §9).
 * No per-agent filtering in v1: every agent gets the same memory,
 * verbatim (see SDD §7's non-goals).
 */
export function buildAgentPrompt(task: TaskCard, agent: AgentDef, memory?: string): string {
  const lines = [
    `You are acting as the "${agent.name}" agent: ${agent.description}`,
    `When to use you: ${agent.whenToUse}`,
    "",
    `Task: ${task.title}`,
    task.body,
  ];
  if (memory) {
    lines.push("", "Lessons learned from prior sessions:", memory);
  }
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
