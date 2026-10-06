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
