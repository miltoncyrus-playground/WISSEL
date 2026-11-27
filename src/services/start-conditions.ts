// Start conditions and overlap (docs/SDD-coordinator.md §4.8, phase 2
// card 11).
//
// A card's `waitsFor` lists what must hold before the sweep starts it:
// another card done, a PR merged, a path present on the main branch. The
// sweep skips the card until all hold, as it does for `dependsOn` and
// `notBefore`.
//
// A card's `files` names what its work will touch. When a card is created,
// and again just before it starts, Wissel warns (a log line and a
// `card.overlap` event, plus `overlaps` on POST /tasks's answer) when
// another open card, or a delivered card whose PR is still open, names the
// same files. In the pilot, two cards built the same feature in parallel
// because neither knew of the other. A warning never blocks anything.
import type { CommandRunner } from "../executors/claude-cli.ts";
import type { StartCondition, TaskCard } from "../core/types.ts";

export const MAX_START_CONDITIONS = 10;
export const MAX_CARD_FILES = 50;
export const CONDITION_CACHE_MS = 60_000;
const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Why a repo-relative path is refused, or undefined. */
function relPathError(p: unknown): string | undefined {
  if (typeof p !== "string" || !p.trim() || p.length > 300) return "must be a non-empty path of at most 300 characters";
  if (p.startsWith("/") || p.startsWith("~") || p.includes("\\") || p.includes("\0") || p.split("/").includes("..")) return `"${p}" must be relative to the repo root, with forward slashes and no ".."`;
  return undefined;
}

/** Why `waitsFor` is refused, or undefined. `cardExists` checks a
 *  card-done condition names a real card. */
export async function startConditionsError(v: unknown, cardExists: (id: string) => Promise<boolean>): Promise<string | undefined> {
  if (!Array.isArray(v) || v.length > MAX_START_CONDITIONS) return `waitsFor must be a list of at most ${MAX_START_CONDITIONS} conditions`;
  for (const c of v) {
    if (c === null || typeof c !== "object" || Array.isArray(c)) return "each waitsFor condition must be an object";
    const k = (c as { kind?: unknown }).kind;
    const o = c as Record<string, unknown>;
    if (k === "card-done") {
      if (Object.keys(o).some((f) => !["kind", "cardId"].includes(f))) return "card-done takes only cardId";
      if (typeof o.cardId !== "string" || !(await cardExists(o.cardId))) return `card-done names no card: ${JSON.stringify(o.cardId)}`;
    } else if (k === "pr-merged") {
      if (Object.keys(o).some((f) => !["kind", "repo", "number"].includes(f))) return "pr-merged takes only repo and number";
      if (typeof o.repo !== "string" || !SLUG.test(o.repo)) return "pr-merged.repo must be org/repo";
      if (!Number.isInteger(o.number) || (o.number as number) < 1) return "pr-merged.number must be a positive whole number";
    } else if (k === "path-on-main") {
      if (Object.keys(o).some((f) => !["kind", "repo", "path"].includes(f))) return "path-on-main takes only repo and path";
      if (typeof o.repo !== "string" || !o.repo.startsWith("/")) return "path-on-main.repo must be a project's checkout path";
      const e = relPathError(o.path);
      if (e) return `path-on-main.path ${e}`;
    } else return `unknown waitsFor kind ${JSON.stringify(k)}; expected card-done, pr-merged or path-on-main`;
  }
  return undefined;
}

/** Why `files` is refused, or undefined. */
export function cardFilesError(v: unknown): string | undefined {
  if (!Array.isArray(v) || v.length > MAX_CARD_FILES) return `files must be a list of at most ${MAX_CARD_FILES} paths`;
  for (const p of v) {
    const e = relPathError(p);
    if (e) return `files: ${e}`;
  }
  return undefined;
}

/** A condition in words, for logs and the board. */
export function describeCondition(c: StartCondition): string {
  if (c.kind === "card-done") return `card ${c.cardId.slice(0, 8)} done`;
  if (c.kind === "pr-merged") return `${c.repo}#${c.number} merged`;
  return `${c.path} on the main branch of ${c.repo}`;
}

export interface ConditionDeps {
  runner: CommandRunner;
  now?: () => number;
  cacheMs?: number;
}

/** Checks conditions, keeping each outside answer (gh, git) for a minute so
 *  the sweep's frequent passes don't call out every time. A card-done is
 *  read from the board each time. An answer that can't be read counts as
 *  not met yet. */
export class StartConditionChecker {
  private cache = new Map<string, { at: number; met: boolean }>();

  constructor(private readonly deps: ConditionDeps) {}

  /** The first condition that doesn't hold, or undefined when all do.
   *  `byId` is the whole board (a superseded card counts through its
   *  live re-attempt, as dependsOn does). */
  async firstUnmet(conditions: StartCondition[], byId: Map<string, TaskCard>, liveTip: (t: TaskCard | undefined) => TaskCard | undefined): Promise<StartCondition | undefined> {
    for (const c of conditions) {
      if (c.kind === "card-done") {
        if (liveTip(byId.get(c.cardId))?.status !== "done") return c;
        continue;
      }
      if (!(await this.outside(c))) return c;
    }
    return undefined;
  }

  private async outside(c: Exclude<StartCondition, { kind: "card-done" }>): Promise<boolean> {
    const key = JSON.stringify(c);
    const now = (this.deps.now ?? Date.now)();
    const hit = this.cache.get(key);
    if (hit && (hit.met || now - hit.at < (this.deps.cacheMs ?? CONDITION_CACHE_MS))) return hit.met;
    const met = c.kind === "pr-merged" ? await this.prMerged(c.repo, c.number) : await this.pathOnMain(c.repo, c.path);
    this.cache.set(key, { at: now, met });
    return met;
  }

  private async prMerged(repo: string, n: number): Promise<boolean> {
    const r = await this.deps.runner(["gh", "pr", "view", String(n), "--repo", repo, "--json", "state"], { cwd: "/" }).catch(() => undefined);
    if (!r || r.exitCode !== 0) return false;
    try {
      return (JSON.parse(r.stdout) as { state?: string }).state === "MERGED";
    } catch {
      return false;
    }
  }

  /** The remote's main branch as last fetched (refs/remotes/origin/<HEAD
   *  branch>), else the checked-out branch. */
  private async pathOnMain(repo: string, path: string): Promise<boolean> {
    const run = (args: string[]) => this.deps.runner(["git", ...args], { cwd: repo }).catch(() => undefined);
    const head = await run(["symbolic-ref", "-q", "--short", "HEAD"]);
    const branch = head && head.exitCode === 0 ? head.stdout.trim() : undefined;
    const refs = [...(branch ? [`refs/remotes/origin/${branch}`] : []), "HEAD"];
    for (const ref of refs) {
      const has = await run(["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
      if (!has || has.exitCode !== 0) continue;
      const found = await run(["cat-file", "-e", `${ref}:${path}`]);
      return found?.exitCode === 0;
    }
    return false;
  }
}

/** Whether two repo-relative paths overlap: the same path, or one is a
 *  directory holding the other. */
function overlaps(a: string, b: string): boolean {
  const x = a.replace(/\/+$/, "");
  const y = b.replace(/\/+$/, "");
  return x === y || y.startsWith(`${x}/`) || x.startsWith(`${y}/`);
}

export interface Overlap {
  id: string;
  title: string;
  key?: string;
  /** "card" for an open card, "pr" for a delivered card whose PR is open. */
  via: "card" | "pr";
  files: string[];
}

/** Other cards in the same repo that name files overlapping `card`'s: open
 *  ones (not done, failed, archived or replaced) and delivered ones whose
 *  PR is not merged or closed. The card's own attempts and reviews
 *  (same lineage) don't count. */
export function findOverlaps(card: Pick<TaskCard, "id" | "repo" | "files" | "reviewLineageId">, all: TaskCard[]): Overlap[] {
  if (!card.files?.length || !card.repo) return [];
  const lineage = card.reviewLineageId ?? card.id;
  const out: Overlap[] = [];
  for (const other of all) {
    if (other.id === card.id || other.repo !== card.repo || !other.files?.length || other.archivedAt || other.supersededBy) continue;
    if ((other.reviewLineageId ?? other.id) === lineage) continue;
    const openPr = other.pr && other.pr.watch?.lifecycle !== "merged" && other.pr.watch?.lifecycle !== "closed";
    const open = other.status !== "done" && other.status !== "failed";
    if (!open && !openPr) continue;
    const shared = other.files.filter((f) => card.files!.some((g) => overlaps(f, g)));
    if (shared.length > 0) out.push({ id: other.id, title: other.title, ...(other.key ? { key: other.key } : {}), via: open ? "card" : "pr", files: shared });
  }
  return out;
}

/** The warning line for overlaps, or undefined when there are none. */
export function overlapWarning(card: Pick<TaskCard, "title">, list: Overlap[]): string | undefined {
  if (list.length === 0) return undefined;
  const parts = list.map((o) => `${o.key ? `${o.key} ` : ""}"${o.title}"${o.via === "pr" ? " (open PR)" : ""} on ${o.files.join(", ")}`);
  return `"${card.title}" touches the same files as ${parts.join("; ")}`;
}
