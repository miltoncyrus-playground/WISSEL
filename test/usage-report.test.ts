import { expect, test } from "bun:test";
import { formatReport, parseArgs, parseResultEvents, summarizeUsage } from "../scripts/usage-report.ts";

// `bun run usage:report` (docs/proposal-agent-run-efficiency.md item 1).

const usage = (turns: number, cacheRead: number, output = 1000) => ({ inputTokens: 10, cacheReadTokens: cacheRead, cacheWriteTokens: 5000, outputTokens: output, turns });
const LOG = [
  { type: "dispatch", taskId: "a", agentId: "implementer", at: "2026-10-11T01:00:00Z" },
  { type: "result", taskId: "a", agentId: "implementer", actualCost: 6, retryAfter: "2026-10-11T06:30:00Z", usage: usage(40, 4_000_000), at: "2026-10-11T02:00:00Z" },
  { type: "result", taskId: "a", agentId: "implementer", actualCost: 3, resumed: true, usage: usage(20, 2_000_000), at: "2026-10-11T07:00:00Z" },
  { type: "result", taskId: "b", agentId: "implementer", actualCost: 8, at: "2026-10-11T08:00:00Z" },
  { type: "result", taskId: "c", agentId: "reviewer", actualCost: 1, usage: usage(10, 500_000), at: "2026-10-11T09:00:00Z" },
  { type: "result", taskId: "old", agentId: "reviewer", actualCost: 50, at: "2026-10-01T00:00:00Z" },
]
  .map((e) => JSON.stringify(e))
  .join("\n")
  .concat("\nnot json\n{\"type\":\"result\"}\n");

const SINCE = new Date("2026-10-10T00:00:00Z");

test("parseResultEvents keeps well-formed result events only", () => {
  const events = parseResultEvents(LOG);
  expect(events.map((e) => e.taskId)).toEqual(["a", "a", "b", "c", "old"]);
});

test("summarizeUsage totals per agent, counts cut-off and resumed runs, and leaves pre-usage runs out of the token sums", () => {
  const { agents, tasks } = summarizeUsage(parseResultEvents(LOG), SINCE);
  const impl = agents.find((a) => a.agentId === "implementer")!;
  expect(agents.map((a) => a.agentId)).toEqual(["implementer", "reviewer"]); // by cost; "old" is before SINCE
  expect(impl).toMatchObject({ runs: 3, costUsd: 17, runsWithUsage: 2, turns: 60, cacheReadTokens: 6_000_000, cutByLimit: { runs: 1, costUsd: 6 }, resumed: { runs: 1, costUsd: 3 } });
  expect(tasks[0]).toEqual({ taskId: "a", agentId: "implementer", runs: 2, costUsd: 9, turns: 60, cacheReadTokens: 6_000_000 });
  expect(summarizeUsage(parseResultEvents(LOG), SINCE, "reviewer").agents.map((a) => a.agentId)).toEqual(["reviewer"]);
});

test("formatReport shows context per turn, the cut-off share and the top tasks", () => {
  const out = formatReport(summarizeUsage(parseResultEvents(LOG), SINCE), SINCE);
  expect(out).toContain("Agent usage since 2026-10-10");
  // implementer: 6M cache reads over 60 turns = 100k per turn.
  expect(out).toMatch(/implementer\s+3\s+\$17\.00\s+94%\s+30\s+100k/);
  expect(out).toContain("1 run(s) predate usage logging");
  expect(out).toContain("Spent on runs a session limit cut off: $6.00 (33%).");
  expect(out).toMatch(/a\s+implementer\s+\$9\.00\s+2 run\(s\), 60 turns, 100k context\/turn/);
  expect(formatReport({ agents: [], tasks: [] }, SINCE)).toContain("No results in this window.");
});

test("parseArgs: defaults to 7 days, takes --since and --agent, refuses junk", () => {
  const now = new Date("2026-10-11T12:00:00Z");
  expect(parseArgs([], now)).toEqual({ since: new Date("2026-10-04T12:00:00Z") });
  expect(parseArgs(["--since", "2026-10-10", "--agent", "implementer"], now)).toEqual({ since: new Date("2026-10-10"), agent: "implementer" });
  expect(parseArgs(["--since", "yesterday"], now)).toBe('--since needs a date like 2026-10-10, got "yesterday"');
  expect(parseArgs(["--agent"], now)).toBe("--agent needs an agent id");
  expect(parseArgs(["--verbose"], now)).toBe('unknown argument "--verbose"');
});
