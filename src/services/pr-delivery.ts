/**
 * Delivery as a pull request (docs/SDD-coordinator.md §4.5): a finished
 * card lands in a fresh worktree on the host, never in the card sandbox
 * or the user's checkout. Branch from the card's base; apply its diff,
 * staging explicit paths only; merge main; run Project.mergeGate then
 * `hostGates` (each under the gate's timeout, re-run once when
 * `gateRetries` is 1); only if all are green push and open the PR. A red
 * gate after its retry never pushes. `local-merge` stays mergeTaskWorktree.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { wisselHome } from "../core/wissel-home.ts";
import type { CommandRunner } from "../executors/claude-cli.ts";
import type { Delivery, PullRequestDelivery, TaskCard } from "../core/types.ts";
import { DEFAULT_GATE_TIMEOUT_MS, runMergeGate, type GateCommandRunner, type GateReport, type MergeGateConfig } from "./merge-gate.ts";
import { ticketKeyOf } from "./ticket-refs.ts";
import { stageCardChanges, validateMergeTarget, type TaskWorktree } from "./worktree.ts";

export interface PrDeliveryContext {
  runner: CommandRunner; // git in the repo and its worktrees
  host?: CommandRunner; // `git push` and `gh`, the only commands that reach the code host; defaults to `runner`, tests fake it
  gateRunner?: GateCommandRunner;
  mergeGate?: MergeGateConfig; // the project's gate; its timeout and env apply to the host gates too
  homeDir?: string;
  ticketPatterns?: string[];
}

/** `branch` is the PR head; `pushed` says whether it reached the remote. `pushed` and `checked` are
 *  pushToPullRequestBranch's green outcomes (the latter a dry run that stopped after the gates). */
export interface PrDeliveryResult {
  ok: boolean;
  outcome: "opened" | "pushed" | "checked" | "gate-failed" | "conflict" | "nothing" | "error";
  message: string;
  branch: string;
  pr?: NonNullable<TaskCard["pr"]>;
  gate: GateReport;
  hostGate: GateReport;
  pushed: boolean;
}

const NO_GATE: GateReport = { status: "none", runs: [], durationMs: 0 };

/** `{placeholders}` filled from the card; an unknown one stays literal. */
function render(template: string, task: TaskCard, ticketPatterns?: string[]): string {
  const slug = task.title
    .toLowerCase()
    .replace(/\b[a-z][a-z0-9]+-\d+\b/g, "") // the ticket key has its own placeholder
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const values: Record<string, string> = { id: task.id, key: task.key ?? "", title: task.title, body: task.body, slug, ticket: ticketKeyOf([task.title, task.body], ticketPatterns) ?? "" };
  return template.replace(/\{(\w+)\}/g, (m, name: string) => values[name] ?? m);
}

export function deliveryBranchName(pattern: string, task: TaskCard, ticketPatterns?: string[]): string {
  // An empty placeholder leaves a doubled or dangling separator behind.
  const name = render(pattern, task, ticketPatterns)
    .replace(/[-_]{2,}/g, "-")
    .replace(/(^|\/)[-_]+|[-_]+(?=\/|$)/g, "$1")
    .replace(/\/{2,}/g, "/");
  // A pattern that rendered to nothing git accepts falls back to the card's own branch name.
  return name !== "" && validateMergeTarget(name).ok ? name : `wissel/${task.id}`;
}

export function renderPrBody(template: string | undefined, task: TaskCard, ticketPatterns?: string[]): string {
  return template === undefined ? `${task.body}\n\ntask: ${task.id}` : render(template, task, ticketPatterns);
}

/** Validates a `delivery` setting as it arrives from the API or the DB. */
export function validateDelivery(value: unknown): { ok: true; delivery: Delivery } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, error: 'delivery must be { "mode": "local-merge" } or a pull-request object' };
  const v = value as Record<string, unknown>;
  if (v.mode === "local-merge") {
    return Object.keys(v).length === 1 ? { ok: true, delivery: { mode: "local-merge" } } : { ok: false, error: "delivery local-merge takes no other fields" };
  }
  if (v.mode !== "pull-request") return { ok: false, error: 'delivery.mode must be "local-merge" or "pull-request"' };
  const { mode: _mode, branchPattern, prTemplate, hostGates, gateRetries, draft, ...rest } = v;
  const extra = Object.keys(rest)[0];
  if (extra !== undefined) return { ok: false, error: `unknown delivery field "${extra}"; expected branchPattern, prTemplate, hostGates, gateRetries, draft` };
  const probe = typeof branchPattern === "string" ? validateMergeTarget(branchPattern.replace(/\{\w+\}/g, "x")) : { ok: false as const, error: "must be a string" };
  if (!probe.ok || !probe.target) return { ok: false, error: `delivery.branchPattern (like feat/{ticket}-{key}-{slug}): ${probe.ok ? "must not be empty" : probe.error}` };
  if (prTemplate !== undefined && typeof prTemplate !== "string") return { ok: false, error: "delivery.prTemplate must be a string" };
  if (!Array.isArray(hostGates) || hostGates.some((c) => !Array.isArray(c) || c.length === 0 || !c.every((a) => typeof a === "string" && a !== ""))) {
    return { ok: false, error: "delivery.hostGates must be a list of commands, each a non-empty list of non-empty strings (argv)" };
  }
  if (gateRetries !== 0 && gateRetries !== 1) return { ok: false, error: "delivery.gateRetries must be 0 or 1" };
  if (typeof draft !== "boolean") return { ok: false, error: "delivery.draft must be true or false" };
  return { ok: true, delivery: { mode: "pull-request", branchPattern: branchPattern as string, hostGates: hostGates as string[][], gateRetries, draft, ...(prTemplate !== undefined ? { prTemplate } : {}) } };
}

type Git = (cwd: string, args: string[], stdin?: string) => Promise<{ ok: boolean; stdout: string; text: string }>;

const gitIn =
  (runner: CommandRunner): Git =>
  async (cwd, args, stdin) => {
    const r = await runner(["git", ...args], { cwd, ...(stdin !== undefined ? { stdin } : {}) });
    return { ok: r.exitCode === 0, stdout: r.stdout, text: (r.stderr || r.stdout).trim() };
  };

/** Runs `gate` and, when it fails and `retries` is 1, once more; the report is the last run's with every attempt's runs. */
async function gateWithRetry(gate: MergeGateConfig | undefined, cwd: string, retries: 0 | 1, runner?: GateCommandRunner): Promise<GateReport> {
  const first = await runMergeGate(gate, cwd, runner);
  if (first.status !== "failed" || retries === 0) return first;
  const second = await runMergeGate(gate, cwd, runner);
  return { ...second, runs: [...first.runs, ...second.runs], durationMs: first.durationMs + second.durationMs };
}

/** Where the card's work goes: a new PR branch from where the card left main (`open`), or an existing PR branch as
 *  origin has it (`push`, a fix round's commits; `dryRun` stops after the gates). */
type LandTarget = { kind: "open" } | { kind: "push"; branch: string; dryRun: boolean };

export async function deliverAsPullRequest(repo: string, worktree: TaskWorktree, task: TaskCard, delivery: PullRequestDelivery, ctx: PrDeliveryContext): Promise<PrDeliveryResult> {
  return land(repo, worktree, task, delivery, ctx, { kind: "open" });
}

/**
 * A fix round's new commits onto an existing PR branch (§4.3 branch.push): the card's diff applied on the branch as
 * fetched from origin, the base merged forward, Project.mergeGate then `hostGates`, and only when green a plain push
 * of HEAD to the branch. Never a force push: a branch that moved on the remote meanwhile is rejected by git itself.
 * `dryRun` is the executor's pushStillGreen re-check before a queued push flushes: the same steps, no push.
 */
export async function pushToPullRequestBranch(repo: string, worktree: TaskWorktree, task: TaskCard, branch: string, delivery: PullRequestDelivery, ctx: PrDeliveryContext, opts: { dryRun?: boolean } = {}): Promise<PrDeliveryResult> {
  return land(repo, worktree, task, delivery, ctx, { kind: "push", branch, dryRun: opts.dryRun ?? false });
}

async function land(repo: string, worktree: TaskWorktree, task: TaskCard, delivery: PullRequestDelivery, ctx: PrDeliveryContext, target: LandTarget): Promise<PrDeliveryResult> {
  const git = gitIn(ctx.runner);
  const host = ctx.host ?? ctx.runner;
  const hostPath = join(wisselHome(ctx.homeDir), "deliveries", task.id);
  // The PR branch must not be the card's own branch, which the card worktree has checked out.
  const named = deliveryBranchName(delivery.branchPattern, task, ctx.ticketPatterns);
  const branch = target.kind === "push" ? target.branch : named === worktree.branch ? `${named}-pr` : named;
  const commitMessage = `${task.title}\n\ntask: ${task.id}`;
  let [gate, hostGate, pushed] = [NO_GATE, NO_GATE, false];
  const fail = (outcome: PrDeliveryResult["outcome"], message: string): PrDeliveryResult => ({ ok: false, outcome, message, branch, gate, hostGate, pushed });
  // Only a branch this delivery created is ever deleted (`created`), never one that was already there.
  let created = false;
  const cleanup = async (keepBranch: boolean) => {
    await git(repo, ["worktree", "remove", "--force", hostPath]);
    if (!keepBranch && created) await git(repo, ["branch", "-D", branch]);
  };

  if (!existsSync(worktree.path)) return fail("error", `the worktree ${worktree.path} is gone: this card was already delivered or discarded`);

  // The card's uncommitted work becomes its branch tip, explicit paths only.
  const staged = await stageCardChanges(ctx.runner, worktree.path);
  if (!staged.ok) return fail("error", `failed to stage the card's changes: ${staged.error}`);
  if (staged.paths.length) {
    const commit = await git(worktree.path, ["commit", "-q", "-m", commitMessage]);
    if (!commit.ok) return fail("error", `failed to commit the card's changes: ${commit.text}`);
  }

  const hasBranch = async (name: string) => (await git(repo, ["rev-parse", "--verify", "-q", `refs/heads/${name}^{commit}`])).ok;
  // The card's merge target when it names one that exists, else main, else master.
  const main = task.mergeTarget && validateMergeTarget(task.mergeTarget).ok && (await hasBranch(task.mergeTarget)) ? task.mergeTarget : (await hasBranch("main")) ? "main" : "master";
  // A push starts from the PR branch as origin has it, so a commit someone else pushed is built on, never overwritten.
  let startSha = "";
  if (target.kind === "push") {
    const fetched = await host(["git", "fetch", "-q", "origin", branch], { cwd: repo });
    if (fetched.exitCode !== 0) return fail("error", `couldn't fetch ${branch} from origin: ${(fetched.stderr || fetched.stdout).trim()}`);
    startSha = (await git(repo, ["rev-parse", "FETCH_HEAD"])).stdout.trim();
  }
  const from = target.kind === "push" ? startSha : main;
  const baseRes = await git(repo, ["merge-base", from, `refs/heads/${worktree.branch}`]);
  if (!baseRes.ok) return fail("error", `couldn't find where ${worktree.branch} branched from ${target.kind === "push" ? branch : main}: ${baseRes.text}`);
  const baseSha = baseRes.stdout.trim();
  const diff = await git(repo, ["diff", "--binary", "--no-color", "--no-ext-diff", baseSha, `refs/heads/${worktree.branch}`]);
  if (!diff.ok) return fail("error", `couldn't read the card's diff: ${diff.text}`);
  if (diff.stdout === "") return fail("nothing", `nothing to deliver: ${worktree.branch} has no change past ${target.kind === "push" ? branch : main}`);

  // 1. A fresh host worktree: on a new PR branch from the card's base, or detached at the PR branch's fetched tip.
  await cleanup(true); // a stale host worktree from an earlier attempt; branches are never touched here
  if (target.kind === "open" && (await hasBranch(branch))) return fail("error", `the branch ${branch} already exists in ${repo}; delete it or change delivery.branchPattern. Nothing was pushed.`);
  const add = await git(repo, ["worktree", "add", "-q", ...(target.kind === "open" ? ["-b", branch, hostPath, baseSha] : ["--detach", hostPath, startSha])]);
  if (!add.ok) return fail("error", `couldn't create the delivery worktree for ${branch}: ${add.text}`);
  created = target.kind === "open";
  try {
    // 2. The card's diff, staged by explicit path, as its own commit.
    const applied = await git(hostPath, ["apply", "--binary", "--whitespace=nowarn"], diff.stdout);
    if (!applied.ok) return fail("error", `couldn't apply the card's diff in the delivery worktree: ${applied.text}`);
    const hostStaged = await stageCardChanges(ctx.runner, hostPath);
    if (!hostStaged.ok) return fail("error", `couldn't stage the card's paths in the delivery worktree: ${hostStaged.error}`);
    const committed = await git(hostPath, ["commit", "-q", "-m", commitMessage]);
    if (!committed.ok) return fail("error", `couldn't commit the card's changes in the delivery worktree: ${committed.text}`);

    // 3. Main merged in; a conflict is reported, never resolved here. Unlike the local merge, the conflict is not left in the
    //    card worktree for the conflict integrator: the merge ran in the delivery worktree, which is aborted and removed, so the
    //    caller (orchestrator deliverPullRequest) sends the card to review with this message for a person.
    const merged = await git(hostPath, ["merge", "-q", "--no-edit", `refs/heads/${main}`]);
    if (!merged.ok) {
      const conflicted = (await git(hostPath, ["diff", "--name-only", "--diff-filter=U"])).stdout.trim().split("\n").filter(Boolean);
      await git(hostPath, ["merge", "--abort"]);
      return fail("conflict", `${branch} conflicts with ${main} in: ${conflicted.join(", ") || "unknown files"}. Nothing was pushed.`);
    }

    // 4. The project's gate, then the host gates, each with its retry.
    gate = await gateWithRetry(ctx.mergeGate, hostPath, delivery.gateRetries, ctx.gateRunner);
    if (gate.status === "failed") return fail("gate-failed", gate.feedback ?? "merge gate failed; nothing was pushed");
    const timeoutMs = ctx.mergeGate?.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
    hostGate = await gateWithRetry({ commands: delivery.hostGates, timeoutMs, ...(ctx.mergeGate?.env ? { env: ctx.mergeGate.env } : {}) }, hostPath, delivery.gateRetries, ctx.gateRunner);
    if (hostGate.status === "failed") return fail("gate-failed", hostGate.feedback ?? "host gate failed; nothing was pushed");

    // 5. All green: push, then the PR. A push onto an existing branch is HEAD to that ref, never forced, and opens nothing.
    if (target.kind === "push" && target.dryRun) return { ok: true, outcome: "checked", message: `${branch} is still green after merging ${main}; nothing was pushed`, branch, gate, hostGate, pushed };
    const pushArgs = target.kind === "open" ? ["-u", "origin", branch] : ["origin", `HEAD:refs/heads/${branch}`];
    const push = await host(["git", "push", ...pushArgs], { cwd: hostPath });
    if (push.exitCode !== 0) return fail("error", `\`git push ${pushArgs.join(" ")}\` failed: ${(push.stderr || push.stdout).trim()}`);
    pushed = true;
    if (target.kind === "push") return { ok: true, outcome: "pushed", message: `pushed ${task.title} to ${branch} with ${main} merged forward`, branch, gate, hostGate, pushed };
    const body = renderPrBody(delivery.prTemplate, task, ctx.ticketPatterns);
    const created = await host(["gh", "pr", "create", "--head", branch, "--base", main, "--title", task.title, "--body", body, ...(delivery.draft ? ["--draft"] : [])], { cwd: hostPath });
    if (created.exitCode !== 0) return fail("error", `\`gh pr create\` failed after pushing ${branch}: ${(created.stderr || created.stdout).trim()}`);
    const url = created.stdout.trim().split("\n").find((l) => /\/pull\/\d+/.test(l)) ?? "";
    const number = Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? NaN);
    if (!url || Number.isNaN(number)) return fail("error", `\`gh pr create\` printed no PR URL for ${branch}: ${created.stdout.trim()}`);
    return { ok: true, outcome: "opened", message: `opened ${delivery.draft ? "draft " : ""}PR #${number} from ${branch} onto ${main}: ${url}`, branch, gate, hostGate, pushed, pr: { number, url, head: branch } };
  } finally {
    // The worktree never outlives the attempt; the branch stays only once pushed.
    await cleanup(pushed);
  }
}
