import { expect, test } from "bun:test";
import { denialsFromOutput, legacyCommandKeys, legacyKeyCount, stats, telemetryStats } from "../scripts/denials-baseline.ts";
import { summarizeDenials } from "../src/core/permission-denials.ts";

// scripts/denials-baseline.ts: the before/after measurement for the
// write-tier sandbox (docs/SDD-write-tier-sandbox.md).

const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });

test("denialsFromOutput reads the last result line's raw permission_denials", () => {
  const out = [
    JSON.stringify({ type: "system" }),
    JSON.stringify({ type: "result", permission_denials: [bash("ls")] }),
    JSON.stringify({ type: "system", subtype: "task_updated" }),
    "{partial",
    "",
  ].join("\n");
  expect(denialsFromOutput(out)).toEqual([bash("ls")]);
  expect(denialsFromOutput(JSON.stringify({ type: "result" }))).toEqual([]);
  expect(denialsFromOutput(JSON.stringify({ type: "system" }))).toBeUndefined();
});

test("the old split inflated key counts on quoted pipes; the new one doesn't", () => {
  const cmd = 'grep -rn "mergedSha\\|landedSha\\|recordMerge(" src';
  // The junk keys the card saw: halves of the quoted regex.
  expect(legacyCommandKeys(cmd)).toEqual(["landedSha\\", 'recordMerge(" src']);
  const raw = [bash(cmd), bash("bun test 2>&1 | tail"), bash("bun test 2>&1 | tail")];
  expect(legacyKeyCount(raw)).toBe(3);
  expect(summarizeDenials(raw)).toEqual(["Bash", "Bash: bun test"]);
  expect(legacyKeyCount([{ tool_name: "Write", tool_input: {} }, null as never])).toBe(1);
});

test("stats: median, mean, max and runs with denials", () => {
  expect(stats([0, 8, 9, 126])).toEqual({ runs: 4, withDenials: 3, median: 8.5, mean: 35.8, max: 126 });
  expect(stats([3, 1, 2])).toMatchObject({ median: 2 });
  expect(stats([])).toEqual({ runs: 0, withDenials: 0, median: 0, mean: 0, max: 0 });
});

test("telemetryStats groups result events by sandbox state, for one agent, since a date", () => {
  const e = (o: Record<string, unknown>) => JSON.stringify({ type: "result", agentId: "implementer", at: "2026-10-18T00:00:00Z", ...o });
  const jsonl = [
    e({ denials: 0, sandbox: "on" }),
    e({ denials: 2, sandbox: "on" }),
    e({ denials: 1, sandbox: "on" }),
    e({ denials: 9, sandbox: "unavailable" }),
    e({ denials: 7 }),
    e({ sandbox: "on" }),
    e({ denials: 50, sandbox: "on", at: "2026-10-01T00:00:00Z" }),
    e({ denials: 50, sandbox: "on", agentId: "reviewer" }),
    JSON.stringify({ type: "dispatch", agentId: "implementer" }),
    "junk",
  ].join("\n");
  const by = telemetryStats(jsonl, "implementer", "2026-10-17");
  expect(by.on).toMatchObject({ runs: 3, median: 1 });
  expect(by.unavailable).toMatchObject({ runs: 1, median: 9 });
  expect(by.off).toMatchObject({ runs: 1, median: 7 });
});
