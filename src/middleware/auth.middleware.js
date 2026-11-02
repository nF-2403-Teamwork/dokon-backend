const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { getMarketStatus } = require('../services/marketCache');

function verifyToken(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: 'Token topilmadi' });
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Token yaroqsiz yoki muddati tugagan' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Ruxsat yoʻq' });
    }
    next();
  };
}

// Checked on every tenant request (not baked into the JWT) so a superadmin
// disabling a market, letting its subscription lapse, or changing its plan
// takes effect immediately — no waiting for the token to expire or forcing
// a re-login. Backed by an in-process cache (see services/marketCache) that
// admin.controller invalidates the instant it mutates a market, so this adds
// no per-request network round trip in the common case — only a genuine
// state change costs a DB hit, not every request. Stashes the result on
// req.market so requirePlan below reuses it instead of checking again.
function loadMarket() {
  return async (req, res, next) => {
    if (!req.user.market) return next(); // superadmin — no tenant market to check
    const market = await getMarketStatus(req.user.market);
    if (!market || !market.active || market.subscriptionExpiresAt < new Date()) {
      return res.status(403).json({ message: "Obuna muddati tugagan. Administrator bilan bogʻlaning." });
    }
    req.market = market;
    next();
  };
}

function requirePlan(...plans) {
  return (req, res, next) => {
    if (!req.market || !plans.includes(req.market.plan)) {
      return res.status(403).json({ message: "Bu funksiya faqat Pro rejada mavjud" });
    }
    next();
  };
}

// Page-level access for cashiers, set per-worker by the owner (User.permissions).
// Owners always pass — they're not restricted by this system, only cashiers
// are. Not baked into the JWT (same reasoning as loadMarket: an owner can
// change a cashier's permissions and expects it to take effect on that
// cashier's next request, not after a 12h token expiry/re-login), so this
// costs one extra User lookup per gated request for cashiers only.
function requirePermission(...keys) {
  return async (req, res, next) => {
    if (req.user.role === 'owner') return next();
    if (req.user.role !== 'cashier') return res.status(403).json({ message: 'Ruxsat yoʻq' });

    const user = await User.findById(req.user.id).select('permissions active');
    if (!user || !user.active || !keys.some((k) => user.permissions.includes(k))) {
      return res.status(403).json({ message: 'Ruxsat yoʻq' });
    }
    next();
  };
}

module.exports = { verifyToken, requireRole, loadMarket, requirePlan, requirePermission };
