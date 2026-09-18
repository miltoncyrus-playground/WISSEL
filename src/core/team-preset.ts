import type { AgentDef } from "./types.ts";

export interface TeamPresetResult {
  ok: boolean;
  added?: AgentDef[];
  conflicts?: string[];
}

/**
 * OpenClaw's bundled "team" preset (`agents team create`), translated to
 * wissel's shape: a coordinator that decomposes and delegates, plus
 * three specialists that can't delegate further. `handoffs: []` on the
 * specialists is deliberate — a declared dead end (see AgentDef.handoffs),
 * not "never opted into the handoff graph." Every id gets `${prefix}-`
 * prepended so multiple teams can coexist without collision.
 */
export function buildTeamPreset(prefix: string): AgentDef[] {
  const specialistIds = [`${prefix}-researcher`, `${prefix}-writer`, `${prefix}-reviewer`];
  const cost = (estUsdPerTask: number): AgentDef["costProfile"] => ({ model: "claude-sonnet-5", estUsdPerTask });

  return [
    {
      id: `${prefix}-coordinator`,
      name: `${prefix} coordinator`,
      kind: "agent",
      tier: "readonly",
      description: "Turns a request into scoped work and delegates it to the right specialist.",
      whenToUse: `The single point of contact for the ${prefix} team — routes work to researcher, writer, or reviewer.`,
      tags: [prefix, "coordination"],
      executor: "readonly",
      handoffs: specialistIds,
      inputs: ["raw-text", "task-card"],
      outputs: ["subtask-cards"],
      trustLevel: "low",
      toolAccess: ["read"],
      costProfile: cost(0.08),
    },
    {
      id: `${prefix}-researcher`,
      name: `${prefix} researcher`,
      kind: "agent",
      tier: "readonly",
      description: "Gathers evidence and returns a cited brief.",
      whenToUse: `A ${prefix} team task needs evidence gathered before anything is written.`,
      tags: [prefix, "research"],
      executor: "readonly",
      handoffs: [],
      inputs: ["task-card"],
      outputs: ["research-brief"],
      trustLevel: "low",
      toolAccess: ["read"],
      costProfile: cost(0.10),
    },
    {
      id: `${prefix}-writer`,
      name: `${prefix} writer`,
      kind: "agent",
      tier: "readonly",
      description: "Turns a brief and source material into a usable draft.",
      whenToUse: `A ${prefix} team task has enough source material and needs a draft written.`,
      tags: [prefix, "writing"],
      executor: "readonly",
      handoffs: [],
      inputs: ["research-brief"],
      outputs: ["draft"],
      trustLevel: "low",
      toolAccess: ["read"],
      costProfile: cost(0.10),
    },
    {
      id: `${prefix}-reviewer`,
      name: `${prefix} reviewer`,
      kind: "agent",
      tier: "readonly",
      description: "Checks a draft against requirements and returns actionable findings.",
      whenToUse: `A ${prefix} team draft exists and needs checking before it ships.`,
      tags: [prefix, "review"],
      executor: "readonly",
      handoffs: [],
      inputs: ["draft"],
      outputs: ["review-findings"],
      trustLevel: "medium",
      toolAccess: ["read"],
      costProfile: cost(0.10),
    },
  ];
}

/** Pure — no filesystem access, so it's trivial to test. Mirrors
 *  OpenClaw's `team create` collision behavior: if any resulting id
 *  already exists anywhere in the registry, report the conflicts and
 *  add nothing, rather than partially applying the preset. */
export function applyTeamPreset(existing: AgentDef[], prefix: string): TeamPresetResult {
  const added = buildTeamPreset(prefix);
  const existingIds = new Set(existing.map((a) => a.id));
  const conflicts = added.filter((a) => existingIds.has(a.id)).map((a) => a.id);
  if (conflicts.length) return { ok: false, conflicts };
  return { ok: true, added };
}

/** Quotes a YAML scalar only when the bare form would be ambiguous —
 *  matches how agents/manifest.yaml already writes plain text bare and
 *  falls back to quoting for punctuation. */
function yamlScalar(s: string): string {
  return /[:#{}[\],&*!|>'"%@`]|^[\s-]|\s$/.test(s) ? JSON.stringify(s) : s;
}

function formatAgentEntry(a: AgentDef): string {
  const lines = [
    `  - id: ${a.id}`,
    `    name: ${yamlScalar(a.name)}`,
    `    kind: ${a.kind}`,
    `    tier: ${a.tier}`,
    `    description: ${yamlScalar(a.description)}`,
    `    whenToUse: ${yamlScalar(a.whenToUse)}`,
    `    tags: [${a.tags.join(", ")}]`,
    `    executor: ${a.executor}`,
  ];
  if (a.handoffs !== undefined) lines.push(`    handoffs: [${a.handoffs.join(", ")}]`);
  lines.push(
    `    inputs: [${a.inputs.join(", ")}]`,
    `    outputs: [${a.outputs.join(", ")}]`,
    `    trustLevel: ${a.trustLevel}`,
    `    toolAccess: [${a.toolAccess.join(", ")}]`,
    `    costProfile: { model: ${a.costProfile.model}, estUsdPerTask: ${a.costProfile.estUsdPerTask} }`,
  );
  return lines.join("\n");
}

/** Renders new manifest entries as a text block matching
 *  agents/manifest.yaml's existing per-entry style exactly (flow-style
 *  arrays and costProfile object), meant to be appended to the raw file
 *  text — never a parse-then-restringify round trip, which would
 *  silently drop the file's header/section comments. */
export function renderTeamPresetYaml(added: AgentDef[]): string {
  return added.map((a) => `\n${formatAgentEntry(a)}`).join("\n") + "\n";
}
