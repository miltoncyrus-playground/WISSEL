import { expect, test } from "bun:test";
import { parse } from "yaml";
import { applyTeamPreset, buildTeamPreset, renderTeamPresetYaml } from "../src/core/team-preset.ts";
import type { AgentDef } from "../src/core/types.ts";

test("buildTeamPreset wires a coordinator that hands off to three specialists that hand off to no one", () => {
  const team = buildTeamPreset("docs");
  expect(team.map((a) => a.id)).toEqual(["docs-coordinator", "docs-researcher", "docs-writer", "docs-reviewer"]);

  const [coordinator, ...specialists] = team;
  expect(coordinator!.handoffs).toEqual(["docs-researcher", "docs-writer", "docs-reviewer"]);
  for (const s of specialists) {
    // Deliberately [] — "declared, hands off to no one" — not undefined
    // ("never opted into the handoff graph"). See AgentDef.handoffs.
    expect(s.handoffs).toEqual([]);
  }
});

test("every generated agent satisfies the full AgentDef capability contract", () => {
  for (const a of buildTeamPreset("ops")) {
    expect(a.kind).toBe("agent");
    expect(a.tier).toBe("readonly");
    expect(a.inputs.length).toBeGreaterThan(0);
    expect(a.outputs.length).toBeGreaterThan(0);
    expect(a.costProfile.model).toBeTruthy();
    expect(a.costProfile.estUsdPerTask).toBeGreaterThan(0);
    expect(["low", "medium", "high"]).toContain(a.trustLevel);
  }
});

test("applyTeamPreset reports conflicts and adds nothing when any id already exists", () => {
  const existing: AgentDef[] = [{ ...buildTeamPreset("docs")[1]! }]; // just docs-researcher present
  const result = applyTeamPreset(existing, "docs");
  expect(result.ok).toBe(false);
  expect(result.conflicts).toEqual(["docs-researcher"]);
  expect(result.added).toBeUndefined();
});

test("applyTeamPreset succeeds when the prefix is unused", () => {
  const result = applyTeamPreset([], "docs");
  expect(result.ok).toBe(true);
  expect(result.added!.map((a) => a.id)).toEqual(["docs-coordinator", "docs-researcher", "docs-writer", "docs-reviewer"]);
});

test("renderTeamPresetYaml produces a block that parses back to the same agents, appended to an existing file", () => {
  const added = buildTeamPreset("editorial");
  const block = renderTeamPresetYaml(added);

  const existingFile = "agents:\n  - id: triager\n    name: Triager\n    kind: agent\n    tier: readonly\n";
  const combined = existingFile + block;

  const parsed = parse(combined) as { agents: { id: string; handoffs?: string[] }[] };
  expect(parsed.agents.map((a) => a.id)).toEqual([
    "triager", "editorial-coordinator", "editorial-researcher", "editorial-writer", "editorial-reviewer",
  ]);
  const coordinator = parsed.agents.find((a) => a.id === "editorial-coordinator");
  expect(coordinator!.handoffs).toEqual(["editorial-researcher", "editorial-writer", "editorial-reviewer"]);
});

test("renderTeamPresetYaml quotes a whenToUse/description containing YAML-ambiguous punctuation", () => {
  const block = renderTeamPresetYaml(buildTeamPreset("docs"));
  // The coordinator's whenToUse contains a comma — bare would be a risky
  // flow-scalar; it must come back quoted and still parse correctly.
  const parsed = parse(`agents:${block}`) as { agents: { id: string; whenToUse: string }[] };
  const coordinator = parsed.agents.find((a) => a.id === "docs-coordinator");
  expect(coordinator!.whenToUse).toContain("researcher, writer, or reviewer");
});
