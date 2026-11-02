const { escapeRegex } = require('./escapeRegex');

// Splits a search string into words and requires every word to appear
// somewhere in the name (in any order), instead of the whole string matching
// as one substring. Lets "oq non" find "Non oq (katta)" and lets a cashier's
// multi-word typing find a product regardless of word order — a single
// $regex on the raw string only ever matched an exact substring.
function buildNameSearchFilter(query, field = 'name') {
  const words = String(query || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return null;
  return { $and: words.map((w) => ({ [field]: { $regex: escapeRegex(w), $options: 'i' } })) };
}

module.exports = { buildNameSearchFilter };
