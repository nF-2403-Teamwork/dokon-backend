const Market = require('../models/Market');

// Safety-net staleness bound only — the primary mechanism is explicit
// invalidation from admin.controller the instant a superadmin changes a
// market, so in practice a change is visible to that market's very next
// request, not after this TTL ticks.
const TTL_MS = 30_000;

const cache = new Map(); // marketId string -> { active, plan, subscriptionExpiresAt, expiresAt }

function toEntry(market) {
  return {
    active: market.active,
    plan: market.plan,
    subscriptionExpiresAt: market.subscriptionExpiresAt,
    expiresAt: Date.now() + TTL_MS,
  };
}

async function getMarketStatus(marketId) {
  const key = marketId.toString();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const market = await Market.findById(marketId).select('active plan subscriptionExpiresAt');
  if (!market) {
    cache.delete(key);
    return null;
  }
  const entry = toEntry(market);
  cache.set(key, entry);
  return entry;
}

// Called right after a superadmin mutates a market so the new status is
// visible immediately, not after the TTL expires.
function setMarketStatus(market) {
  cache.set(market._id.toString(), toEntry(market));
}

// Called right after a superadmin hard-deletes a market, so a still-valid
// JWT for that market 403s on its very next request instead of continuing
// to pass for up to TTL_MS off a stale cached entry.
function clearMarketStatus(marketId) {
  cache.delete(marketId.toString());
}

module.exports = { getMarketStatus, setMarketStatus, clearMarketStatus };
