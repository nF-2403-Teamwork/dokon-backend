// Escapes regex metacharacters in user-supplied search text before it's used
// in a MongoDB $regex filter. Without this, a crafted search string (e.g. one
// with catastrophic backtracking) can hang the query — and since the DB
// connection pool is shared across every tenant, that's a cross-tenant
// denial-of-service, not just a problem for the requester's own market.
function escapeRegex(input) {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { escapeRegex };
