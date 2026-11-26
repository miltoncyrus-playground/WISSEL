// Who acted, and who stands behind it (docs/SDD-identity-and-permissions.md
// §3.1, §3.4, §4.4, §4.10 — identity phase 2, "attribute everything").
//
// Single-owner mode: no sign-in yet, so one implicit owner principal
// stands behind every request. Every write request to the API gets an
// authorization record before it runs, completed after with how it
// ended. The log is append-only: rows are inserted and their outcome
// filled in once; nothing here deletes or rewrites a finished row.
//
// Kept in the board database (WISSEL_DB_PATH) on the board's own
// connection, so the chain lives and is backed up with the cards.
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";

export type PrincipalKind = "person" | "service" | "agent";

export interface Principal {
  id: string;
  kind: PrincipalKind;
  handle: string;
  display: string;
  subject?: string;
  codeHostLogin?: string;
  createdAt: string;
  disabledAt?: string;
}

export type AuthorizationOutcome = "allowed" | "denied" | "failed" | "queued";

export interface AuthorizationRecord {
  id: string;
  /** The server's clock, never an agent's. */
  ts: string;
  /** A coordinator action kind (SDD-coordinator §4.3) where one fits,
   *  else the route: "POST /tasks/:id/merge". */
  action: { kind: string; target: string };
  principalId: string;
  via: "direct" | "policy";
  grantId?: string;
  policyRevision?: string;
  gateRecordId?: string;
  approvalId?: string;
  harnessId?: string;
  effect?: { pr?: string; sha?: string; entry?: string; taskId?: string };
  outcome: AuthorizationOutcome;
  reason?: string;
  /** Set once the action has run; unset while it is queued. */
  completedAt?: string;
}

/** The implicit owner's id: stable, so history written before team mode
 *  stays attributed to the same principal after it (§4.10). */
export const OWNER_PRINCIPAL_ID = "owner";

interface RecordRow {
  id: string;
  ts: string;
  actionKind: string;
  actionTarget: string;
  principalId: string;
  via: "direct" | "policy";
  grantId: string | null;
  policyRevision: string | null;
  gateRecordId: string | null;
  approvalId: string | null;
  harnessId: string | null;
  effect: string | null;
  outcome: AuthorizationOutcome;
  reason: string | null;
  completedAt: string | null;
}

function rowToRecord(r: RecordRow): AuthorizationRecord {
  return {
    id: r.id,
    ts: r.ts,
    action: { kind: r.actionKind, target: r.actionTarget },
    principalId: r.principalId,
    via: r.via,
    ...(r.grantId ? { grantId: r.grantId } : {}),
    ...(r.policyRevision ? { policyRevision: r.policyRevision } : {}),
    ...(r.gateRecordId ? { gateRecordId: r.gateRecordId } : {}),
    ...(r.approvalId ? { approvalId: r.approvalId } : {}),
    ...(r.harnessId ? { harnessId: r.harnessId } : {}),
    ...(r.effect ? { effect: JSON.parse(r.effect) as AuthorizationRecord["effect"] } : {}),
    outcome: r.outcome,
    ...(r.reason ? { reason: r.reason } : {}),
    ...(r.completedAt ? { completedAt: r.completedAt } : {}),
  };
}

export interface RecordQuery {
  limit?: number;
  principalId?: string;
  taskId?: string;
  kind?: string;
}

export class AuthorizationLog {
  constructor(
    private readonly db: Database,
    private readonly clock: () => Date = () => new Date(),
  ) {
    db.run(`
      CREATE TABLE IF NOT EXISTS principals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        handle TEXT NOT NULL UNIQUE,
        display TEXT NOT NULL,
        subject TEXT,
        codeHostLogin TEXT,
        createdAt TEXT NOT NULL,
        disabledAt TEXT
      );
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS authorization_records (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        ts TEXT NOT NULL,
        actionKind TEXT NOT NULL,
        actionTarget TEXT NOT NULL,
        principalId TEXT NOT NULL,
        via TEXT NOT NULL,
        grantId TEXT,
        policyRevision TEXT,
        gateRecordId TEXT,
        approvalId TEXT,
        harnessId TEXT,
        effect TEXT,
        outcome TEXT NOT NULL,
        reason TEXT,
        completedAt TEXT
      );
    `);
    db.run("CREATE INDEX IF NOT EXISTS authorization_records_principal ON authorization_records (principalId);");
    // Append-only, enforced by the database rather than by convention: a
    // finished row cannot be changed and no row can be deleted.
    db.run(`
      CREATE TRIGGER IF NOT EXISTS authorization_records_no_delete
      BEFORE DELETE ON authorization_records
      BEGIN SELECT RAISE(ABORT, 'authorization_records is append-only'); END;
    `);
    db.run(`
      CREATE TRIGGER IF NOT EXISTS authorization_records_finished_once
      BEFORE UPDATE ON authorization_records
      WHEN OLD.completedAt IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'authorization record already completed'); END;
    `);
  }

  /** The single-owner principal, created on first start. The handle is
   *  WISSEL_OWNER_HANDLE, else the OS user, else "owner". */
  ensureOwner(handle?: string): Principal {
    const existing = this.principal(OWNER_PRINCIPAL_ID);
    if (existing) return existing;
    let h = handle?.trim();
    if (!h) {
      try {
        h = userInfo().username;
      } catch {
        h = "owner";
      }
    }
    const p: Principal = { id: OWNER_PRINCIPAL_ID, kind: "person", handle: h || "owner", display: h || "Owner", createdAt: this.clock().toISOString() };
    this.db.run("INSERT INTO principals (id, kind, handle, display, createdAt) VALUES (?, ?, ?, ?, ?)", [p.id, p.kind, p.handle, p.display, p.createdAt]);
    return p;
  }

  principal(id: string): Principal | undefined {
    const r = this.db.query("SELECT * FROM principals WHERE id = ?").get(id) as Record<string, string | null> | null;
    if (!r) return undefined;
    return {
      id: r.id!,
      kind: r.kind as PrincipalKind,
      handle: r.handle!,
      display: r.display!,
      ...(r.subject ? { subject: r.subject } : {}),
      ...(r.codeHostLogin ? { codeHostLogin: r.codeHostLogin } : {}),
      createdAt: r.createdAt!,
      ...(r.disabledAt ? { disabledAt: r.disabledAt } : {}),
    };
  }

  /** Writes the record before the action runs, as `queued`. */
  begin(rec: Omit<AuthorizationRecord, "id" | "ts" | "outcome" | "completedAt">): AuthorizationRecord {
    const full: AuthorizationRecord = { ...rec, id: randomUUID(), ts: this.clock().toISOString(), outcome: "queued" };
    this.db.run(
      `INSERT INTO authorization_records (id, ts, actionKind, actionTarget, principalId, via, grantId, policyRevision, gateRecordId, approvalId, harnessId, effect, outcome, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        full.id,
        full.ts,
        full.action.kind,
        full.action.target,
        full.principalId,
        full.via,
        full.grantId ?? null,
        full.policyRevision ?? null,
        full.gateRecordId ?? null,
        full.approvalId ?? null,
        full.harnessId ?? null,
        full.effect ? JSON.stringify(full.effect) : null,
        full.outcome,
        full.reason ?? null,
      ],
    );
    return full;
  }

  /** Fills in how the action ended. Once; a second call is refused by
   *  the database. */
  complete(id: string, outcome: Exclude<AuthorizationOutcome, "queued">, extra: { reason?: string; effect?: AuthorizationRecord["effect"] } = {}): void {
    this.db.run(
      "UPDATE authorization_records SET outcome = ?, reason = COALESCE(?, reason), effect = COALESCE(?, effect), completedAt = ? WHERE id = ?",
      [outcome, extra.reason ?? null, extra.effect ? JSON.stringify(extra.effect) : null, this.clock().toISOString(), id],
    );
  }

  get(id: string): AuthorizationRecord | undefined {
    const r = this.db.query("SELECT * FROM authorization_records WHERE id = ?").get(id) as RecordRow | null;
    return r ? rowToRecord(r) : undefined;
  }

  /** Newest first. */
  list(q: RecordQuery = {}): AuthorizationRecord[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.principalId) { where.push("principalId = ?"); args.push(q.principalId); }
    if (q.kind) { where.push("actionKind = ?"); args.push(q.kind); }
    if (q.taskId) { where.push("(actionTarget = ? OR json_extract(effect, '$.taskId') = ?)"); args.push(q.taskId, q.taskId); }
    const limit = Math.max(1, Math.min(1000, Math.floor(q.limit ?? 100)));
    const sql = `SELECT * FROM authorization_records ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq DESC LIMIT ${limit}`;
    return (this.db.query(sql).all(...args) as RecordRow[]).map(rowToRecord);
  }
}

// ---- The front door ---------------------------------------------------

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The route template and target of a write request: ids become `:id`
 *  so the same action always has the same kind. */
export function describeAction(method: string, pathname: string): { kind: string; target: string; taskId?: string } {
  const parts = pathname.split("/").filter(Boolean);
  if (method === "POST" && parts.length === 1 && parts[0] === "tasks") return { kind: "card.start", target: "/tasks" };
  const template = parts.map((p, i) => (i > 0 && (UUIDISH.test(p) || /^\d+$/.test(p) || (i === 1 && parts[0] !== "auth")) ? ":id" : p));
  const taskId = parts[0] === "tasks" && parts[1] ? decodeURIComponent(parts[1]) : undefined;
  return { kind: `${method} /${template.join("/")}`, target: parts[1] ? decodeURIComponent(parts[1]) : pathname, ...(taskId ? { taskId } : {}) };
}

function outcomeOf(status: number): Exclude<AuthorizationOutcome, "queued"> {
  if (status === 401 || status === 403) return "denied";
  return status < 400 ? "allowed" : "failed";
}

export interface FrontDoorOptions {
  /** Who stands behind a request. Single-owner mode: the owner, always. */
  principalFor: (req: Request) => string;
  /** Called after a card is created over the API, to stamp who made it. */
  onCardCreated?: (taskId: string, principalId: string) => void;
}

/** Wraps the app's fetch: every write request is recorded before it
 *  runs and completed after. Reads pass straight through. A failure to
 *  write the record refuses the request — no unrecorded writes. */
export function withAuthorizationRecords(
  fetch: (req: Request) => Response | Promise<Response>,
  log: AuthorizationLog,
  opts: FrontDoorOptions,
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    if (READ_METHODS.has(req.method)) return fetch(req);
    const url = new URL(req.url);
    const action = describeAction(req.method, url.pathname);
    const principalId = opts.principalFor(req);
    let rec: AuthorizationRecord;
    try {
      rec = log.begin({ action: { kind: action.kind, target: action.target }, principalId, via: "direct", ...(action.taskId ? { effect: { taskId: action.taskId } } : {}) });
    } catch (e) {
      console.error(`authorization log: refusing ${req.method} ${url.pathname}, the record could not be written: ${(e as Error).message}`);
      return new Response(JSON.stringify({ error: "the authorization log is unavailable, so nothing was changed" }), { status: 503, headers: { "Content-Type": "application/json" } });
    }
    let res: Response;
    try {
      res = await fetch(req);
    } catch (e) {
      log.complete(rec.id, "failed", { reason: (e as Error).message });
      throw e;
    }
    let effect: AuthorizationRecord["effect"] | undefined;
    if (action.kind === "card.start" && res.ok) {
      try {
        const body = (await res.clone().json()) as { id?: unknown };
        if (typeof body.id === "string") {
          effect = { taskId: body.id };
          opts.onCardCreated?.(body.id, principalId);
        }
      } catch {
        // Not JSON: the card id is unknown, the record still stands.
      }
    }
    let reason: string | undefined;
    if (!res.ok) {
      try {
        reason = (await res.clone().text()).slice(0, 500) || undefined;
      } catch {
        reason = undefined;
      }
    }
    log.complete(rec.id, outcomeOf(res.status), { ...(reason ? { reason } : {}), ...(effect ? { effect } : {}) });
    return res;
  };
}
