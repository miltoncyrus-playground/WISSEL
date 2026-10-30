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

// "#9 draft · CI failing (fast) · changes requested": one pull request
// as text, so the state never depends on a colour. `merged` and `closed`
// hide the review and conflict notes, which no longer matter.
function prLine(pr) {
  var bits = ["#" + pr.number + " " + pr.state];
  if (pr.state === "open" || pr.state === "draft") {
    if (pr.checks.state === "failing") bits.push("CI failing" + (pr.checks.failing.length ? " (" + pr.checks.failing.join(", ") + ")" : ""));
    else if (pr.checks.state === "pending") bits.push("CI running");
    else if (pr.checks.state === "passing") bits.push("CI passing");
    if (pr.review === "APPROVED") bits.push("approved");
    else if (pr.review === "CHANGES_REQUESTED") bits.push("changes requested");
    else if (pr.review === "REVIEW_REQUIRED") bits.push("review needed");
    if (pr.mergeable === "CONFLICTING") bits.push("conflicts");
  } else if (pr.state === "merged" && pr.checks.state === "failing") bits.push("CI failed");
  return bits.join(" · ");
}

// GET /ci as the rows the CI section shows: runs in progress or queued
// (running first, oldest first), then runs that failed in the last day
// (newest first). Errors stay per project.
function ciView(answer, nameOf, now) {
  var active = [];
  var failed = [];
  var errors = [];
  var day = 24 * 3600 * 1000;
  ((answer && answer.projects) || []).forEach(function (p) {
    var name = nameOf ? nameOf(p.id) : p.id;
    if (p.error) { errors.push({ project: name, error: p.error }); return; }
    (p.runs || []).forEach(function (r) {
      var row = { projectId: p.id, project: name, repo: p.repo, run: r };
      if (r.state === "running" || r.state === "queued") active.push(row);
      else if (r.state === "failed" && r.updatedAt && now - Date.parse(r.updatedAt) < day) failed.push(row);
    });
  });
  var at = function (row) { return Date.parse(row.run.startedAt || row.run.updatedAt || "") || 0; };
  active.sort(function (a, b) { return (a.run.state === b.run.state ? 0 : a.run.state === "running" ? -1 : 1) || at(a) - at(b); });
  failed.sort(function (a, b) { return Date.parse(b.run.updatedAt) - Date.parse(a.run.updatedAt); });
  return { active: active, failed: failed, errors: errors };
}

// "running 4m", "queued 20s", "failed 3h ago": text, never colour alone.
function runLine(run, now) {
  var since = Date.parse(run.state === "failed" ? run.updatedAt || "" : run.startedAt || "");
  var secs = isNaN(since) ? null : Math.max(0, Math.round((now - since) / 1000));
  var span = secs === null ? "" : secs < 90 ? secs + "s" : secs < 5400 ? Math.round(secs / 60) + "m" : Math.round(secs / 3600) + "h";
  var head = run.state === "failed" ? "failed" + (span ? " " + span + " ago" : "") : run.state + (span ? " " + span : "");
  return head + " · " + run.workflow + " · " + (run.branch || "?");
}

// What a run belongs to: the ticket key in its branch or title (by the
// project's own patterns) and the live cards of that project that land on
// the same branch or carry the same key.
function runRefs(run, project, tasks, projects) {
  var key = ticketKeyOf([run.branch, run.title], project && project.ticketPatterns);
  var cards = project ? tasks.filter(function (t) {
    if (t.archivedAt || projectForRepo(t.repo, projects) !== project) return false;
    return (!!run.branch && t.mergeTarget === run.branch) || (!!key && cardTicketKey(t, projects) === key);
  }) : [];
  return { key: key, cards: cards };
}

// "build › Run tests · running 2m": one job as text.
function jobLine(job, now) {
  var from = Date.parse(job.state === "running" || job.state === "queued" ? job.startedAt || "" : job.completedAt || "");
  var secs = isNaN(from) ? null : Math.max(0, Math.round((now - from) / 1000));
  var span = secs === null ? "" : secs < 90 ? secs + "s" : secs < 5400 ? Math.round(secs / 60) + "m" : Math.round(secs / 3600) + "h";
  var done = job.state === "failed" || job.state === "passed";
  var head = job.state === "other" ? "skipped" : job.state;
  return job.name + (job.step ? " › " + job.step : "") + " · " + head + (span ? (done ? " " + span + " ago" : " " + span) : "");
}

// GET /github as { projectId: { branch: pr } }, or the project's error.
function prsByProject(answer) {
  var out = {};
  ((answer && answer.projects) || []).forEach(function (p) {
    if (p.error) { out[p.id] = { error: p.error, byBranch: {} }; return; }
    var byBranch = {};
    (p.prs || []).forEach(function (pr) { byBranch[pr.branch] = pr; });
    out[p.id] = { repo: p.repo, byBranch: byBranch };
  });
  return out;
}

// The live cards (not archived) that belong to ticket `key`, by the same
// rule the chip uses.
function cardsForTicket(key, tasks, projects) {
  return tasks.filter(function (t) { return !t.archivedAt && cardTicketKey(t, projects) === key; });
}

// What the New card form is filled with for a ticket: a title that names
// the key (so the card finds its ticket again), a body that points back
// at the ticket, and a repo only when exactly one project sets a ticket
// pattern that matches the key. The person reviews and submits it; nothing
// is created here. The ticket text is the tracker's, shown as typed.
function ticketCardDraft(ticket, projects) {
  var title = (ticket.key + ": " + (ticket.summary || "")).replace(/\s+/g, " ").trim();
  if (title.length > 200) title = title.slice(0, 199) + "…";
  var body = ["Jira ticket " + ticket.key + (ticket.url ? " — " + ticket.url : ""), ticket.status ? "Status in Jira: " + ticket.status : "", "", ticket.summary || ""].join("\n").trim();
  var matches = projects.filter(function (p) {
    return p.ticketPatterns && p.ticketPatterns.length && ticketKeyOf([ticket.key], p.ticketPatterns) === ticket.key;
  });
  return { title: title, body: body, repo: matches.length === 1 ? matches[0].path : undefined };
}

// key -> { cards, branches } for every ticket GET /work names.
function workByKey(work) {
  var out = {};
  ((work && work.tickets) || []).forEach(function (t) { if (t.key) out[t.key] = { cards: t.cardCount, branches: t.branchCount }; });
  return out;
}

// Has anything been started for this ticket: a live card, or a branch.
function ticketStarted(key, tasks, projects, byKey) {
  var w = byKey && byKey[key];
  return cardsForTicket(key, tasks, projects).length > 0 || !!(w && (w.cards > 0 || w.branches > 0));
}

// Tickets grouped by their epic (the tracker's parent), epics in order of
// their first ticket, tickets without one last. Order inside is kept.
function epicGroups(tickets) {
  var groups = [];
  var byKey = {};
  var none = null;
  tickets.forEach(function (t) {
    if (!t.parent) {
      if (!none) { none = { epic: null, tickets: [] }; }
      none.tickets.push(t);
      return;
    }
    var g = byKey[t.parent.key];
    if (!g) { g = { epic: t.parent, tickets: [] }; byKey[t.parent.key] = g; groups.push(g); }
    g.tickets.push(t);
  });
  if (none) groups.push(none);
  return groups;
}

// What one feature lane (its cards) says about my Jira tickets. `known`
// is { key: ticket } for the keys the cards name (GET /tickets), `mine`
// the tickets assigned to me. A lane is implemented when one of its cards
// is done. Its epics are the parents of the tickets its cards name; any of
// my open tickets under those epics is related, and one the cards do not
// name themselves is a follow-up.
function featureFollowUps(laneCards, mine, known, projects) {
  var laneKeys = {};
  laneCards.forEach(function (c) {
    var k = cardTicketKey(c, projects);
    if (k) laneKeys[k] = true;
  });
  var epics = {};
  var epicList = [];
  Object.keys(laneKeys).forEach(function (k) {
    var t = known[k];
    if (t && t.parent && !epics[t.parent.key]) { epics[t.parent.key] = true; epicList.push(t.parent); }
  });
  var related = mine.filter(function (t) { return t.parent && epics[t.parent.key]; });
  return {
    implemented: laneCards.some(function (c) { return c.status === "done"; }),
    epics: epicList,
    own: related.filter(function (t) { return laneKeys[t.key]; }),
    followUps: related.filter(function (t) { return !laneKeys[t.key]; }),
  };
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
    prLine: prLine,
    cardsForTicket: cardsForTicket,
    workByKey: workByKey,
    ticketStarted: ticketStarted,
    epicGroups: epicGroups,
    featureFollowUps: featureFollowUps,
    ticketCardDraft: ticketCardDraft,
    prsByProject: prsByProject,
    ciView: ciView,
    runLine: runLine,
    runRefs: runRefs,
    jobLine: jobLine,
  };
}
