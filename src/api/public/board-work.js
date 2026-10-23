// Pure helpers for the Tickets page and the ticket chip on cards. No DOM:
// same house style as board-routes.js, loaded as a plain <script> and
// importable from bun test through the module.exports guard at the
// bottom. The server groups branches with the same rule
// (src/services/ticket-refs.ts); this copy finds the key on a card.

var TICKET_DEFAULT_PATTERN = "\\b[A-Z][A-Z0-9]+-\\d+\\b";

// The first ticket key in `texts`, tried in order. A project's own
// patterns replace the default; a pattern that doesn't compile finds
// nothing.
function ticketKeyOf(texts, patterns) {
  var sources = patterns && patterns.length ? patterns : [TICKET_DEFAULT_PATTERN];
  for (var i = 0; i < texts.length; i++) {
    if (!texts[i]) continue;
    for (var j = 0; j < sources.length; j++) {
      try {
        var m = new RegExp(sources[j]).exec(texts[i]);
        if (m && m[0] !== "") return m[0];
      } catch (e) {}
    }
  }
  return undefined;
}

function trimSlash(p) { return p.length > 1 ? p.replace(/\/+$/, "") : p; }

// The registered project a card's `repo` names, by path.
function projectForRepo(repo, projects) {
  if (!repo) return undefined;
  for (var i = 0; i < projects.length; i++) if (trimSlash(projects[i].path) === trimSlash(repo)) return projects[i];
  return undefined;
}

// A card's ticket key: its title, then the branch it lands on.
function cardTicketKey(task, projects) {
  var project = projectForRepo(task.repo, projects);
  return ticketKeyOf([task.title, task.mergeTarget], project && project.ticketPatterns);
}

// GET /work narrowed by the page's filters. `projectId` keeps one
// project's share of each ticket; `attentionOnly` keeps only projects
// whose checkout has something to look at. A ticket left with no
// project is dropped.
function filterWork(work, filters) {
  var projectId = filters && filters.projectId;
  var attentionOnly = !!(filters && filters.attentionOnly);
  var keep = {};
  var projects = work.projects.filter(function (p) {
    if (projectId && p.id !== projectId) return false;
    if (attentionOnly && p.attention.length === 0 && !p.error) return false;
    keep[p.id] = true;
    return true;
  });
  var tickets = [];
  work.tickets.forEach(function (t) {
    var shares = t.projects.filter(function (s) { return keep[s.id]; });
    if (shares.length === 0) return;
    var cardCount = 0, branchCount = 0;
    shares.forEach(function (s) { cardCount += s.cards.length; branchCount += s.branches.length; });
    tickets.push({ key: t.key, projects: shares, cardCount: cardCount, branchCount: branchCount });
  });
  return { projects: projects, tickets: tickets };
}

// "3 cards · 9 branches · 2 repos" for a ticket's heading.
function ticketSummary(t) {
  var n = function (count, word) { return count + " " + word + (count === 1 ? "" : "s"); };
  return [n(t.cardCount, "card"), n(t.branchCount, "branch").replace("branchs", "branches"), n(t.projects.length, "repo")].join(" · ");
}

// The ticket keys a /work answer names, once each, for GET /tickets.
function ticketKeysOf(work) {
  var seen = {};
  var keys = [];
  work.tickets.forEach(function (t) {
    if (t.key && !seen[t.key]) { seen[t.key] = true; keys.push(t.key); }
  });
  return keys;
}

// "main · clean" / "spec/X-1 · 2 changed files · 1 behind": where a checkout stands.
function projectStateLine(p) {
  if (p.error) return p.error;
  var s = p.status;
  var bits = [s.detached ? "detached at " + s.branch : s.branch, s.dirty ? s.changedFiles + (s.changedFiles === 1 ? " changed file" : " changed files") : "clean"];
  if (!s.hasUpstream) bits.push("no upstream");
  else if (s.ahead || s.behind) bits.push((s.ahead || 0) + " ahead, " + (s.behind || 0) + " behind");
  return bits.join(" · ");
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    ticketKeyOf: ticketKeyOf,
    projectForRepo: projectForRepo,
    cardTicketKey: cardTicketKey,
    filterWork: filterWork,
    ticketSummary: ticketSummary,
    ticketKeysOf: ticketKeysOf,
    projectStateLine: projectStateLine,
  };
}
