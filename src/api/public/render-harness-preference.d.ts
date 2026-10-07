// Type declaration for render-harness-preference.js, a plain browser
// script (no build step, see its own header comment) that's also
// imported directly by bun test. Kept in sync by hand; the .js file is
// the source of truth for behavior.
export interface HarnessRow {
  id: string;
  label?: string;
  enabled: boolean;
  activeCount?: number;
  maxConcurrent?: number;
}

export type HarnessPreferenceState = "available" | "full" | "disabled" | "unknown";

export interface AgentHarnessEntry {
  id: string;
  state: HarnessPreferenceState;
  text: string;
}

export interface AgentHarnessDescription {
  any: boolean;
  entries: AgentHarnessEntry[];
  text: string;
}

export function formatHarnessCapacity(h: HarnessRow): string | null;
export function harnessPreferenceState(h: HarnessRow | undefined): HarnessPreferenceState;
export function describeAgentHarnesses(agent: { harnesses?: string[] } | undefined, harnesses: HarnessRow[] | undefined): AgentHarnessDescription;

/** One GET /status/accounts row (src/core/account-status.ts AccountStatus). */
export interface AccountStatusRow {
  id: string;
  label: string;
  tool: string;
  activeCount: number;
  maxConcurrent?: number;
  defaultModel?: string;
  running: { taskId: string; title: string; agentId: string | null; model: string | null }[];
}

export interface AccountChip {
  id: string;
  label: string;
  tool: string;
  load: string;
  models: string;
  busy: boolean;
  text: string;
  title: string;
}

export function shortAccountLabel(label: string): string;
export function shortModelName(model: string): string;
export function summarizeRunningModels(running: AccountStatusRow["running"]): string;
export function describeAccountChip(row: AccountStatusRow): AccountChip;
