// Delivery as a pull request (docs/SDD-coordinator.md §4.5, phase 2 card 7).
//
// A project's `delivery` setting says how a finished card lands:
// - "local-merge", or unset: today's behaviour. The merge path
//   fast-forwards the user's checkout.
// - "pull-request": the merge path builds the same landing commit, but
//   against the remote's main branch, which it fetches first. It runs the
//   merge gate and then the project's host gates on the host, re-running a
//   failed command once when gateRetries is 1. Only when all are green
//   does it push the commit to the card's own branch and open a PR (draft
//   if set), or reuse the one already open for that branch. The PR is
//   recorded on the card (TaskCard.pr). The user's checkout is never
//   touched.
//
// Hard limits (§6) are code here: the branch can never be the main branch
// or another long-lived one, a push is never forced (a rejected push stops
// and reports), and the PR body names the card, the principal behind it
// and the policy revision, since commits carry no attribution.
import { renderCardTemplate, templateError } from "../core/card-templates.ts";
import type { TaskCard, TaskPullRequest } from "../core/types.ts";
import type { CommandRunner } from "../executors/claude-cli.ts";
import { ticketKeyOf } from "./ticket-refs.ts";

export interface PullRequestDelivery {
  mode: "pull-request";
  /** e.g. "feat/{ticket?}-{key?}-{slug}"; placeholders key, ticket, slug, id8. */
  branchPattern: string;
  /** PR body with {placeholders}: key, ticket, title, body, summary. */
  prTemplate?: string;
  /** argv commands run on the host after the merge gate. */
  hostGates: string[][];
  /** 1 re-runs a failed gate command once before calling it red. */
  gateRetries: 0 | 1;
  draft: boolean;
  /** The git remote to fetch from and push to. Default "origin". */
  remote?: string;
  /** The main branch PRs target. Default: the card's mergeTarget, else
   *  the branch the repo has checked out. */
  base?: string;
}

export type Delivery = { mode: "local-merge" } | PullRequestDelivery;

/** Branches a card's PR may never be pushed to, whatever the pattern. */
const LONG_LIVED = new Set(["main", "master", "develop", "trunk", "release", "production", "prod", "staging", "gh-pages"]);
const NAME = /^[A-Za-z0-9._-]+$/;
const BRANCH = /^(?!\/)(?!.*\/\/)(?!.*\.\.)(?!.*@\{)[A-Za-z0-9._\/-]+(?<![./])$/;
const MAX_GATE_COMMANDS = 20;

function argvList(v: unknown, name: string): string | undefined {
  if (!Array.isArray(v) || v.length > MAX_GATE_COMMANDS) return `${name} must be a list of at most ${MAX_GATE_COMMANDS} commands, each a list of strings (argv)`;
  for (const c of v) if (!Array.isArray(c) || c.length === 0 || !c.every((a) => typeof a === "string" && a !== "")) return `each ${name} command must be a non-empty list of non-empty strings`;
  return undefined;
}

/** Validates a `delivery` setting. `local-merge` reads back as no setting. */
export function validateDelivery(v: unknown): { ok: true; delivery: Delivery | null } | { ok: false; error: string } {
  if (v === null) return { ok: true, delivery: null };
  if (typeof v !== "object" || Array.isArray(v)) return { ok: false, error: 'delivery must be { "mode": "local-merge" } or { "mode": "pull-request", "branchPattern": ..., "hostGates": [...] }' };
  const d = v as Record<string, unknown>;
  if (d.mode === "local-merge") return Object.keys(d).length === 1 ? { ok: true, delivery: null } : { ok: false, error: "local-merge takes no other fields" };
  if (d.mode !== "pull-request") return { ok: false, error: 'delivery.mode must be "local-merge" or "pull-request"' };
  const allowed = ["mode", "branchPattern", "prTemplate", "hostGates", "gateRetries", "draft", "remote", "base"];
  const extra = Object.keys(d).find((k) => !allowed.includes(k));
  if (extra) return { ok: false, error: `unknown delivery field "${extra}"; expected ${allowed.join(", ")}` };
  if (typeof d.branchPattern !== "string" || !d.branchPattern.trim()) return { ok: false, error: "delivery.branchPattern is required, such as feat/{key?}-{slug}" };
  const patternErr = templateError(d.branchPattern);
  if (patternErr) return { ok: false, error: `delivery.branchPattern ${patternErr}` };
  if (!d.branchPattern.includes("{slug}") && !d.branchPattern.includes("{id8}") && !d.branchPattern.includes("{key}")) {
    return { ok: false, error: "delivery.branchPattern must include {slug}, {id8} or {key}, so each card gets its own branch" };
  }
  if (d.prTemplate !== undefined) {
    if (typeof d.prTemplate !== "string") return { ok: false, error: "delivery.prTemplate must be text" };
    const e = templateError(d.prTemplate);
    if (e) return { ok: false, error: `delivery.prTemplate ${e}` };
  }
  const hostGates = d.hostGates ?? [];
  const gateErr = argvList(hostGates, "delivery.hostGates");
  if (gateErr) return { ok: false, error: gateErr };
  const gateRetries = d.gateRetries ?? 0;
  if (gateRetries !== 0 && gateRetries !== 1) return { ok: false, error: "delivery.gateRetries must be 0 or 1" };
  const draft = d.draft ?? true;
  if (typeof draft !== "boolean") return { ok: false, error: "delivery.draft must be true or false" };
  if (d.remote !== undefined && (typeof d.remote !== "string" || !NAME.test(d.remote))) return { ok: false, error: "delivery.remote must be a remote name such as origin" };
  if (d.base !== undefined && (typeof d.base !== "string" || !BRANCH.test(d.base))) return { ok: false, error: "delivery.base must be a branch name such as main" };
  return {
    ok: true,
    delivery: {
      mode: "pull-request",
      branchPattern: d.branchPattern,
      ...(d.prTemplate ? { prTemplate: d.prTemplate as string } : {}),
      hostGates: hostGates as string[][],
      gateRetries,
      draft,
      ...(d.remote ? { remote: d.remote as string } : {}),
      ...(d.base ? { base: d.base as string } : {}),
    },
  };
}

/** Lower-case words of the title joined by dashes, at most 40 characters. */
export function slugOf(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "card"
  );
}

/** The branch a card's PR is pushed to, or why there can't be one. */
export function deliveryBranch(d: PullRequestDelivery, task: Pick<TaskCard, "id" | "title" | "key">, ticketPatterns: readonly string[] | undefined, base: string): { ok: true; branch: string } | { ok: false; error: string } {
  const values = { key: task.key, ticket: ticketKeyOf([task.title], ticketPatterns), slug: slugOf(task.title), id8: task.id.slice(0, 8) };
  const r = renderCardTemplate(d.branchPattern, values, "branch");
  if (!r.ok) return { ok: false, error: `can't name the PR branch: ${r.error}` };
  // An empty optional placeholder can leave "--" or a dangling "-".
  const branch = r.body.replace(/-{2,}/g, "-").replace(/(^|\/)-+/g, "$1").replace(/-+($|\/)/g, "$1");
  if (!BRANCH.test(branch)) return { ok: false, error: `"${branch}" is not a valid branch name` };
  const last = branch.split("/").pop()!;
  if (branch === base || LONG_LIVED.has(branch) || LONG_LIVED.has(last)) return { ok: false, error: `refusing to push a card to "${branch}": a card's PR never goes to the main branch or another long-lived one` };
  return { ok: true, branch };
}

export interface PrContext {
  principalId: string;
  policyRevision?: string;
  summary?: string;
  ticketPatterns?: readonly string[];
}

/** The PR's title and body. The body ends with the attribution chain
 *  (identity §4.6): card id, principal, policy revision. */
export function pullRequestText(d: PullRequestDelivery, task: Pick<TaskCard, "id" | "title" | "body" | "key">, ctx: PrContext): { title: string; body: string } {
  const values = { key: task.key, ticket: ticketKeyOf([task.title], ctx.ticketPatterns), title: task.title, body: task.body.slice(0, 4000), summary: ctx.summary?.slice(0, 4000) };
  const rendered = d.prTemplate ? renderCardTemplate(d.prTemplate, values, "PR") : undefined;
  const main = rendered?.ok ? rendered.body : `${task.body.slice(0, 4000)}${ctx.summary ? `\n\n## What the agent reported\n\n${ctx.summary.slice(0, 4000)}` : ""}`;
  const trailer = `---\nWissel card ${task.id}${task.key ? ` (${task.key})` : ""}, authorized by ${ctx.principalId}${ctx.policyRevision ? `, policy ${ctx.policyRevision}` : ""}.`;
  return { title: task.key ? `${task.key}: ${task.title}` : task.title, body: `${main.trim()}\n\n${trailer}` };
}

/** Where a PR is opened. The default goes through `gh` with fixed argv. */
export interface CodeHost {
  /** The open PR for `branch`, if any. */
  findOpen(repo: string, branch: string): Promise<{ number: number; url: string } | undefined>;
  open(repo: string, req: { branch: string; base: string; title: string; body: string; draft: boolean }): Promise<{ ok: true; number: number; url: string } | { ok: false; error: string }>;
  /** Turns auto-merge on, pinned to `headSha`: the code host refuses if
   *  the head moved (identity card 9). */
  arm?(repo: string, number: number, headSha: string): Promise<{ ok: true } | { ok: false; error: string }>;
}

function parsePrUrl(text: string): { number: number; url: string } | undefined {
  const m = /(https:\/\/\S+\/pull\/(\d+))/.exec(text);
  return m ? { url: m[1]!, number: Number(m[2]) } : undefined;
}

export function ghCodeHost(runner: CommandRunner): CodeHost {
  return {
    async findOpen(repo, branch) {
      const r = await runner(["gh", "pr", "list", "--head", branch, "--state", "open", "--json", "number,url", "--limit", "1"], { cwd: repo });
      if (r.exitCode !== 0) return undefined;
      try {
        const [pr] = JSON.parse(r.stdout) as Array<{ number: number; url: string }>;
        return pr && typeof pr.number === "number" && typeof pr.url === "string" && pr.url.startsWith("https://") ? pr : undefined;
      } catch {
        return undefined;
      }
    },
    async open(repo, req) {
      const r = await runner(["gh", "pr", "create", "--head", req.branch, "--base", req.base, "--title", req.title, "--body", req.body, ...(req.draft ? ["--draft"] : [])], { cwd: repo });
      const pr = parsePrUrl(r.stdout);
      if (r.exitCode !== 0 || !pr) return { ok: false, error: `gh pr create failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}` };
      return { ok: true, ...pr };
    },
    async arm(repo, number, headSha) {
      const r = await runner(["gh", "pr", "merge", String(number), "--auto", "--merge", "--match-head-commit", headSha], { cwd: repo });
      return r.exitCode === 0 ? { ok: true } : { ok: false, error: `gh pr merge --auto failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}` };
    },
  };
}

/** A gate runner that re-runs a failed command once (gateRetries 1). */
export function withRetry<R extends { exitCode: number | null; timedOut: boolean }, O>(run: (argv: string[], opts: O) => Promise<R>, retries: 0 | 1): (argv: string[], opts: O) => Promise<R> {
  if (retries === 0) return run;
  return async (argv, opts) => {
    const first = await run(argv, opts);
    if (first.exitCode === 0 && !first.timedOut) return first;
    console.warn(`delivery: \`${argv.join(" ")}\` failed; running it once more (gateRetries 1)`);
    return run(argv, opts);
  };
}

export type { TaskPullRequest };
