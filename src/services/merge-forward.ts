/**
 * Merge-forward on DIRTY and the arming rules (docs/SDD-coordinator.md
 * §4.7, §4.13).
 *
 * The PR watcher (github-status.ts) emits `pr.dirty` when a card's PR
 * stops being mergeable. This service turns that into exactly one
 * merge-forward card per PR head: the card's body opens with a marker
 * line (`merge-forward: <repo>#<number>@<sha>`) that is the idempotency
 * key, so a replayed event, a second tick or a restart never starts a
 * second card for the same conflict. A push that moves the head is a
 * new conflict and may get a new card. When a merge-forward card
 * finishes (status `done` or `review`), the files its resolution touched
 * decide whether a narrow re-review card follows: docs and tests only
 * keep the earlier review; anything else gets one re-review, keyed the
 * same way (`re-review: <merge-forward card id>`).
 *
 * canArm is the pure arming rule the executor will consult before
 * `pr.arm`. Nothing here calls the code host.
 */

import type { EventEmitter } from "node:events";
import type { CommandRunner } from "../executors/claude-cli.ts";
import type { PrRef, Project, TaskCard, TaskResult } from "../core/types.ts";
import type { Board, BoardEvent } from "./board.ts";
import { renderCardTemplateFor } from "./card-templates.ts";

// --- Arming rules (§4.7, §4.13) --------------------------------------------

export interface ArmCheck {
  name: string;
  result: "passed" | "skipped" | "pending" | "failed";
}

export interface ArmInput {
  /** The PR's base branch and the project's main branch. */
  base: string;
  main: string;
  /** The PR's head sha and the sha the review passed on, if any. */
  head: string;
  reviewedSha?: string;
  checks: readonly ArmCheck[];
}

/** Whether a PR may be armed (auto-merge on): only when its base is the
 *  main branch, its head is the sha the review passed on and every
 *  check passed or was skipped. A pending check is not a passed one;
 *  no checks at all is fine. Pure; the watcher re-checks after a push. */
export function canArm(input: ArmInput): { ok: boolean; reason: string } {
  if (input.base !== input.main) return { ok: false, reason: `base ${input.base} is not the main branch ${input.main}` };
  if (!input.head) return { ok: false, reason: "the PR has no head sha" };
  if (!input.reviewedSha) return { ok: false, reason: "no review has passed on any sha of this PR" };
  if (input.head !== input.reviewedSha) return { ok: false, reason: `head ${input.head} is not the reviewed sha ${input.reviewedSha}` };
  for (const c of input.checks) {
    if (c.result === "failed") return { ok: false, reason: `check "${c.name}" failed` };
    if (c.result === "pending") return { ok: false, reason: `check "${c.name}" is still pending` };
  }
  return { ok: true, reason: `head ${input.head} is reviewed and every check passed or was skipped` };
}

// --- Merge-forward cards ----------------------------------------------------

/** Both are `integrator`'s tags (agents/manifest.yaml) and no other
 *  agent's, so the card routes there with full confidence. */
export const MERGE_FORWARD_LABELS: readonly string[] = ["merge", "conflict"];
const MARKER_RE = /^merge-forward: (.+)$/m;
const RE_REVIEW_RE = /^re-review: (\S+)$/m;

/** A docs or test file: markdown and plain text anywhere, anything
 *  under docs/, and the usual test layouts and suffixes. */
const DOCS_OR_TESTS = /(^|\/)(docs|__tests__|tests?)\/|\.(md|mdx|txt|rst|adoc)$|\.(test|spec)\.[a-z]+$|_test\.[a-z]+$|(^|\/)test_[^/]+\.py$/;

/** Whether `files` touches product code: anything that is not docs or
 *  tests. Unknown (undefined) counts as touched, so a resolution whose
 *  diff could not be read still gets its re-review. */
export function touchesProductCode(files: string[] | undefined): boolean {
  if (files === undefined) return true;
  return files.some((f) => !DOCS_OR_TESTS.test(f));
}

function markerFor(repo: string, pr: PrRef): string {
  return `${repo}#${pr.number}@${pr.watch?.sha ?? ""}`;
}

function mergeForwardTitle(card: Pick<TaskCard, "id" | "pr">): string {
  return `Merge forward PR #${card.pr!.number}: ${card.id}`;
}

/** Every merge-forward card for this PR head, archived or not, any status. */
export async function mergeForwardCards(board: Pick<Board, "list">, pr: PrRef, repo: string): Promise<TaskCard[]> {
  const marker = markerFor(repo, pr);
  return (await board.list()).filter((t) => MARKER_RE.exec(t.body)?.[1] === marker);
}

/** The body of a merge-forward card: the marker line, then the project's
 *  `merge-forward` template (with `{pr}`, `{url}`, `{branch}`, `{sha}`,
 *  `{main}`, `{title}`, `{card}`; `{key}` and `{ticket}` optional) and its
 *  cardRules. Without a template, or when it refuses to render, the
 *  built-in brief: a DIRTY PR is never left waiting on a template. */
export function buildMergeForwardBody(project: Pick<Project, "cardRules" | "cardTemplates">, card: TaskCard): string {
  const pr = card.pr!;
  const main = card.mergeTarget ?? "main";
  const vars = { pr: String(pr.number), url: pr.url, branch: pr.head, sha: pr.watch?.sha, main, title: card.title, card: card.id, key: card.key, ticket: undefined };
  const rendered = project.cardTemplates?.["merge-forward"] !== undefined ? renderCardTemplateFor(project, "merge-forward", vars, { optional: ["key", "ticket", "sha"] }) : undefined;
  const brief = rendered?.ok
    ? rendered.body
    : [
        `PR #${pr.number} (${pr.url}) for "${card.title}" (card ${card.id}) on branch \`${pr.head}\` can no longer be merged: \`${main}\` moved and the two conflict.`,
        `Merge \`${main}\` into \`${pr.head}\`, resolve every conflict keeping both sides' intent, and run the project's checks on the result.`,
        "Do not push and do not force anything: the delivery path lands the branch once this card is done.",
        ...(project.cardRules?.trim() ? ["", project.cardRules.trim()] : []),
      ].join("\n");
  return `merge-forward: ${markerFor(card.repo ?? "", pr)}\n\n${brief}`;
}

function reReviewBody(mergeForward: TaskCard, files: string[] | undefined): string {
  const list = files === undefined ? ["(the resolution's files could not be read; review the whole merge commit)"] : files.filter((f) => !DOCS_OR_TESTS.test(f)).map((f) => `- ${f}`);
  return [
    `re-review: ${mergeForward.id}`,
    "",
    `The merge-forward card ${mergeForward.id} ("${mergeForward.title}") resolved conflicts and touched product code, so the earlier review no longer covers the head.`,
    "Review only the resolution: the files below, as changed by the merge commit. Docs and tests it also touched are not listed.",
    "",
    ...list,
  ].join("\n");
}

/** The files a finished card's merge commit changed against all its
 *  parents (`git show` on a merge commit is the combined diff: exactly
 *  the resolution), read in its worktree. Undefined when unreadable. */
export function touchedFilesWith(runner: CommandRunner): (card: TaskCard, result: TaskResult | undefined) => Promise<string[] | undefined> {
  return async (_card, result) => {
    if (!result?.worktree) return undefined;
    const out = await runner(["git", "show", "--name-only", "--format=", "--no-renames", "-z", "HEAD"], { cwd: result.worktree.path });
    return out.exitCode === 0 ? out.stdout.split("\0").filter(Boolean) : undefined;
  };
}

export interface MergeForwardOptions {
  board: Pick<Board, "list" | "get" | "create" | "getResult"> & { events: EventEmitter };
  /** The project's templates and rules (ProjectStore.settingsFor). */
  settingsFor: (repo: string) => Promise<Pick<Project, "cardRules" | "cardTemplates"> | undefined>;
  /** What a finished merge-forward's resolution changed; touchedFilesWith in the server. */
  touchedFiles: (card: TaskCard, result: TaskResult | undefined) => Promise<string[] | undefined>;
  logger?: Pick<Console, "warn">;
}

export interface MergeForwardService {
  /** Resolves once every event received so far has been handled. */
  settle(): Promise<void>;
  stop(): void;
}

/** Listens to the board: `pr.dirty` starts the merge-forward card, a
 *  merge-forward card reaching `done` or `review` starts the re-review
 *  when warranted. Each is created at most once (see the module note). */
export function startMergeForward(opts: MergeForwardOptions): MergeForwardService {
  const log = opts.logger ?? console;
  // Events are handled one at a time: the "already exists" check and the
  // create must not interleave with the same event's replay.
  let queue: Promise<void> = Promise.resolve();

  const onDirty = async (task: TaskCard): Promise<void> => {
    if (!task.pr || !task.repo) return;
    if ((await mergeForwardCards(opts.board, task.pr, task.repo)).length > 0) return;
    const project = (await opts.settingsFor(task.repo).catch(() => undefined)) ?? {};
    await opts.board.create({
      title: mergeForwardTitle(task),
      body: buildMergeForwardBody(project, task),
      labels: [...MERGE_FORWARD_LABELS],
      repo: task.repo,
      parentTaskId: task.id,
      ...(task.harnessOverride ? { harnessOverride: task.harnessOverride } : {}),
      ...(task.mergeTarget ? { mergeTarget: task.mergeTarget } : {}),
    });
  };

  const onMoved = async (task: TaskCard): Promise<void> => {
    if ((task.status !== "done" && task.status !== "review") || !MARKER_RE.test(task.body)) return;
    const key = `re-review: ${task.id}`;
    if ((await opts.board.list()).some((t) => RE_REVIEW_RE.exec(t.body)?.[0] === key)) return;
    const files = await opts.touchedFiles(task, await opts.board.getResult(task.id));
    if (!touchesProductCode(files)) return;
    const parent = task.parentTaskId ? await opts.board.get(task.parentTaskId) : undefined;
    const number = parent?.pr?.number ?? MARKER_RE.exec(task.body)?.[1]?.split("@")[0]?.split("#")[1] ?? "?";
    await opts.board.create({
      title: `Re-review merge-forward of PR #${number}: ${parent?.id ?? task.parentTaskId ?? task.id}`,
      body: reReviewBody(task, files),
      labels: ["review"],
      repo: task.repo,
      parentTaskId: task.id,
      ...(task.harnessOverride ? { harnessOverride: task.harnessOverride } : {}),
      ...(task.mergeTarget ? { mergeTarget: task.mergeTarget } : {}),
    });
  };

  const handler = (e: BoardEvent): void => {
    if (e.type !== "pr.dirty" && e.type !== "task.moved") return;
    const task = e.task;
    queue = queue
      .then(() => (e.type === "pr.dirty" ? onDirty(task) : onMoved(task)))
      .catch((err: unknown) => log.warn(`merge-forward: ${e.type} failed: ${err instanceof Error ? err.message : String(err)}`));
  };
  opts.board.events.on("event", handler);
  return {
    settle: async () => {
      // A handler may enqueue more (a create emits events); drain until the chain is quiet.
      let last: Promise<void> | undefined;
      while (last !== queue) await (last = queue);
    },
    stop: () => opts.board.events.off("event", handler),
  };
}
