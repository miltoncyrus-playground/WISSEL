// The board's user mode (docs/SDD-board-ui-for-teams.md §4.2, §4.10;
// docs/cards/ui-vocabulary-pass.md card 3). Not served as-is: the
// server bundles this file with the two modules it imports into
// /user-mode.js, a classic script that sets window.WisselUserMode.
//
// Operator mode is the default and does nothing at all: every hook below
// returns its input unchanged and nothing touches the DOM. That is the
// whole guarantee that operator mode renders exactly what it did before.
//
// User mode:
//   - every visible internal term goes through label() — a text pass
//     over the page that skips anything marked [data-user-content]
//     (titles, descriptions, agent output), so a person's own words are
//     never rewritten;
//   - a failure renders through present(): the sentence first, the action
//     as a button, the raw output behind "Show the agent's output";
//   - the sidebar's Setup group collapses behind "Advanced". Nothing is
//     removed and no route changes.

import { label, uiMode, USER_VOCABULARY } from "../../core/user-vocabulary.ts";
import { present } from "../../core/failure-presentation.ts";

/** The reviewer-round cap (MAX_PUSHBACKS in src/core/orchestrator.ts). */
const ROUND_CAP = 5;

function safeStorage() {
  try {
    return window.localStorage;
  } catch (e) {
    return null;
  }
}

const mode = uiMode(window.location.href, safeStorage());

// ---- Vocabulary pass -------------------------------------------------

/** [pattern, replacement] pairs from the table, longest term first so
 *  "merge gate" wins over anything inside it. Tier values are skipped:
 *  "write" and "readonly" are ordinary words outside a tier chip. */
function buildRules() {
  const terms = Object.keys(USER_VOCABULARY).filter((t) => t.indexOf(":") < 0);
  // Board-only forms that the table's terms appear in.
  const extra = [
    ["worktrees", label("worktree", "user")],
    ["no agent matched", label("no-match", "user")],
    ["needs a grant", "needs an extra permission"],
    ["unrouted", "not started"],
  ];
  const pairs = terms.map((t) => [t, label(t, "user")]).concat(extra);
  pairs.sort((a, b) => b[0].length - a[0].length);
  return pairs.map(([from, to]) => {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
    return [new RegExp("(?<![\\w-])" + escaped + "(?![\\w-])", "gi"), to];
  });
}

let rules = null;

function matchCase(original, replacement) {
  if (original.toUpperCase() === original && original.length > 1 && /[A-Z]/.test(original)) return replacement.toUpperCase();
  if (/^[A-Z]/.test(original)) return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  return replacement;
}

function relabel(text) {
  if (!text || !/[A-Za-z]/.test(text)) return text;
  if (!rules) rules = buildRules();
  let out = text;
  for (const [re, to] of rules) out = out.replace(re, (m) => matchCase(m, to));
  return out;
}

// Text inside these is never rewritten: code, form values, a person's
// own words. A form control's title/placeholder is still the board's own
// chrome, so attributes only skip a person's words and non-visible nodes.
const SKIP = "script, style, textarea, input, select, pre, code, [contenteditable], [data-user-content]";
const SKIP_ATTRS = "script, style, [data-user-content]";
const ATTRS = ["title", "aria-label", "placeholder"];

function skipped(el) {
  return !!(el && el.closest && el.closest(SKIP));
}

function relabelElementAttrs(el) {
  if (!el || !el.closest || el.closest(SKIP_ATTRS)) return;
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (v) {
      const next = relabel(v);
      if (next !== v) el.setAttribute(a, next);
    }
  }
}

function relabelTree(root) {
  if (!root) return;
  if (root.nodeType === 3) {
    if (!skipped(root.parentElement)) {
      const next = relabel(root.nodeValue);
      if (next !== root.nodeValue) root.nodeValue = next;
    }
    return;
  }
  if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
  if (root.nodeType === 1) {
    if (skipped(root)) return;
    relabelElementAttrs(root);
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const el = n.nodeType === 1 ? n : n.parentElement;
      return el && el.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  let n = walker.nextNode();
  while (n) {
    if (n.nodeType === 3) {
      const next = relabel(n.nodeValue);
      if (next !== n.nodeValue) n.nodeValue = next;
    } else relabelElementAttrs(n);
    n = walker.nextNode();
  }
  // The walker skips form controls whole; their attributes still count.
  if (root.querySelectorAll) root.querySelectorAll("[title], [aria-label], [placeholder]").forEach(relabelElementAttrs);
}

function watch() {
  relabelTree(document.body);
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "characterData") relabelTree(r.target);
      else if (r.type === "attributes") relabelElementAttrs(r.target);
      else r.addedNodes.forEach(relabelTree);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}

// ---- Setup behind Advanced --------------------------------------------

function collapseSetup() {
  const heading = Array.prototype.find.call(document.querySelectorAll(".sb-group"), (p) => p.textContent.trim() === "Setup");
  if (!heading || heading.closest("details")) return;
  const items = [];
  let n = heading.nextElementSibling;
  while (n && !n.classList.contains("sb-group") && n.matches("a.nav-item")) {
    items.push(n);
    n = n.nextElementSibling;
  }
  const details = document.createElement("details");
  details.className = "um-advanced";
  const summary = document.createElement("summary");
  summary.className = "sb-group";
  summary.textContent = "Advanced";
  details.appendChild(summary);
  heading.parentNode.insertBefore(details, heading);
  details.appendChild(heading);
  items.forEach((i) => details.appendChild(i));
  // A Setup route opened directly (a bookmark) shows its link.
  if (/^#\/setup\//.test(window.location.hash)) details.open = true;
}

// ---- Failures through present() ----------------------------------------

function projectName(repo) {
  if (!repo) return undefined;
  const parts = String(repo).replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || undefined;
}

/** The failure a card stands for, as present() takes it, or null when
 *  the card is not a failure (it is waiting for a review, say). */
function failureOf(t) {
  if (!t) return null;
  if (t.status === "escalated") {
    const grants = t.suggestedGrants || [];
    if (grants.length) return { cause: "sandbox-refused", taskId: t.id, commands: grants };
    const rounds = typeof t.pushbackCount === "number" ? t.pushbackCount + 1 : undefined;
    if (rounds !== undefined && rounds >= ROUND_CAP) return { cause: "review-round-cap", taskId: t.id, rounds };
    return { cause: "escalated", taskId: t.id };
  }
  if (t.status === "no-match") return { cause: "nothing-matched", taskId: t.id, project: projectName(t.repo) };
  if (t.status === "failed") return { cause: "failed", taskId: t.id };
  return null;
}

function presentationOf(t) {
  const f = failureOf(t);
  return f ? present(f) : null;
}

function actionButton(p, t) {
  if (!p.action) return null;
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn um-action";
  b.textContent = p.action.label;
  b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (p.action.method === "GET") {
      window.location.href = p.action.href;
      return;
    }
    b.disabled = true;
    fetch(p.action.href, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
      .then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        b.textContent = "Done";
      })
      .catch(() => {
        b.disabled = false;
        b.textContent = p.action.label + " (try again)";
      });
  });
  b.addEventListener("keydown", (ev) => ev.stopPropagation());
  b.dataset.taskId = t.id;
  return b;
}

function outputToggle(rawText) {
  if (!rawText) return null;
  const d = document.createElement("details");
  d.className = "um-raw";
  const s = document.createElement("summary");
  s.textContent = "Show the agent's output";
  const pre = document.createElement("pre");
  pre.setAttribute("data-user-content", "");
  pre.textContent = rawText;
  d.appendChild(s);
  d.appendChild(pre);
  d.addEventListener("click", (ev) => ev.stopPropagation());
  return d;
}

/** Needs you / lane cards: the line under the title. */
function reasonFor(t, reason) {
  if (mode !== "user") return reason;
  const p = presentationOf(t);
  return p ? p.sentence : reason;
}

/** Needs you / lane cards: the action and the raw output, after the
 *  card is built. */
function decorateCard(card, t) {
  if (mode !== "user" || !card) return;
  const p = presentationOf(t);
  if (!p) return;
  const box = document.createElement("div");
  box.className = "um-failure";
  const b = actionButton(p, t);
  if (b) box.appendChild(b);
  const raw = outputToggle((t.escalationContext || "").trim());
  if (raw) box.appendChild(raw);
  if (box.childNodes.length) card.appendChild(box);
}

/** The task drawer: the sentence and action above everything, with the
 *  timeline and result behind "Show the agent's output". */
function onDrawer(t) {
  if (mode !== "user") return;
  const detail = document.getElementById("tdDetail");
  if (!detail) return;
  const old = document.getElementById("tdUserFailure");
  if (old) old.remove();
  const drawer = document.getElementById("taskDrawer");
  const p = presentationOf(t);
  if (!p) {
    if (drawer) drawer.classList.remove("um-output-hidden");
    return;
  }
  const sec = document.createElement("section");
  sec.id = "tdUserFailure";
  sec.className = "um-failure um-drawer-failure";
  const sentence = document.createElement("p");
  sentence.className = "um-sentence";
  sentence.textContent = p.sentence;
  sec.appendChild(sentence);
  const b = actionButton(p, t);
  if (b) sec.appendChild(b);
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "btn um-show-output";
  toggle.textContent = "Show the agent's output";
  toggle.setAttribute("aria-expanded", "false");
  toggle.addEventListener("click", () => {
    const hidden = drawer.classList.toggle("um-output-hidden");
    toggle.setAttribute("aria-expanded", hidden ? "false" : "true");
    toggle.textContent = hidden ? "Show the agent's output" : "Hide the agent's output";
  });
  sec.appendChild(toggle);
  if (drawer) drawer.classList.add("um-output-hidden");
  detail.insertBefore(sec, detail.firstChild);
}

function installStyles() {
  const style = document.createElement("style");
  style.textContent = [
    ".um-failure { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }",
    ".um-drawer-failure { flex-direction: column; align-items: flex-start; padding: 10px 0; border-bottom: 1px solid var(--line); }",
    ".um-sentence { margin: 0; white-space: pre-wrap; }",
    ".um-raw > pre { white-space: pre-wrap; max-height: 240px; overflow: auto; font-size: 12px; }",
    ".um-output-hidden #tdEscalationSection, .um-output-hidden #tdResultSection { display: none !important; }",
    ".um-advanced > summary { cursor: pointer; list-style: revert; }",
    // The router's reasoning is an operator's view (§3); it stays one
    // switch away in operator mode.
    ".drawer-section:has(> #tdDecision) { display: none; }",
  ].join("\n");
  document.head.appendChild(style);
}

function start() {
  document.documentElement.dataset.uiMode = "user";
  installStyles();
  collapseSetup();
  watch();
}

if (mode === "user") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
}

window.WisselUserMode = {
  mode,
  label: (term) => label(term, mode),
  reasonFor,
  decorateCard,
  onDrawer,
  // Exposed for tests: the pure pieces.
  relabel: (text) => (mode === "user" ? relabel(text) : text),
  failureOf,
};
