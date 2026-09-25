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
export interface BuildAgentPromptOptions {
  /** True when the caller is about to run this under `--permission-mode
   *  plan` (ReadOnlyExecutor). Appends an explicit note countering a
   *  real, reproduced failure mode: under `--permission-mode plan` in a
   *  headless `claude -p` session, the model periodically believes it
   *  must call `ExitPlanMode` to submit its plan for approval — a tool
   *  that exists only in the interactive TUI and isn't wired up here.
   *  When that happens the model writes a plan file under a local
   *  "plans" directory and ends its turn without ever producing the
   *  required output-contract block, which parseReviewVerdict/
   *  parseSubtaskPlan then correctly (but expensively — this is a real
   *  paid run) fails closed on. Confirmed live 2026-09-24/25: same
   *  signature on the same reviewer task, twice, under two different
   *  harnesses (claude-adevinta then claude) — not harness-specific,
   *  intermittent under plan mode generally. This note is the fix: tell
   *  the model directly that no such tool or approval step exists here. */
  planMode?: boolean;
}

export function buildAgentPrompt(task: TaskCard, agent: AgentDef, memory?: string, opts?: BuildAgentPromptOptions): string {
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
  if (opts?.planMode) {
    lines.push(
      "",
      "This session is running with --permission-mode plan in a headless, non-interactive context. " +
        "There is no ExitPlanMode tool, no AskUserQuestion tool, and no plan-approval step available here — " +
        "do not attempt to call ExitPlanMode or any other tool to submit, exit, or get approval for a plan, " +
        "and do not write your findings to a plan file instead of answering. " +
        "Plan mode here exists only to enforce read-only access; it is not an interactive planning workflow. " +
        "When your investigation is complete, just end your final message normally, per the output contract above.",
    );
  }
  return lines.join("\n");
}
