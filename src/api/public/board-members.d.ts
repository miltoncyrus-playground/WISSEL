// Types for board-members.js, for bun test (see its module.exports guard).
export const MEMBER_PERMISSIONS: string[];
export function escHtml(s: unknown): string;
export function scopeLabel(scope: { kind: string; id?: string } | undefined): string;
export interface MemberView {
  id: string;
  handle: string;
  display: string;
  kind: string;
  disabledAt?: string;
  tokens?: { revokedAt?: string }[];
  grants?: { id: string; permissions: string[]; scope: { kind: string; id?: string } }[];
}
export function memberRowHtml(m: MemberView): string;
export function membersTableHtml(members: MemberView[]): string;
export function grantFormHtml(memberId: string): string;
export interface AuditRowView {
  ts: string;
  principalId: string;
  action: { kind: string; target: string };
  outcome: string;
  reason?: string;
}
export function auditRowHtml(r: AuditRowView, handleOf: (id: string) => string): string;
export function auditTableHtml(rows: AuditRowView[], handleOf: (id: string) => string): string;
export function auditQuery(f: { principal?: string; outcome?: string; kind?: string }): string;
export function initMembersPage(doc: Document): void;
export function loadMembersPage(doc: Document): Promise<void>;
export function initAuditPage(doc: Document): void;
export function loadAuditPage(doc: Document): Promise<void>;
