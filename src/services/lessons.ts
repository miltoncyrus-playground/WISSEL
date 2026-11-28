// Lesson scopes and the promotion flow (docs/SDD-coordinator.md §4.15,
// phase 4 card 23).
//
// The memory curator keeps writing memory/lessons.md: one `## Title`
// section per lesson. Each lesson now carries a `Scope:` line right
// under its heading:
// - `Scope: wissel`: a problem with Wissel's own environment. It becomes
//   a suggested Wissel issue for the owner to file, never a prompt line.
// - `Scope: project`: a standing rule. It is proposed to the owner as an
//   addition to one project's cardRules, and applied only on approval.
// - `Scope: path:<glob>`: code knowledge for one area. It matches a card
//   only when the card's planned files match the glob.
// A lesson without a Scope line is unscoped and is left as it was.
// Injection into prompts stays governed by WISSEL_MEMORY_INJECTION:
// scoped lessons are the input for that later design, so nothing here
// adds a lesson to a prompt.
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

export type LessonScope = { kind: "wissel" } | { kind: "project" } | { kind: "path"; glob: string };

export interface Lesson {
  /** Stable for the same title and text. */
  key: string;
  title: string;
  body: string;
  scope?: LessonScope;
}

const SCOPE_LINE = /^scope:\s*(.+?)\s*$/i;

/** One lesson per `## ` section; the Scope line, if any, is read off. */
export function parseLessons(md: string): Lesson[] {
  const out: Lesson[] = [];
  const parts = md.split(/^## /m).slice(1);
  for (const part of parts) {
    const [titleLine = "", ...rest] = part.split("\n");
    const title = titleLine.trim();
    if (!title) continue;
    let scope: LessonScope | undefined;
    const lines = rest.filter((l) => {
      if (scope) return true;
      const m = SCOPE_LINE.exec(l.trim());
      if (!m) return true;
      const v = m[1]!;
      if (/^wissel$/i.test(v)) scope = { kind: "wissel" };
      else if (/^project$/i.test(v)) scope = { kind: "project" };
      else if (/^path:\s*\S/i.test(v)) scope = { kind: "path", glob: v.replace(/^path:\s*/i, "") };
      return scope === undefined;
    });
    const body = lines.join("\n").trim();
    out.push({ key: createHash("sha256").update(`${title}\n${body}`).digest("hex").slice(0, 16), title, body, ...(scope ? { scope } : {}) });
  }
  return out;
}

/** A glob (`*` within a segment, `**` across segments, `?` one char) as a
 *  regular expression over repo-relative paths. */
export function globRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** The path lessons whose glob matches any of a card's planned files. */
export function lessonsForFiles(lessons: Lesson[], files: string[] | undefined): Lesson[] {
  if (!files?.length) return [];
  return lessons.filter((l) => l.scope?.kind === "path" && files.some((f) => globRegex((l.scope as { glob: string }).glob).test(f)));
}

export type ProposalKind = "wissel-issue" | "card-rule";

export interface Proposal {
  key: string;
  kind: ProposalKind;
  title: string;
  body: string;
  status: "proposed" | "approved" | "rejected";
  projectId?: string;
  decidedAt?: string;
}

/** What has been decided about each lesson; a lesson's proposals are
 *  derived from the file each time, so a lesson the curator drops simply
 *  stops being proposed. */
export class LessonDecisions {
  constructor(
    private readonly db: Database,
    private readonly clock: () => Date = () => new Date(),
  ) {
    db.run("CREATE TABLE IF NOT EXISTS lesson_decisions (key TEXT PRIMARY KEY, status TEXT NOT NULL, projectId TEXT, decidedAt TEXT NOT NULL);");
  }

  get(key: string): { status: "approved" | "rejected"; projectId?: string; decidedAt: string } | undefined {
    const r = this.db.query("SELECT * FROM lesson_decisions WHERE key = ?").get(key) as { status: "approved" | "rejected"; projectId: string | null; decidedAt: string } | null;
    return r ? { status: r.status, ...(r.projectId ? { projectId: r.projectId } : {}), decidedAt: r.decidedAt } : undefined;
  }

  decide(key: string, status: "approved" | "rejected", projectId?: string): void {
    this.db.run("INSERT INTO lesson_decisions (key, status, projectId, decidedAt) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET status = excluded.status, projectId = excluded.projectId, decidedAt = excluded.decidedAt", [key, status, projectId ?? null, this.clock().toISOString()]);
  }
}

/** The owner's proposals: wissel lessons as issues to file, project
 *  lessons as card rules. */
export function proposals(lessons: Lesson[], decisions: LessonDecisions): Proposal[] {
  return lessons
    .filter((l) => l.scope?.kind === "wissel" || l.scope?.kind === "project")
    .map((l) => {
      const d = decisions.get(l.key);
      return {
        key: l.key,
        kind: l.scope!.kind === "wissel" ? ("wissel-issue" as const) : ("card-rule" as const),
        title: l.title,
        body: l.body,
        status: d?.status ?? ("proposed" as const),
        ...(d?.projectId ? { projectId: d.projectId } : {}),
        ...(d ? { decidedAt: d.decidedAt } : {}),
      };
    });
}

/** The rule text a card-rule proposal adds to cardRules. */
export function ruleText(p: Pick<Proposal, "title" | "body">): string {
  const first = p.body.split("\n").find((l) => l.trim()) ?? "";
  return `- ${p.title}${first ? `: ${first.trim()}` : ""}`;
}
