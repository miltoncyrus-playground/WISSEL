#!/usr/bin/env bun
/**
 * Live smoke test for docs/SDD-mcp-orchestration.md §6 Subtask 7 — the
 * heterogeneous pipeline integration proof: a real `PipelineDef`
 * (src/core/mcp-integration-pipeline.ts) with one step bound to the
 * existing coding agent (`implementer`) and one step bound to a new
 * MCP-tool-calling agent (`mcp-tool-caller`, agents/manifest.yaml),
 * driven end to end through `startPipelineRun` — mirrors
 * eval/pipeline-review-handoff.eval.ts's own structure exactly: real
 * `claude -p` calls, a real git worktree for the coding step, and (new
 * here) a real, attached MCP server for the tool-calling step. Nothing
 * mocked or scripted.
 *
 * The MCP server is a real, minimal, hand-rolled stdio JSON-RPC 2.0
 * server (eval/fixtures/mcp-echo-server.ts) — there's no official
 * `@modelcontextprotocol/sdk` dependency anywhere in this repo, and this
 * eval is specifically about proving real end-to-end behavior against a
 * genuine MCP protocol implementation, not scripting around one. Its
 * `McpServerPool` is built here, test-local, rather than registered in
 * the checked-in `mcp-servers.yaml`: a stdio server's `command`/`args`
 * get spawned with *the task's own cwd* (the coding step's worktree, or
 * the MCP step's scratch/inherited dir), never the wissel repo root, so
 * a portable, checked-in-anywhere path can't be hardcoded there the way
 * `mcp-servers.yaml`'s own doc-comment examples assume — this eval can
 * compute an absolute path at run time instead (`import.meta.dir`), the
 * same reasoning `test/claude-cli.test.ts`'s own `mcpServer()` helper
 * already uses to build fixture servers inline rather than editing the
 * checked-in registry. See agents/manifest.yaml's own `mcp-tool-caller`
 * comment for why that agent's own `mcpAccess` naming this server id is
 * still a permanent, real manifest entry despite the server itself being
 * eval-local.
 *
 * `agents/manifest.yaml`'s own decision, stated plainly: `mcp-tool-caller`
 * is a PERMANENT entry (not a test-local Registry override), mirroring
 * how `pipeline-reviewer` was added as a real, permanent agent for
 * docs/SDD-pipelines.md §6 Subtask 5's own integration proof. Reasoning:
 * a generic "call this run's granted MCP tool and report what happened"
 * agent is reusable by any future pipeline step that needs one, not a
 * throwaway fixture — and it's completely inert in production (its grant
 * names a server id, `wissel-echo-mcp`, that the real `mcp-servers.yaml`
 * never registers, so `resolveMcpGrants` silently drops it to `[]`
 * everywhere outside this eval's own locally-constructed pool).
 *
 * Two scenarios, run as two separate executions of the same stored
 * `PipelineDef` (same reasoning `pipeline-review-handoff.eval.ts` reuses
 * one `pipelineDef` across its two fixtures — only the `input` differs):
 *
 * - **Scenario 1 (the card's required proof)**: the coding step adds a
 *   trivial file; the MCP step calls the granted `echo` tool (declared
 *   `trust: "auto"` in this eval's own pool) and reports what it
 *   returned. Expected: the whole run reaches `done`, and the MCP step's
 *   own `TaskCard` result carries a real, non-empty `mcpCalls` — proving
 *   `pipeline-runner.ts` composes a file-editing step and a real
 *   MCP-tool-calling step with zero new runner primitives (see
 *   `runStepAndSuccessors`, src/core/pipeline-runner.ts — it only ever
 *   calls `executor.run()`; the MCP wiring lives entirely inside
 *   `ReadOnlyExecutor`/`runClaude`, already exercised the same way for
 *   any other task).
 * - **Scenario 2 (the additional composition question this subtask's own
 *   card named, not something subtask 3 had reason to test against the
 *   pipeline engine)**: the MCP step is asked to call `echo_sensitive`
 *   instead — declared `trust: "approval-required"` in this eval's pool,
 *   so the agent can't actually call it (excluded from `--allowedTools`
 *   — see `splitGrantsByTrust`, src/executors/mcp-config.ts) and is
 *   instructed instead to describe it via a trailing
 *   ```mcp-approval-request``` block (see `buildAgentPrompt`'s own
 *   `pendingMcpApprovalTools` instruction, src/core/prompt.ts). Expected:
 *   the MCP step's own `TaskCard` lands on `"review"` with
 *   `pendingMcpApproval` set — NOT silently `"done"` (ok:true) and NOT
 *   `"failed"`.
 *
 *   This scenario is exactly what caught a real, concrete bug while
 *   building this eval: `finishResult`'s pipeline-step branch
 *   (src/core/orchestrator.ts) ran its own unconditional
 *   `board.move(task.id, result.ok ? "done" : "failed")` *before* ever
 *   checking `result.mcpApprovalRequest` — a pipeline step describing a
 *   blocked call (ok: true) landed straight on "done" instead of
 *   surfacing the approval gate at all. Fixed by checking
 *   `result.mcpApprovalRequest` first, mirroring the non-pipeline path's
 *   own priority order exactly (see that function's own comment). A
 *   second, related bug this same scenario surfaced:
 *   `pipeline-runner.ts`'s own `settleRoot` would have declared the
 *   whole run "done" the moment no step had *failed* — even though a
 *   step was still parked on "review" awaiting a human's approve/deny
 *   decision. Fixed by treating any "review"-status step under the run
 *   as "not settled yet" (see `settleRoot`'s own comment) — the run now
 *   correctly stays `"running"` instead. **So, to directly answer this
 *   subtask's own named question: pipeline-runner.ts (and its
 *   `finishResult` caller) did NOT need zero changes — the ordinary
 *   coding-step + auto-trust-MCP-tool-step composition (Scenario 1) truly
 *   needed none, confirming the card's "likely good news" for that path,
 *   but the approval-gate composition (Scenario 2) needed these two real
 *   fixes.** Both are covered by a scripted gate test
 *   (test/pipeline-runner.test.ts) that reproduces the exact bug this
 *   eval's own live Scenario 2 would otherwise have hit silently.
 *
 * Not run by `bun test` (gate lane) — invoke explicitly with `bun run
 * eval:pipeline-mcp-integration` before ship / nightly, same as this
 * project's other evals (see eval/README.md).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteBoard } from "../src/services/board.ts";
import { SqlitePipelineStore } from "../src/services/pipelines.ts";
import { Registry } from "../src/core/registry.ts";
import { McpServerPool } from "../src/core/mcp-server-pool.ts";
import { startPipelineRun, type PipelineRunnerContext } from "../src/core/pipeline-runner.ts";
import { WriteExecutor } from "../src/executors/write.ts";
import { ReadOnlyExecutor } from "../src/executors/readonly.ts";
import { runViaBun } from "../src/executors/claude-cli.ts";
import {
  MCP_INTEGRATION_PIPELINE_DESCRIPTION,
  MCP_INTEGRATION_PIPELINE_NAME,
  buildMcpIntegrationPipelineGraph,
} from "../src/core/mcp-integration-pipeline.ts";
import type { McpServer, TaskCard } from "../src/core/types.ts";

function git(args: string[], cwd: string): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
  }
}

async function realRepo(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `wissel-eval-${prefix}-`));
  git(["init", "-q"], dir);
  git(["config", "user.email", "wissel-eval@example.com"], dir);
  git(["config", "user.name", "wissel eval"], dir);
  git(["commit", "--allow-empty", "-q", "-m", "seed"], dir);
  return dir;
}

/** See this file's own header comment for why this pool is built here,
 *  test-local, rather than registered in the checked-in
 *  mcp-servers.yaml. */
function echoServerPool(): McpServerPool {
  const serverScript = `${import.meta.dir}/fixtures/mcp-echo-server.ts`;
  const server: McpServer = {
    id: "wissel-echo-mcp",
    label: "Wissel echo (eval fixture)",
    transport: { kind: "stdio", command: "bun", args: ["run", serverScript] },
    enabled: true,
    tools: [
      { name: "echo", trust: "auto" },
      { name: "echo_sensitive", trust: "approval-required" },
    ],
  };
  return McpServerPool.from([server]);
}

interface ScenarioOutcome {
  name: string;
  pass: boolean;
  detail: string;
}

async function costOf(board: SqliteBoard, cards: TaskCard[]): Promise<number> {
  let total = 0;
  for (const card of cards) {
    const result = await board.getResult(card.id);
    if (result?.actualCost) total += result.actualCost;
  }
  return total;
}

async function main(): Promise<void> {
  const homeDir = await mkdtemp(join(tmpdir(), "wissel-eval-pipeline-mcp-integration-home-"));
  const board = new SqliteBoard();
  const pipelines = new SqlitePipelineStore(board.db);
  const registry = await Registry.load();
  const runner = runViaBun;
  const mcpServers = echoServerPool();
  const executors = [new WriteExecutor({ runner, homeDir, mcpServers }), new ReadOnlyExecutor({ runner, mcpServers })];
  const ctx: PipelineRunnerContext = { executors, pipelines };
  const pipelineDef = await pipelines.create({
    name: MCP_INTEGRATION_PIPELINE_NAME,
    description: MCP_INTEGRATION_PIPELINE_DESCRIPTION,
    graph: buildMcpIntegrationPipelineGraph(),
  });

  const repos: string[] = [];
  try {
    const outcomes: ScenarioOutcome[] = [];
    let totalCost = 0;

    // --- Scenario 1: the card's required proof -------------------------
    const repo1 = await realRepo("mcp-integration");
    repos.push(repo1);
    const input1 = [
      "Add a new file `pipeline-proof.txt` to the repo root containing exactly the single line: pipeline proof",
      "Do not modify or create any other files.",
      "",
      "If you are the MCP-tool-calling step instead of the coding step: do not touch any files at all. " +
        'Call the `echo` tool (on the `wissel-echo-mcp` server) with exactly {"text": "pipeline proof"}, then ' +
        "report in your final message exactly what result it returned.",
    ].join("\n");

    console.log('Running scenario 1 ("code -> call echo") through startPipelineRun (real claude, real worktree, real MCP server)...');
    const root1 = await startPipelineRun(board, registry, pipelineDef, repo1, input1, ctx);
    const steps1 = (await board.list()).filter((t) => t.pipelineRunId === root1.id);
    const codeCard1 = steps1.find((t) => t.pipelineStepId === "code");
    const toolCard1 = steps1.find((t) => t.pipelineStepId === "call-tool");
    const toolResult1 = toolCard1 ? await board.getResult(toolCard1.id) : undefined;
    totalCost += await costOf(board, [...steps1, root1]);

    const pass1 =
      root1.status === "done" &&
      codeCard1?.status === "done" &&
      toolCard1?.status === "done" &&
      Boolean(toolResult1?.mcpCalls && toolResult1.mcpCalls.length > 0);
    outcomes.push({
      name: "scenario-1-coding-plus-mcp-tool",
      pass: pass1,
      detail: `root=${root1.status}, code=${codeCard1?.status ?? "(none)"}, call-tool=${toolCard1?.status ?? "(none)"}, mcpCalls=${JSON.stringify(toolResult1?.mcpCalls ?? null)}`,
    });

    // --- Scenario 2: the approval-gate composition question ------------
    const repo2 = await realRepo("mcp-integration-approval");
    repos.push(repo2);
    const input2 = [
      "Add a new file `pipeline-proof.txt` to the repo root containing exactly the single line: pipeline proof",
      "Do not modify or create any other files.",
      "",
      "If you are the MCP-tool-calling step instead of the coding step: do not touch any files at all. " +
        'Attempt to call the `echo_sensitive` tool (on the `wissel-echo-mcp` server) with exactly {"text": "needs review"}. ' +
        "Follow whatever instructions you're given about tools that require human approval, if that one does.",
    ].join("\n");

    console.log('Running scenario 2 ("code -> request approval for echo_sensitive") through startPipelineRun...');
    const root2 = await startPipelineRun(board, registry, pipelineDef, repo2, input2, ctx);
    const steps2 = (await board.list()).filter((t) => t.pipelineRunId === root2.id);
    const toolCard2 = steps2.find((t) => t.pipelineStepId === "call-tool");
    totalCost += await costOf(board, [...steps2, root2]);

    const pass2 =
      root2.status === "running" &&
      toolCard2?.status === "review" &&
      toolCard2.pendingMcpApproval?.server === "wissel-echo-mcp" &&
      toolCard2.pendingMcpApproval?.tool === "echo_sensitive";
    outcomes.push({
      name: "scenario-2-approval-gate-composition",
      pass: pass2,
      detail: `root=${root2.status}, call-tool=${toolCard2?.status ?? "(none)"}, pendingMcpApproval=${JSON.stringify(toolCard2?.pendingMcpApproval ?? null)}`,
    });

    console.log("");
    for (const o of outcomes) {
      console.log(`${o.pass ? "PASS" : "FAIL"}  ${o.name}  (${o.detail})`);
    }
    console.log(`\nTotal real cost this run: $${totalCost.toFixed(4)}`);

    const overallPass = outcomes.every((o) => o.pass);
    if (!overallPass) {
      process.exit(1);
    }
  } finally {
    for (const repo of repos) {
      await rm(repo, { recursive: true, force: true });
    }
    await rm(homeDir, { recursive: true, force: true });
  }
}

await main();
