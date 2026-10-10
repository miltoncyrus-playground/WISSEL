// Plain fuzzy matching for the command palette (docs/SDD-wissel-app.md
// §3.1): no library. A query matches a text when its characters appear
// in the text in order (case-insensitive, spaces in the query ignored).
// The score rewards what people mean when they type a few letters:
// matches at the start of the text or of a word, and runs of
// consecutive characters. Higher is better; null is no match.

const WORD_BREAK = /[\s\-_/.:#()[\]]/;

export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const t = text.toLowerCase();

  // A plain substring is the strongest signal; it beats any scattered
  // subsequence, and earlier beats later.
  const at = t.indexOf(q);
  if (at !== -1) {
    const wordStart = at === 0 || WORD_BREAK.test(t[at - 1]!);
    return 1000 + (wordStart ? 200 : 0) - at - (t.length - q.length) * 0.01;
  }

  // Jumping ahead to a word start can strand the rest of the query
  // ("ac" in "xa_c ab"), so a plain nearest-first pass backs it up:
  // that one finds a match whenever the subsequence exists at all.
  return subsequenceScore(q, t, true) ?? subsequenceScore(q, t, false);
}

function subsequenceScore(q: string, t: string, preferWordStart: boolean): number | null {
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    // Take a consecutive or word-start occurrence when preferring one
    // and there is one ahead; otherwise the nearest.
    let found = -1;
    let firstAny = -1;
    for (let i = ti; i < t.length; i++) {
      if (t[i] !== ch) continue;
      if (firstAny === -1) firstAny = i;
      if (!preferWordStart) break;
      if (i === prev + 1 || i === 0 || WORD_BREAK.test(t[i - 1]!)) { found = i; break; }
    }
    if (found === -1) found = firstAny;
    if (found === -1) return null;
    if (found === prev + 1) score += 15;
    if (found === 0 || WORD_BREAK.test(t[found - 1]!)) score += 10;
    score += 1;
    score -= (found - ti) * 0.1;
    prev = found;
    ti = found + 1;
  }
  return score;
}

/** Items that match `query`, best first. Ties keep the input order, so
 *  callers control what wins (screens before cards, say). An empty
 *  query returns every item in input order. */
export function fuzzyFilter<T>(query: string, items: readonly T[], text: (item: T) => string): T[] {
  const scored: { item: T; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const score = fuzzyScore(query, text(item));
    if (score !== null) scored.push({ item, score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((s) => s.item);
}
