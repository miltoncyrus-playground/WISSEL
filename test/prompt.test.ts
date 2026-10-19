import { expect, test } from "bun:test";
import { buildAgentPrompt } from "../src/core/prompt.ts";
import { Registry } from "../src/core/registry.ts";
import type { AgentDef, TaskCard } from "../src/core/types.ts";

const agent: AgentDef = {
  id: "reviewer",
  name: "Reviewer",
  kind: "agent",
  tier: "readonly",
  description: "Reviews a diff against repo conventions and prior decisions.",
  whenToUse: "A branch or PR exists and needs review before merge.",
  tags: ["review"],
  executor: "readonly",
  inputs: ["diff"],
  outputs: ["approval-decision"],
  trustLevel: "medium",
  toolAccess: ["read"],
  costProfile: { model: "claude-sonnet-5", estUsdPerTask: 0.12 },
};

const task: TaskCard = {
  id: "t1",
  title: "Review this diff",
  body: "Check it against conventions.",
  labels: ["review"],
  repo: "/tmp",
  status: "ready",
};

test("omits any contract framing when outputContract is undefined", () => {
  const prompt = buildAgentPrompt(task, agent);
  expect(prompt).not.toContain("review-verdict");
});

test("appends outputContract verbatim to the end of the prompt when present", () => {
  const contract = 'End with a ```review-verdict``` block containing {"verdict": ..., "feedback": ...}.';
  const prompt = buildAgentPrompt(task, { ...agent, outputContract: contract });
  expect(prompt.endsWith(contract)).toBe(true);
  // Still carries the normal task framing ahead of the contract.
  expect(prompt).toContain(task.title);
  expect(prompt).toContain(task.body);
  expect(prompt.indexOf(task.body)).toBeLessThan(prompt.indexOf(contract));
});

// Memory (docs/SDD-memory-curator.md §9) — buildAgentPrompt itself never
// touches the filesystem; the caller (runClaude/runCodex) reads
// memory/lessons.md and passes its content through this parameter.

test("omits the memory section entirely when no memory content is given — first run, nothing to regress", () => {
  const prompt = buildAgentPrompt(task, agent);
  expect(prompt).not.toContain("Lessons learned from prior sessions");
});

test("omits the memory section for an explicitly empty string too, not just undefined", () => {
  const prompt = buildAgentPrompt(task, agent, "");
  expect(prompt).not.toContain("Lessons learned from prior sessions");
});

test("includes prior-session memory verbatim when given, ahead of any output/verification contract", () => {
  const memory = "- Always run `bun test` before reporting done.\n- Never touch node_modules directly.";
  const contract = 'End with a ```review-verdict``` block.';
  const prompt = buildAgentPrompt(task, { ...agent, outputContract: contract }, memory);

  expect(prompt).toContain("Lessons learned from prior sessions:");
  expect(prompt).toContain(memory);
  expect(prompt.indexOf(memory)).toBeLessThan(prompt.indexOf(contract));
  // Still carries the normal task framing too.
  expect(prompt).toContain(task.title);
  expect(prompt).toContain(task.body);
});

// Regression: readonly agents (reviewer, planner, repo-briefer) run under
// --permission-mode plan, which has no ExitPlanMode/AskUserQuestion tool
// wired up in headless `claude -p` mode. Confirmed live 2026-09-24/25 —
// the model periodically tries to call ExitPlanMode anyway, fails, and
// writes a plan file instead of the required output-contract block,
// which the parser then correctly fails closed on (real paid runs
// wasted). buildAgentPrompt's planMode option is the fix.

test("omits the plan-mode note when planMode is not requested", () => {
  const prompt = buildAgentPrompt(task, agent);
  expect(prompt).not.toContain("ExitPlanMode");
});

test("omits the plan-mode note when planMode is explicitly false", () => {
  const prompt = buildAgentPrompt(task, agent, undefined, { planMode: false });
  expect(prompt).not.toContain("ExitPlanMode");
});

test("appends an explicit ExitPlanMode-unavailable note when planMode is requested", () => {
  const prompt = buildAgentPrompt(task, agent, undefined, { planMode: true });
  expect(prompt).toContain("ExitPlanMode");
  expect(prompt).toContain("no plan-approval step available");
});

test("plan-mode note comes after the output contract, so it's the last thing the model reads", () => {
  const contract = 'End with a ```review-verdict``` block.';
  const prompt = buildAgentPrompt(task, { ...agent, outputContract: contract }, undefined, { planMode: true });
  expect(prompt.indexOf(contract)).toBeLessThan(prompt.indexOf("ExitPlanMode"));
  expect(prompt.trim().endsWith("per the output contract above.")).toBe(true);
});

// Pending-approval MCP tools (docs/SDD-mcp-orchestration.md §3.5) — only
// ever appended when the caller (runClaude) found at least one
// approval-required grant for this run.

test("omits the mcp-approval-request instruction when pendingMcpApprovalTools is undefined", () => {
  const prompt = buildAgentPrompt(task, agent);
  expect(prompt).not.toContain("mcp-approval-request");
});

test("omits the mcp-approval-request instruction for an explicitly empty array too — byte-identical to undefined", () => {
  const withEmpty = buildAgentPrompt(task, agent, undefined, { pendingMcpApprovalTools: [] });
  const withUndefined = buildAgentPrompt(task, agent);
  expect(withEmpty).toBe(withUndefined);
  expect(withEmpty).not.toContain("mcp-approval-request");
});

test("appends an instruction naming every pending-approval server/tool pair and the fenced-block contract", () => {
  const prompt = buildAgentPrompt(task, agent, undefined, {
    pendingMcpApprovalTools: [
      { server: "slack", tool: "send_message" },
      { server: "jira", tool: "create_ticket" },
    ],
  });
  expect(prompt).toContain("slack/send_message");
  expect(prompt).toContain("jira/create_ticket");
  expect(prompt).toContain("```mcp-approval-request");
  expect(prompt).toContain("NOT available to you in this session");
});

test("the mcp-approval-request instruction comes after the output contract but before the plan-mode note", () => {
  const contract = 'End with a ```review-verdict``` block.';
  const prompt = buildAgentPrompt(task, { ...agent, outputContract: contract }, undefined, {
    planMode: true,
    pendingMcpApprovalTools: [{ server: "slack", tool: "send_message" }],
  });
  expect(prompt.indexOf(contract)).toBeLessThan(prompt.indexOf("mcp-approval-request"));
  expect(prompt.indexOf("mcp-approval-request")).toBeLessThan(prompt.indexOf("ExitPlanMode"));
  // The plan-mode note is still the literal last thing in the prompt.
  expect(prompt.trim().endsWith("per the output contract above.")).toBe(true);
});

// --- Per-project verification commands (docs/SDD-project-settings.md §7)
// The write-tier contracts in agents/manifest.yaml carry two tokens,
// {{verification.run}} and {{verification.commands}}, rendered by
// renderVerificationContract (src/core/verification.ts) from the
// project's `verification` setting. The first two tests below pin the
// no-setting case to the exact text the manifest carried before the
// tokens existed: a project with no settings must get a byte-identical
// prompt.

const FINN_VERIFICATION = {
  commands: [
    ["uv", "run", "pytest"],
    ["uv", "run", "ruff", "check"],
    ["uv", "run", "pyright"],
  ],
  allowedTools: ["Bash(uv run pytest:*)", "Bash(uv run ruff check:*)", "Bash(uv run pyright:*)"],
};

const IMPLEMENTER_CONTRACT_BEFORE_TOKENS = [
  "Before reporting done, run:",
  "  bun run typecheck",
  "  bun test test/",
  "If either fails, fix it and re-run both — do not report done with",
  "either one red. If a failure is pre-existing and clearly unrelated",
  "to your change (confirm this by checking whether it also fails on",
  "a clean checkout before your edits), say so explicitly in your",
  "summary instead of silently leaving it broken.",
  "",
  "Do not run `git add`, `git commit`, or `git push` — that is",
  "deliberately not available to you here, not a sandbox glitch to",
  "route around. Landing your changes happens automatically when a",
  "human merges this work (`POST /tasks/:id/merge` already runs `git",
  "add -A` + `git commit` against whatever you leave in the worktree,",
  "using the task title as the message — see",
  "`mergeTaskWorktree`/`src/services/worktree.ts`). Report your",
  "status from the code and tests alone; do not treat a git-write",
  "denial as a concern to flag or a blocker to work around.",
  "",
  "Tools: read and search with Read, Grep and Glob; change files with",
  "Edit and Write, never sed -i or shell redirects. Run `bun test` and",
  "`bun run typecheck` as plain commands: no pipes, no `time`, no",
  "redirects. Never run `bun -e` or `node -e`.",
].join("\n");

const STEERING_BEFORE_TOKENS = [
  "Tools: read and search with Read, Grep and Glob; change files with",
  "Edit and Write, never sed -i or shell redirects. Run `bun test` and",
  "`bun run typecheck` as plain commands: no pipes, no `time`, no",
  "redirects. Never run `bun -e` or `node -e`.",
].join("\n");

const writeTask: TaskCard = { ...task, id: "w1", title: "Add subtract()", body: "Add subtract(a, b) next to add.", labels: ["code"] };

test("implementer, no project verification: the rendered contract is byte-identical to the manifest text before the tokens existed", async () => {
  const implementer = (await Registry.load()).get("implementer")!;
  const prompt = buildAgentPrompt(writeTask, implementer);
  expect(prompt.endsWith(`\n\n${IMPLEMENTER_CONTRACT_BEFORE_TOKENS}\n`)).toBe(true);
  expect(prompt).not.toContain("{{");
  // An explicit undefined is the same as omitting the option.
  expect(buildAgentPrompt(writeTask, implementer, undefined, { verification: undefined })).toBe(prompt);
});

test("fixer, integrator and lint-fixer, no project verification: the steering sentence is byte-identical to before", async () => {
  const registry = await Registry.load();
  for (const id of ["fixer", "integrator", "lint-fixer"]) {
    const prompt = buildAgentPrompt(writeTask, registry.get(id)!);
    expect({ id, tail: prompt.slice(prompt.indexOf("Tools: read and search")) }).toEqual({ id, tail: `${STEERING_BEFORE_TOKENS}\n` });
  }
});

test("implementer with a project verification: the contract names those commands, keeps the git and pre-existing-failure rules, and never the bun pair", async () => {
  const implementer = (await Registry.load()).get("implementer")!;
  const prompt = buildAgentPrompt(writeTask, implementer, undefined, { verification: FINN_VERIFICATION });
  expect(prompt).toContain("Before reporting done, run each of these as a plain command (no\npipes, no redirects):\n  uv run pytest\n  uv run ruff check\n  uv run pyright\n");
  expect(prompt).toContain("re-run all of them until every one is\ngreen. Do not report done with any of them red.");
  expect(prompt).toContain("If a failure is\npre-existing and clearly unrelated to your change");
  expect(prompt).toContain("Do not run `git add`, `git commit`, or `git push`");
  expect(prompt).toContain("Run `uv run pytest`, `uv run ruff check` and `uv run pyright` as plain commands: no pipes, no `time`, no\nredirects.");
  // The generic steering stays as the manifest words it.
  expect(prompt).toContain("Never run `bun -e` or `node -e`.");
  expect(prompt).not.toContain("bun test");
  expect(prompt).not.toContain("bun run typecheck");
  expect(prompt).not.toContain("{{");
  // Same framing ahead of the contract as the default case.
  expect(prompt).toContain(writeTask.title);
  expect(prompt).toContain(writeTask.body);
});

test("fixer, integrator and lint-fixer with a project verification: the steering sentence names the project's commands", async () => {
  const registry = await Registry.load();
  for (const id of ["fixer", "integrator", "lint-fixer"]) {
    const prompt = buildAgentPrompt(writeTask, registry.get(id)!, undefined, { verification: FINN_VERIFICATION });
    expect({ id, ok: prompt.includes("Run `uv run pytest`, `uv run ruff check` and `uv run pyright` as plain commands") }).toEqual({ id, ok: true });
    expect({ id, bun: prompt.includes("bun test") }).toEqual({ id, bun: false });
  }
});

test("a contract without tokens (every readonly agent) is untouched by a project verification", async () => {
  const registry = await Registry.load();
  for (const a of registry.all().filter((a) => a.tier !== "write" && a.verificationContract)) {
    const plain = buildAgentPrompt(task, a, undefined, { planMode: true });
    const withVerification = buildAgentPrompt(task, a, undefined, { planMode: true, verification: FINN_VERIFICATION });
    expect({ id: a.id, same: withVerification === plain }).toEqual({ id: a.id, same: true });
  }
});

test("a verification with grants but no commands says so instead of listing nothing", async () => {
  const implementer = (await Registry.load()).get("implementer")!;
  const prompt = buildAgentPrompt(writeTask, implementer, undefined, { verification: { commands: [] } });
  expect(prompt).toContain("This project has no verification commands configured.");
  expect(prompt).toContain("Run the project's verification commands as plain commands");
  expect(prompt).not.toContain("bun test");
  expect(prompt).not.toContain("{{");
});
