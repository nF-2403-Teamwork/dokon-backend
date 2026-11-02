// Normalizes free-text before comparing it against a catalog name — lower
// case, punctuation stripped, whitespace collapsed — so STT quirks (extra
// spaces, stray commas) don't count against the similarity score.
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[.,!?'"()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Classic Levenshtein edit distance (insert/delete/substitute), O(a*b) DP.
// Product names here are short (a few words), so this is plenty fast even
// run against a market's whole catalog per request.
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// 0..1 similarity — 1 means identical, 0 means completely different.
function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(na, nb) / maxLen;
}

// Scores every item's `name` against `query`, returns the top `limit`
// sorted by score descending. `getName` lets callers pass plain objects
// (e.g. Product docs) without pre-mapping to strings.
function bestMatches(query, items, { limit = 5, getName = (item) => item.name } = {}) {
  return items
    .map((item) => ({ item, score: similarity(query, getName(item)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

module.exports = { normalize, levenshtein, similarity, bestMatches };
