import { expect, test } from "bun:test";
import { buildAgentPrompt, parallelHintOn, PARALLEL_HINT } from "../src/core/prompt.ts";
import type { AgentDef, TaskCard } from "../src/core/types.ts";

// WISSEL_PARALLEL_HINT, docs/SDD-parallel-hint.md.

const agent = { id: "implementer", name: "Implementer", description: "d", whenToUse: "w" } as AgentDef;
const task = { id: "t", title: "Title", body: "Body", labels: [], status: "dispatched" } as TaskCard;

test("parallelHintOn: off unless 1, true or on", () => {
  expect(parallelHintOn({})).toBe(false);
  for (const v of ["1", "true", "on", " ON "]) expect(parallelHintOn({ WISSEL_PARALLEL_HINT: v })).toBe(true);
  for (const v of ["0", "off", "", "yes"]) expect(parallelHintOn({ WISSEL_PARALLEL_HINT: v })).toBe(false);
});

test("the hint is appended last when asked for, and the prompt is byte-identical without it", () => {
  const plain = buildAgentPrompt(task, agent);
  expect(buildAgentPrompt(task, agent, undefined, { parallelHint: false })).toBe(plain);
  const hinted = buildAgentPrompt(task, agent, undefined, { parallelHint: true });
  expect(hinted).toBe(`${plain}\n\n${PARALLEL_HINT}`);
  expect(PARALLEL_HINT).toContain("Do not skip a check");
});
