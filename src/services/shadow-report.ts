import type { About, ChannelEntry } from "./channel.ts";
import type { ExecutableAction, OutboundEntry } from "./coordinator-executor.ts";
import type { PullRequest } from "./github-status.ts";

/**
 * The shadow report (docs/SDD-coordinator.md §4.13, §7): Shadow's
 * would-entries against what actually happened, which the caller injects
 * as the channel log (the external coordinator's entries) and the PR
 * list. Pure: nothing here reads a store or a code host. A would-entry
 * matches at most one external entry or PR; what matches nothing is
 * listed with the reason, on both sides, and each reason is logged.
 * §7 moves on when ready-to-merge agrees, no would-be hard-limit
 * violation shows, and nothing external went unmatched.
 */
export interface ShadowSources { channel: ChannelEntry[]; prs: PullRequest[] }

export interface ShadowReport {
  workstreamId: string;
  /** Would-entries considered. */
  would: number;
  /** Head shas Wissel would have posted ready-to-merge against those the external coordinator did; agreement is |both| / |either| in percent. */
  readyToMerge: { agreement: number; both: string[]; wisselOnly: string[]; externalOnly: string[] };
  /** Would-entries the live gate denied on rule 1. */
  hardLimitViolations: { id: string; at: string; action: ExecutableAction }[];
  matched: { id: string; kind: string; by: string }[];
  unmatched: { side: "wissel" | "external"; ref: string; kind: string; reason: string }[];
}

/** The channel kinds an external coordinator posts that Wissel would have posted itself; the decider's question/answer/decision entries are inputs, not actions to mirror. */
const MIRRORED_KINDS: ReadonlySet<string> = new Set(["claim", "release", "ready-to-merge", "status", "handover"]);

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const about = (a: ExecutableAction): About => (typeof a.payload?.about === "object" && a.payload.about !== null ? (a.payload.about as About) : {});
const sameAbout = (x: About, y: About): boolean => (["card", "pr", "ticket"] as const).some((k) => x[k] !== undefined && x[k] === y[k]);
const describeAbout = (x: About): string => (["card", "pr", "ticket"] as const).filter((k) => x[k]).map((k) => `${k} ${x[k]}`).join(", ") || "nothing";
const kindOf = (a: ExecutableAction): string => (a.kind === "channel.post" && a.post ? `channel.post ${a.post}` : a.kind);

/** Why a channel.post would-entry has no counterpart, or the external entry it matches. */
function matchPost(a: ExecutableAction, candidates: ChannelEntry[]): { entry?: ChannelEntry; reason: string } {
  const p = a.payload ?? {};
  const same = candidates.filter((c) => c.message.kind === a.post);
  if (a.post === "ready-to-merge") {
    const sha = str(p.headSha);
    return { entry: same.find((c) => c.message.kind === "ready-to-merge" && c.message.headSha === sha), reason: `no external ready-to-merge entry names head ${sha ?? "(none given)"}` };
  }
  if (a.post === "claim" || a.post === "release") {
    const item = str(p.item);
    return { entry: same.find((c) => (c.message.kind === "claim" || c.message.kind === "release") && c.message.item === item), reason: `no external ${a.post} entry is for item ${item ?? "(none given)"}` };
  }
  const ab = about(a);
  return { entry: same.find((c) => sameAbout(ab, c.message.about)), reason: `no external ${a.post ?? "channel"} entry is about ${describeAbout(ab)}` };
}

/** Why a PR-side would-entry has no counterpart, or the PR it matches. */
function matchPr(a: ExecutableAction, prs: PullRequest[]): { pr?: PullRequest; reason: string } {
  const number = typeof a.payload?.pr === "number" ? a.payload.pr : undefined;
  const branch = str(a.payload?.branch);
  const pr = prs.find((x) => (number !== undefined && x.number === number) || (branch !== undefined && x.branch === branch));
  const name = number !== undefined ? `PR #${number}` : branch !== undefined ? `branch ${branch}` : "an unnamed PR";
  if (!pr) return { reason: `${name} is not in the PR list` };
  if (a.kind === "pr.arm" && !(pr.armed || pr.state === "merged")) return { reason: `PR #${pr.number} is neither armed nor merged` };
  return { pr, reason: "" };
}

export function shadowReport(workstreamId: string, would: OutboundEntry[], sources: ShadowSources, log: (line: string) => void = () => {}): ShadowReport {
  const external = sources.channel.filter((c) => c.message.from !== "wissel");
  const taken = new Set<string>();
  const report: ShadowReport = { workstreamId, would: would.length, readyToMerge: { agreement: 100, both: [], wisselOnly: [], externalOnly: [] }, hardLimitViolations: [], matched: [], unmatched: [] };
  const miss = (side: "wissel" | "external", ref: string, kind: string, reason: string): void => {
    report.unmatched.push({ side, ref, kind, reason });
    log(`shadow ${workstreamId}: unmatched ${side} ${kind} ${ref}: ${reason}`);
  };

  for (const e of would) {
    const a = e.action;
    if (e.rule === "1:hard-limit") report.hardLimitViolations.push({ id: e.id, at: e.queuedAt, action: a });
    if (a.kind === "channel.post") {
      const m = matchPost(a, external.filter((c) => !taken.has(c.ref)));
      if (!m.entry) miss("wissel", e.id, kindOf(a), m.reason);
      else {
        taken.add(m.entry.ref);
        report.matched.push({ id: e.id, kind: kindOf(a), by: `channel ${m.entry.ref}` });
      }
    } else if (a.kind === "branch.push" || a.kind === "pr.open" || a.kind === "pr.arm") {
      const m = matchPr(a, sources.prs);
      if (m.pr) report.matched.push({ id: e.id, kind: a.kind, by: `pr #${m.pr.number}` });
      else miss("wissel", e.id, a.kind, m.reason);
    } else miss("wissel", e.id, kindOf(a), `${a.kind} is not observable in the channel log or the PR list`);
  }
  for (const c of external) {
    if (!taken.has(c.ref) && MIRRORED_KINDS.has(c.message.kind)) miss("external", c.ref, c.message.kind, `${c.message.from} posted it; Wissel recorded no would-entry for it`);
  }

  const wissel = new Set(would.filter((e) => e.action.kind === "channel.post" && e.action.post === "ready-to-merge").map((e) => str(e.action.payload?.headSha) ?? ""));
  const theirs = new Set(external.filter((c) => c.message.kind === "ready-to-merge").map((c) => (c.message as { headSha: string }).headSha));
  const rtm = report.readyToMerge;
  rtm.both = [...wissel].filter((s) => theirs.has(s));
  rtm.wisselOnly = [...wissel].filter((s) => !theirs.has(s));
  rtm.externalOnly = [...theirs].filter((s) => !wissel.has(s));
  const either = rtm.both.length + rtm.wisselOnly.length + rtm.externalOnly.length;
  rtm.agreement = either === 0 ? 100 : Math.round((rtm.both.length / either) * 100);
  return report;
}
