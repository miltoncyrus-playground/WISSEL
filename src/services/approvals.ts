// Approvals bound to content (docs/SDD-identity-and-permissions.md §3.5,
// §4.5; build plan card 9).
//
// An approval covers one thing, once: an action kind, a target and a
// content hash (for arming a PR, the head sha that was reviewed). It is
// issued to one principal, who alone can confirm it with their own
// session, within PENDING_TTL_MS. A confirm whose content moved since (the
// PR's head is no longer the reviewed one) is refused with that reason,
// and the approval stays unused. No agent, card, board entry or model
// output can take one: only POST /approvals/:id/confirm, by that person.
// Ask's two-phase actions (pending-actions.ts) follow the same rules.
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { PENDING_TTL_MS } from "./pending-actions.ts";

export interface Approval {
  id: string;
  principalId: string;
  actionKind: string;
  targetRef: string;
  contentHash: string;
  /** What it would do, in words, for the person confirming. */
  line: string;
  issuedAt: string;
  expiresAt: string;
  usedAt?: string;
  resolution?: "confirmed" | "cancelled";
}

export type ApprovalRefusal = "not-found" | "wrong-principal" | "expired" | "used" | "changed";

export const APPROVAL_REFUSAL_TEXT: Record<ApprovalRefusal, string> = {
  "not-found": "no such approval",
  "wrong-principal": "this approval is someone else's to confirm",
  expired: "this approval expired; ask for a new one",
  used: "this approval was already confirmed or cancelled",
  changed: "what this approval covers has changed since it was issued",
};

export const refusalStatus = (r: ApprovalRefusal) => (r === "not-found" ? 404 : r === "wrong-principal" ? 403 : 409);

export class ApprovalStore {
  constructor(
    private readonly db: Database,
    private readonly clock: () => Date = () => new Date(),
    private readonly ttlMs = PENDING_TTL_MS,
  ) {
    db.run(`CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY, principalId TEXT NOT NULL, actionKind TEXT NOT NULL, targetRef TEXT NOT NULL, contentHash TEXT NOT NULL,
      line TEXT NOT NULL, issuedAt TEXT NOT NULL, expiresAt TEXT NOT NULL, usedAt TEXT, resolution TEXT)`);
  }

  issue(input: Pick<Approval, "principalId" | "actionKind" | "targetRef" | "contentHash" | "line">): Approval {
    const at = this.clock();
    const a: Approval = { id: randomUUID(), ...input, issuedAt: at.toISOString(), expiresAt: new Date(at.getTime() + this.ttlMs).toISOString() };
    this.db.run("INSERT INTO approvals (id, principalId, actionKind, targetRef, contentHash, line, issuedAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [a.id, a.principalId, a.actionKind, a.targetRef, a.contentHash, a.line, a.issuedAt, a.expiresAt]);
    return a;
  }

  get(id: string): Approval | undefined {
    const r = this.db.query("SELECT * FROM approvals WHERE id = ?").get(id) as Record<string, string | null> | null;
    if (!r) return undefined;
    return {
      id: r.id!, principalId: r.principalId!, actionKind: r.actionKind!, targetRef: r.targetRef!, contentHash: r.contentHash!, line: r.line!, issuedAt: r.issuedAt!, expiresAt: r.expiresAt!,
      ...(r.usedAt ? { usedAt: r.usedAt } : {}),
      ...(r.resolution === "confirmed" || r.resolution === "cancelled" ? { resolution: r.resolution } : {}),
    };
  }

  /** Open approvals for a principal, newest first. */
  openFor(principalId: string): Approval[] {
    const at = this.clock().toISOString();
    return (this.db.query("SELECT id FROM approvals WHERE principalId = ? AND usedAt IS NULL AND expiresAt > ? ORDER BY issuedAt DESC").all(principalId, at) as { id: string }[]).map((r) => this.get(r.id)!);
  }

  /** Why `by` can't use it now with the content as `currentHash`. */
  private refusal(a: Approval | undefined, by: string, currentHash?: string): ApprovalRefusal | undefined {
    if (!a) return "not-found";
    if (a.principalId !== by) return "wrong-principal";
    if (a.usedAt) return "used";
    if (a.expiresAt <= this.clock().toISOString()) return "expired";
    if (currentHash !== undefined && currentHash !== a.contentHash) return "changed";
    return undefined;
  }

  /** Takes it, once, atomically. The caller then does the one thing it covers. */
  confirm(id: string, by: string, currentHash: string): { ok: true; approval: Approval } | { ok: false; reason: ApprovalRefusal } {
    return this.use(id, by, "confirmed", currentHash);
  }

  cancel(id: string, by: string): { ok: true; approval: Approval } | { ok: false; reason: ApprovalRefusal } {
    return this.use(id, by, "cancelled");
  }

  private use(id: string, by: string, resolution: "confirmed" | "cancelled", currentHash?: string): { ok: true; approval: Approval } | { ok: false; reason: ApprovalRefusal } {
    const refused = this.refusal(this.get(id), by, currentHash);
    if (refused) return { ok: false, reason: refused };
    const at = this.clock().toISOString();
    const changed = this.db.run("UPDATE approvals SET usedAt = ?, resolution = ? WHERE id = ? AND usedAt IS NULL", [at, resolution, id]).changes;
    if (changed !== 1) return { ok: false, reason: "used" };
    return { ok: true, approval: this.get(id)! };
  }
}
