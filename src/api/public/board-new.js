// Pure: the "+ New" drawer's card search (docs/SDD-ui-cleanup.md §3.3,
// card A3). No DOM, no side effects — same house style as board-lanes.js,
// and directly `import`-able from bun test the same way (see the
// module.exports guard at the bottom). board.html's glue just calls
// searchLiveCards(tasks, query, ...) on every keystroke and draws the
// result list.
//
// "Depends on" and "Follow-up of" both search the same set: live cards,
// meaning not done, not archived and not superseded. Done and archived
// cards are finished work and superseded ones are replaced attempts, so
// none of them is something new work should wait on or hand off from.

var CARD_SEARCH_LIMIT = 8;

function isLiveCard(t) {
  return !!t && t.status !== "done" && !t.archivedAt && !t.supersededBy;
}

// Lower-cased words of the query. An empty query matches every live card,
// so focusing the box lists the most recent ones before anything is typed.
function searchTerms(query) {
  return String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
}

// Every term must appear somewhere in the card's title, id, status or
// routed agent, so "fix login" finds "Fix the login redirect" and an id
// pasted from a drawer finds its card.
function cardMatches(t, terms) {
  var hay = [t.title, t.id, t.status, t.routedTo].filter(Boolean).join(" ").toLowerCase();
  return terms.every(function (term) { return hay.indexOf(term) !== -1; });
}

// opts.exclude: ids already picked (a dependency can't be added twice).
// opts.routedOnly: only cards with a routed agent. "Follow-up of" sets it:
// the follow-up restricts routing to the parent's declared handoffs, and
// a card that was never routed has none to restrict to.
// opts.limit: at most this many results (default CARD_SEARCH_LIMIT).
// Newest first: GET /tasks lists cards in creation order (SqliteBoard.list,
// ORDER BY rowid) and TaskCard has no creation time, so this walks
// `tasks` from the end.
function searchLiveCards(tasks, query, opts) {
  opts = opts || {};
  var exclude = {};
  (opts.exclude || []).forEach(function (id) { exclude[id] = true; });
  var limit = typeof opts.limit === "number" ? opts.limit : CARD_SEARCH_LIMIT;
  var terms = searchTerms(query);
  var list = tasks || [];
  var hits = [];
  for (var i = list.length - 1; i >= 0 && hits.length < limit; i--) {
    var t = list[i];
    if (!isLiveCard(t) || exclude[t.id]) continue;
    if (opts.routedOnly && !t.routedTo) continue;
    if (cardMatches(t, terms)) hits.push(t);
  }
  return hits;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    CARD_SEARCH_LIMIT: CARD_SEARCH_LIMIT,
    isLiveCard: isLiveCard,
    searchLiveCards: searchLiveCards,
  };
}
