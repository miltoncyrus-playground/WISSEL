// Owner tasks (docs/SDD-coordinator.md §3.4, §4.14; phase 1 card 4):
// something only the owner can do, such as signing in again, freeing a
// disk or approving an outside account. Each says why, lists its steps as
// tick-boxes, may name the cards waiting on it, and may carry a `check`
// that Wissel runs when the owner says Done.
//
// Each owner task is backed by a card labelled "owner", held in review, so
// it shows in Needs a human with its why and steps through the existing
// lanes (needs-you.ts). The cards it blocks get that card as a dependency,
// so they wait the way any card waits on another. Done (after a passing
// check) or Dismiss moves the backing card to done, which releases them.
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { Board } from "./board.ts";
import type { CommandRunner } from "../executors/claude-cli.ts";

export type OwnerTaskStatus = "open" | "done" | "dismissed";

export interface OwnerTaskCheck {
  ok: boolean;
  exitCode: number;
  /** The end of stdout and stderr, at most CHECK_OUTPUT_CHARS. */
  output: string;
  at: string;
}

export interface OwnerTask {
  id: string;
  title: string;
  why: string;
  steps: string[];
  /** argv Wissel runs after Done; exit 0 means done. No shell. */
  check?: string[];
  /** Card ids waiting on it. */
  blocks: string[];
  status: OwnerTaskStatus;
  /** The card that shows it on the board. */
  cardId: string;
  createdAt: string;
  closedAt?: string;
  lastCheck?: OwnerTaskCheck;
}

export interface NewOwnerTask {
  title: string;
  why: string;
  steps: string[];
  check?: string[];
  blocks?: string[];
}

export const OWNER_TASK_LABEL = "owner";
export const MAX_OWNER_TASK_STEPS = 20;
export const MAX_CHECK_ARGS = 32;
export const CHECK_TIMEOUT_MS = 120_000;
export const CHECK_OUTPUT_CHARS = 2000;

/** Why a new owner task's body is refused, or undefined. `why` and at
 *  least one step are required: the Needs a human lane promises both. */
export function ownerTaskError(input: unknown): string | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return "body must be { title, why, steps, check?, blocks? }";
  const b = input as Record<string, unknown>;
  const allowed = ["title", "why", "steps", "check", "blocks"];
  const extra = Object.keys(b).find((k) => !allowed.includes(k));
  if (extra) return `unknown field "${extra}"; expected ${allowed.join(", ")}`;
  if (typeof b.title !== "string" || !b.title.trim() || b.title.length > 200) return "title must be 1 to 200 characters";
  if (typeof b.why !== "string" || !b.why.trim() || b.why.length > 4000) return "why must say, in 1 to 4000 characters, why only the owner can do this";
  if (!Array.isArray(b.steps) || b.steps.length === 0 || b.steps.length > MAX_OWNER_TASK_STEPS || !b.steps.every((s) => typeof s === "string" && s.trim() && s.length <= 500)) {
    return `steps must be 1 to ${MAX_OWNER_TASK_STEPS} non-empty lines, each at most 500 characters`;
  }
  if (b.check !== undefined && (!Array.isArray(b.check) || b.check.length === 0 || b.check.length > MAX_CHECK_ARGS || !b.check.every((a) => typeof a === "string" && a !== ""))) {
    return `check must be a command as a list of 1 to ${MAX_CHECK_ARGS} non-empty strings (argv, no shell)`;
  }
  if (b.blocks !== undefined && (!Array.isArray(b.blocks) || b.blocks.length > 100 || !b.blocks.every((id) => typeof id === "string" && /^[A-Za-z0-9-]{1,64}$/.test(id)))) {
    return "blocks must be a list of card ids";
  }
  return undefined;
}

/** The backing card's body: the why, then the steps. */
export function ownerTaskBody(t: Pick<OwnerTask, "why" | "steps" | "check">): string {
  const steps = t.steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
  const check = t.check ? `\n\nWhen you press Done, Wissel runs \`${t.check.join(" ")}\` and closes this only if it passes.` : "";
  return `${t.why}\n\nSteps:\n${steps}${check}`;
}

interface Row {
  id: string;
  title: string;
  why: string;
  steps: string;
  checkArgv: string | null;
  blocks: string;
  status: OwnerTaskStatus;
  cardId: string;
  createdAt: string;
  closedAt: string | null;
  lastCheck: string | null;
}

const toTask = (r: Row): OwnerTask => ({
  id: r.id,
  title: r.title,
  why: r.why,
  steps: JSON.parse(r.steps) as string[],
  ...(r.checkArgv ? { check: JSON.parse(r.checkArgv) as string[] } : {}),
  blocks: JSON.parse(r.blocks) as string[],
  status: r.status,
  cardId: r.cardId,
  createdAt: r.createdAt,
  ...(r.closedAt ? { closedAt: r.closedAt } : {}),
  ...(r.lastCheck ? { lastCheck: JSON.parse(r.lastCheck) as OwnerTaskCheck } : {}),
});

export type DoneOutcome = { ok: true; task: OwnerTask } | { ok: false; status: 404 | 409; error: string; task?: OwnerTask };

export class OwnerTaskStore {
  constructor(
    private readonly db: Database,
    private readonly board: Board,
    private readonly clock: () => Date = () => new Date(),
  ) {
    db.run(`
      CREATE TABLE IF NOT EXISTS owner_tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        why TEXT NOT NULL,
        steps TEXT NOT NULL,
        checkArgv TEXT,
        blocks TEXT NOT NULL,
        status TEXT NOT NULL,
        cardId TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        closedAt TEXT,
        lastCheck TEXT
      );
    `);
    db.run("CREATE INDEX IF NOT EXISTS idx_owner_tasks_cardId ON owner_tasks(cardId);");
  }

  /** Raises an owner task: its card goes to review (Needs a human), and
   *  each card it blocks waits on that card. Unknown block ids are
   *  refused before anything is written. */
  async create(input: NewOwnerTask): Promise<{ ok: true; task: OwnerTask } | { ok: false; error: string }> {
    const blocks = [...new Set(input.blocks ?? [])];
    const blocked = await Promise.all(blocks.map((id) => this.board.get(id)));
    const unknown = blocks.filter((_, i) => !blocked[i]);
    if (unknown.length > 0) return { ok: false, error: `no such card: ${unknown.join(", ")}` };
    const card = await this.board.create({ title: input.title, body: ownerTaskBody(input), labels: [OWNER_TASK_LABEL] });
    await this.board.move(card.id, "review");
    const task: OwnerTask = {
      id: randomUUID(),
      title: input.title,
      why: input.why,
      steps: input.steps,
      ...(input.check ? { check: input.check } : {}),
      blocks,
      status: "open",
      cardId: card.id,
      createdAt: this.clock().toISOString(),
    };
    this.db.run("INSERT INTO owner_tasks (id, title, why, steps, checkArgv, blocks, status, cardId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
      task.id,
      task.title,
      task.why,
      JSON.stringify(task.steps),
      task.check ? JSON.stringify(task.check) : null,
      JSON.stringify(blocks),
      task.status,
      task.cardId,
      task.createdAt,
    ]);
    for (const b of blocked) if (b && !b.dependsOn?.includes(card.id)) await this.board.setDependencies(b.id, [...(b.dependsOn ?? []), card.id]);
    return { ok: true, task };
  }

  get(id: string): OwnerTask | undefined {
    const r = this.db.query("SELECT * FROM owner_tasks WHERE id = ?").get(id) as Row | null;
    return r ? toTask(r) : undefined;
  }

  byCard(cardId: string): OwnerTask | undefined {
    const r = this.db.query("SELECT * FROM owner_tasks WHERE cardId = ?").get(cardId) as Row | null;
    return r ? toTask(r) : undefined;
  }

  /** Newest first. */
  list(status?: OwnerTaskStatus): OwnerTask[] {
    const rows = (status ? this.db.query("SELECT * FROM owner_tasks WHERE status = ? ORDER BY createdAt DESC, rowid DESC").all(status) : this.db.query("SELECT * FROM owner_tasks ORDER BY createdAt DESC, rowid DESC").all()) as Row[];
    return rows.map(toTask);
  }

  /** The owner says it's done. Runs the check first, when there is one:
   *  only exit 0 closes the task; otherwise it stays open with what the
   *  check printed. Closing moves the backing card to done, which lets
   *  the blocked cards go. */
  async done(id: string, runner: CommandRunner, timeoutMs = CHECK_TIMEOUT_MS): Promise<DoneOutcome> {
    const task = this.get(id);
    if (!task) return { ok: false, status: 404, error: "no such owner task" };
    if (task.status !== "open") return { ok: false, status: 409, error: `owner task is already ${task.status}` };
    if (task.check) {
      const check = await runCheck(task.check, runner, timeoutMs, this.clock);
      this.db.run("UPDATE owner_tasks SET lastCheck = ? WHERE id = ?", [JSON.stringify(check), id]);
      if (!check.ok) return { ok: false, status: 409, error: `the check \`${task.check.join(" ")}\` did not pass (exit ${check.exitCode}); the task stays open`, task: this.get(id)! };
    }
    return { ok: true, task: await this.close(task, "done") };
  }

  /** Not needed after all: closes it without a check. */
  async dismiss(id: string): Promise<DoneOutcome> {
    const task = this.get(id);
    if (!task) return { ok: false, status: 404, error: "no such owner task" };
    if (task.status !== "open") return { ok: false, status: 409, error: `owner task is already ${task.status}` };
    return { ok: true, task: await this.close(task, "dismissed") };
  }

  private async close(task: OwnerTask, status: "done" | "dismissed"): Promise<OwnerTask> {
    this.db.run("UPDATE owner_tasks SET status = ?, closedAt = ? WHERE id = ?", [status, this.clock().toISOString(), task.id]);
    if (await this.board.get(task.cardId)) await this.board.move(task.cardId, "done");
    return this.get(task.id)!;
  }
}

async function runCheck(argv: string[], runner: CommandRunner, timeoutMs: number, clock: () => Date): Promise<OwnerTaskCheck> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
      timer = setTimeout(() => resolve({ stdout: "", stderr: `timed out after ${Math.round(timeoutMs / 1000)}s`, exitCode: 124 }), timeoutMs);
    });
    const r = await Promise.race([runner(argv, { cwd: process.cwd() }), timeout]);
    const output = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`.trim();
    return { ok: r.exitCode === 0, exitCode: r.exitCode, output: output.slice(-CHECK_OUTPUT_CHARS), at: clock().toISOString() };
  } catch (e) {
    return { ok: false, exitCode: -1, output: `couldn't run: ${(e as Error).message}`.slice(0, CHECK_OUTPUT_CHARS), at: clock().toISOString() };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
