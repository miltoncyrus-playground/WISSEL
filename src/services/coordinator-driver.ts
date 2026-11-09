import type { Project, ReviewPolicy, ReviewVerdict, TaskCard } from "../core/types.ts";
import type { Board } from "./board.ts";
import type { CoordinatorExecutor, ExecutableAction } from "./coordinator-executor.ts";
import type { DecisionCardKind } from "./decision-cards.ts";
import type { InboxEvent, InboxHandler } from "./inbox.ts";
import { buildFixRoundBody, evaluateReviewVerdict, reviewTextOf } from "./review-policy.ts";
import { ticketKeyOf } from "./ticket-refs.ts";
import type { ProjectRole, Workstream, WorkstreamStore } from "./workstreams.ts";

/**
 * The coordinator driver (docs/SDD-coordinator.md §4.1, §4.3, §4.13):
 * the deterministic handler for each inbox kind. A handler finds the
 * card's workstream and the project's role, builds ExecutableActions
 * and hands each to the executor, the only path to acting. The driver
 * is the same in every mode; only the gate differs: in Shadow the
 * executor records would-entries. Every action carries workstreamId,
 * projectId and a source-stable id (the inbox event id plus an index),
 * so a replayed event builds the same actions and the inbox, which
 * handles each id once, keeps them from repeating. Judgment (a red
 * gate, an open question) goes to a decision card through the injected
 * `openDecisionCard`; nothing here reads a model. Channel payloads are
 * data: an entry's text is quoted, never obeyed, and only the project's
 * decider is listened to. The owner and host sources have no event
 * kinds yet; the kinds here are the ones inboxEventFromBoardEvent and
 * inboxEventFromChannelEntry emit.
 */
export const DEFAULT_REVIEW_POLICY: ReviewPolicy = {
  tiers: [{ id: "default", when: "every card", reviewers: [{ model: "other-than-coder", mode: "standard" }], maxRounds: 3 }],
  blocks: ["HIGH", "MED-with-scenario"],
  carryForward: "drop",
  atCap: "ask-decider",
};

export interface DriverDeps {
  executor: Pick<CoordinatorExecutor, "execute">;
  board: Pick<Board, "get" | "list" | "getResult">;
  workstreams: Pick<WorkstreamStore, "get" | "list">;
  projects: { list(): Promise<Project[]> };
  /** Opens a §4.4 decision card for the event (triage-red, decide-default). */
  openDecisionCard: (kind: DecisionCardKind, event: InboxEvent, ctx: { projectId: string; decision?: string }) => Promise<unknown>;
  /** The structured verdict a card in review got; defaults to the latest
   *  result row of the card or of a child card that carries one. */
  reviewVerdictFor?: (card: TaskCard) => Promise<ReviewVerdict | undefined>;
  /** The branch an arm lands on; "main" until a project setting names it. */
  mainBranch?: string;
  logger?: { warn(message: string): void };
}

interface Scope { event: InboxEvent; ws: Workstream; projectId: string; role: ProjectRole; decider?: string; project?: Project }
type Draft = Omit<ExecutableAction, "id" | "workstreamId" | "projectId">;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);
const payloadOf = (event: InboxEvent): Record<string, unknown> => (isRecord(event.payload) ? event.payload : {});
const checksOf = (pr: NonNullable<TaskCard["pr"]>): "green" | "red" | "pending" => (pr.watch?.checks === "passing" ? "green" : pr.watch?.checks === "failing" ? "red" : "pending");
const label = (card: TaskCard): string => card.key ?? card.id;

export function createCoordinatorDriver(deps: DriverDeps): { handlers: Record<string, InboxHandler> } {
  const log = deps.logger ?? console;
  const mainBranch = deps.mainBranch ?? "main";

  /** The card's workstream (its own, else the one whose project owns its repo) and the project's role there. */
  async function scopeFor(event: InboxEvent, card: TaskCard | undefined): Promise<Scope | undefined> {
    const projects = await deps.projects.list();
    const owner = card?.repo ? projects.find((p) => p.path === card.repo) : undefined;
    const wsId = card?.workstreamId ?? event.workstreamId;
    let ws = wsId ? await deps.workstreams.get(wsId) : undefined;
    if (!ws && owner) ws = (await deps.workstreams.list()).find((w) => w.projects.some((e) => e.projectId === owner.id));
    const entry = ws && ((owner && ws.projects.find((e) => e.projectId === owner.id)) ?? ws.projects[0]);
    if (!ws || !entry) return undefined;
    return { event, ws, projectId: entry.projectId, role: entry.role, decider: entry.decider, project: projects.find((p) => p.id === entry.projectId) };
  }

  async function run(scope: Scope, drafts: Draft[]): Promise<void> {
    for (const [i, draft] of drafts.entries()) {
      await deps.executor.execute({ ...draft, id: `${scope.event.id}#${i}`, workstreamId: scope.ws.id, projectId: scope.projectId });
    }
  }

  const post = (about: Record<string, string>, message: Record<string, unknown>, more: Partial<Draft> = {}): Draft =>
    ({ kind: "channel.post", post: message.kind as string, ...more, payload: { message: { from: "wissel", about, ...message } } });
  const aboutCard = (card: TaskCard): Record<string, string> => ({ card: label(card), ...(card.pr ? { pr: String(card.pr.number) } : {}) });
  const ticketOf = (scope: Scope, card: TaskCard): string | undefined => ticketKeyOf([card.title, card.pr?.head], scope.project?.ticketPatterns) ?? scope.ws.ticket;

  /** A card that passed review: follow posts ready-to-merge, the deciding roles arm the PR (§4.13). */
  function readyActions(scope: Scope, card: TaskCard): Draft[] {
    const pr = card.pr;
    const about = aboutCard(card);
    if (!pr) return [post(about, { kind: "status", text: `${label(card)} passed review; there is no pull request yet to arm` })];
    const sha = pr.watch?.sha ?? pr.reviewedSha;
    if (scope.role === "follow") {
      return [sha ? post(about, { kind: "ready-to-merge", headSha: sha }) : post(about, { kind: "status", text: `${label(card)} passed review on PR #${pr.number}, head sha not yet seen` })];
    }
    return [{ kind: "pr.arm", base: mainBranch, checks: checksOf(pr), repo: card.repo, own: true, payload: { taskId: card.id, pr: pr.number, url: pr.url } }];
  }

  function fixRound(scope: Scope, card: TaskCard, verdict: ReviewVerdict, round: number): Draft[] {
    const review = reviewTextOf(verdict);
    const ticket = ticketOf(scope, card);
    const built = buildFixRoundBody(scope.project ?? {}, { round, review, key: card.key, ticket });
    if (!built.ok) {
      return [{ kind: "owner.task", payload: { title: `Fix round for ${label(card)} could not be built`, why: built.error, steps: ["Set the project's fix-round card template", "Re-run the review"], blocks: [card.id] } }];
    }
    const vars = { round: String(round), review, key: card.key, ticket, files: undefined };
    return [{ kind: "card.start", payload: { template: "fix-round", title: `Fix round ${round}: ${card.title}`, key: card.key, round, labels: ["fix-round"], vars, optional: ["key", "ticket", "files"] } }];
  }

  async function defaultVerdictFor(card: TaskCard): Promise<ReviewVerdict | undefined> {
    const own = await deps.board.getResult(card.id);
    const children = (await deps.board.list()).filter((t) => t.parentTaskId === card.id);
    const results = [own, ...(await Promise.all(children.map((c) => deps.board.getResult(c.id))))];
    const r = results.filter((x) => x?.verdict).pop();
    if (!r?.verdict) return undefined;
    // TaskResult flattens the verdict and feedback; findings ride along when a result row carries them.
    const findings = (r as { findings?: unknown }).findings;
    return { verdict: r.verdict, feedback: r.reviewFeedback ?? "", ...(Array.isArray(findings) ? { findings: findings as ReviewVerdict["findings"] } : {}) };
  }

  async function onReview(scope: Scope, card: TaskCard): Promise<Draft[]> {
    const verdict = await (deps.reviewVerdictFor ?? defaultVerdictFor)(card);
    if (!verdict) {
      log.warn(`driver: no review verdict for ${label(card)} (${card.id}); nothing to apply`);
      return [];
    }
    const policy = scope.project?.reviewPolicy ?? DEFAULT_REVIEW_POLICY;
    const tier = card.labels.find((l) => l.startsWith("tier:"))?.slice("tier:".length);
    const outcome = evaluateReviewVerdict(policy, tier, verdict, card.round);
    if (outcome.kind === "pass") return readyActions(scope, card);
    if (outcome.kind === "fix-round") return fixRound(scope, card, verdict, outcome.round);
    if (outcome.atCap === "accept") return readyActions(scope, card);
    const blocking = outcome.blocking.map((f) => `${f.severity}: ${f.title}`).join("; ") || "changes requested";
    return [post(aboutCard(card), {
      kind: "question", text: `${label(card)} is still blocked after ${outcome.maxRounds} fix rounds (${blocking}). What next?`,
      options: ["accept as is", "one more fix round", "ask about the spec"], lean: outcome.atCap === "spec-question" ? "ask about the spec" : "one more fix round",
    })];
  }

  /** A handler over the card an event names; no card or no workstream is a handled no-op. */
  const cardHandler = (build: (scope: Scope, card: TaskCard) => Promise<Draft[] | "decision-card">, decision?: DecisionCardKind): InboxHandler => async (event) => {
    const taskId = text(payloadOf(event).taskId);
    const card = taskId ? await deps.board.get(taskId) : undefined;
    const scope = card && (await scopeFor(event, card));
    if (!card || !scope) {
      log.warn(`driver: ${event.kind} (${event.id}) names no card in a workstream; nothing to do`);
      return;
    }
    const drafts = await build(scope, card);
    if (drafts === "decision-card") await deps.openDecisionCard(decision ?? "triage-red", event, { projectId: scope.projectId });
    else await run(scope, drafts);
  };

  /** A decider's entry read from the channel: a question opens a decide-default card; a decision or answer becomes the matching decision action. Everything else is input only. */
  const channelHandler: InboxHandler = async (event) => {
    const p = payloadOf(event);
    const m = isRecord(p.message) ? p.message : {};
    const from = text(m.from);
    if (!from || from === "wissel") return; // our own posts come back through read
    const about = isRecord(m.about) ? Object.fromEntries(Object.entries(m.about).filter((e): e is [string, string] => typeof e[1] === "string")) : {};
    const card = about.card && event.workstreamId ? (await deps.board.list()).find((t) => t.workstreamId === event.workstreamId && t.key === about.card) : undefined;
    const scope = await scopeFor(event, card);
    if (!scope) return;
    if (scope.decider && from !== scope.decider) return;
    const ref = text(p.ref) ?? event.id;
    const aboutOrId = Object.keys(about).length ? about : { card: event.id };
    if (m.kind === "question") {
      await deps.openDecisionCard("decide-default", event, { projectId: scope.projectId, decision: "default" });
    } else if (m.kind === "decision") {
      const decision = text(m.decision) ?? "default";
      await run(scope, [post(aboutOrId, { kind: "decision", decision, text: `${text(m.text) ?? "(no text)"} (decided by ${from} on the channel, entry ${ref})` }, { decision })]);
    } else if (m.kind === "answer") {
      await run(scope, [post(aboutOrId, { kind: "decision", decision: "default", text: `${text(m.text) ?? "(no text)"} (answer by ${from} to question ${text(m.questionRef) ?? "?"}, entry ${ref})` }, { decision: "default" })]);
    }
  };

  const handlers: Record<string, InboxHandler> = {
    "card.review": cardHandler(onReview),
    "card.failed": cardHandler(async () => "decision-card", "triage-red"),
    "card.escalated": cardHandler(async (_scope, card) => [{
      kind: "owner.task",
      payload: { title: `Escalated ${label(card)}: ${card.title}`, why: card.escalationContext ?? "escalated without a reason", steps: ["Read the card and its last review", "Decide: retry, fix by hand, or drop it"], blocks: [card.id] },
    }]),
    "pr.checks": cardHandler(async (scope, card) => {
      const { checks, sha } = payloadOf(scope.event);
      if (checks === "failing") return "decision-card";
      const ready = card.pr && (card.pr.reviewedSha === sha || card.pr.lifecycle === "ready");
      return checks === "passing" && ready ? readyActions(scope, card) : [];
    }, "triage-red"),
    "pr.dirty": cardHandler(async (_scope, card) => [post(aboutCard(card), { kind: "status", text: `PR #${card.pr?.number ?? "?"} for ${label(card)} is DIRTY against ${mainBranch}; merge-forward owns the fix` })]),
    "pr.merged": cardHandler(async (scope, card) => {
      const ticket = ticketOf(scope, card);
      return [
        ...(ticket ? [{ kind: "ticket.transition", payload: { key: ticket, to: "done", taskId: card.id, pr: card.pr?.number } } satisfies Draft] : []),
        post(aboutCard(card), { kind: "status", text: `PR #${card.pr?.number ?? "?"} for ${label(card)} merged${ticket ? `; ${ticket} moves to done` : ""}` }),
      ];
    }),
  };
  for (const kind of ["claim", "release", "ready-to-merge", "question", "answer", "decision", "status", "handover"]) handlers[`channel.${kind}`] = channelHandler;
  // The owner's window messages (channel-sinks.ts, §4.14) are recorded for the record; the window itself runs the quick actions.
  handlers["owner.message"] = async () => {};
  return { handlers };
}
