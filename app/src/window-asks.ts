import type { CoordinatorAsk } from "./types";

// The words the coordinator window uses for an ask (docs/SDD-coordinator.md
// §4.14): what wissel wants to do in plain words, why the gate asked, the
// Change line Approve shows before anything runs, and the Log line once a
// person (or the 7-day sweep) has answered. Pure, so vitest covers it.

const TEXT_MAX = 120;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : typeof v === "number" ? String(v) : undefined);
const cut = (s: string): string => (s.length > TEXT_MAX ? `${s.slice(0, TEXT_MAX - 1).trimEnd()}…` : s);

/** The gate rules that end in an ask, in the owner's words (policy-gate.ts). */
const RULE_WORDS: Record<string, string> = {
  "5:must-ask": "the decision is on the must-ask list",
  "6:role-table": "the role table asks for this kind in this role",
  "7:default": "no rule allows it on its own",
};

/** The action's verb phrase, then the card and PR it is about, then its text. */
export function describeAction(a: CoordinatorAsk["action"]): string {
  const p = a.payload ?? {};
  const m = isRecord(p.message) ? p.message : {};
  const about = isRecord(m.about) ? m.about : {};
  const card = str(p.key) ?? str(about.card) ?? str(p.taskId);
  const pr = str(p.pr) ?? str(about.pr);
  const text = str(p.title) ?? str(m.text);
  const where = [card ? `card ${card}` : "", pr ? `PR #${pr}` : ""].filter(Boolean).join(", ");
  let verb: string;
  switch (a.kind) {
    case "channel.post":
      verb = `post a ${a.post ?? "message"}${a.decision ? ` (${a.decision})` : ""} on the channel`;
      break;
    case "pr.arm":
      return `arm PR #${pr ?? "?"} to merge${a.base ? ` into ${a.base}` : ""}`;
    case "pr.open":
      verb = "open a pull request";
      break;
    case "branch.push":
      verb = `push the branch${a.base ? ` for ${a.base}` : ""}`;
      break;
    case "pr.merge-forward":
      verb = "merge forward";
      break;
    case "card.start":
      verb = "start a card";
      break;
    case "card.stop":
      verb = "stop a card";
      break;
    case "ticket.transition":
      return `move ticket ${str(p.key) ?? "?"} to ${str(p.to) ?? "?"}`;
    case "ticket.comment":
      verb = `comment on ticket ${str(p.key) ?? "?"}`;
      break;
    case "chat.post":
      verb = "post to the chat";
      break;
    case "owner.task":
      verb = "raise an owner task";
      break;
    default:
      verb = a.kind.replace(/[.-]/g, " ");
  }
  return `${verb}${where && !a.kind.startsWith("ticket.") ? ` about ${where}` : ""}${text ? `: "${cut(text)}"` : ""}`;
}

/** What, why, and whether the decider was asked on the channel too. */
export function describeAsk(ask: CoordinatorAsk): { what: string; why: string; onChannel: boolean } {
  const onChannel = ask.verdict === "ask-decider";
  const reason = RULE_WORDS[ask.rule] ?? "the gate's rule says to ask";
  return { what: describeAction(ask.action), why: `The gate asked ${onChannel ? "the decider on the channel" : "you"}: ${reason} (rule ${ask.rule}).`, onChannel };
}

/** The window's Change line, shown after Approve and before Confirm. */
export const askConfirmLine = (ask: CoordinatorAsk): string => `Change: wissel will ${describeAction(ask.action)}. Confirm.`;

/** A resolved ask as a Log row: who answered, how, and whether anything ran. */
export function resolvedAskLine(ask: CoordinatorAsk): { from: string; kind: string; text: string } {
  const how = ask.status === "expired" ? "after 7 days" : ask.via === "channel" ? "answered on the channel" : "from the window";
  const ran = ask.status === "approved" ? "it ran once" : "nothing ran";
  return { from: ask.resolvedBy ?? "owner", kind: `ask ${ask.status}`, text: `${describeAction(ask.action)} (${how}; ${ran})` };
}
