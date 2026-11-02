const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Market = require('../models/Market');
const { notifyOwners } = require('../services/telegram');

const STARTER_WORKER_LIMIT = 3;

// Dashboard pages a cashier can be granted access to (see requirePermission
// in auth.middleware.js). Kassa itself is always open to every cashier and
// has no key here.
const PERMISSION_KEYS = ['overview', 'products', 'sales-history', 'analytics', 'dead-stock', 'ai', 'nasiya'];

function sanitizePermissions(permissions) {
  if (!Array.isArray(permissions)) return undefined;
  return [...new Set(permissions.filter((p) => PERMISSION_KEYS.includes(p)))];
}

async function list(req, res) {
  const workers = await User.find({ role: 'cashier', market: req.user.market })
    .select('-passwordHash')
    .sort({ name: 1 });
  res.json({ workers });
}

async function create(req, res) {
  const { name, username, password, permissions } = req.body;
  if (!name || !username || !password) {
    return res.status(400).json({ message: 'Ism, login va parol kerak' });
  }

  const existing = await User.findOne({ market: req.user.market, username });
  if (existing) {
    return res.status(409).json({ message: 'Bu login band' });
  }

  const market = await Market.findById(req.user.market).select('plan');
  if (market?.plan !== 'pro') {
    const workerCount = await User.countDocuments({ market: req.user.market, role: 'cashier' });
    if (workerCount >= STARTER_WORKER_LIMIT) {
      return res.status(403).json({
        message: `Oddiy rejada eng ko'pi bilan ${STARTER_WORKER_LIMIT} xodim qo'shish mumkin. Ko'proq xodim qo'shish uchun Pro rejaga o'ting.`,
      });
    }
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const worker = await User.create({
    name,
    username,
    passwordHash,
    role: 'cashier',
    market: req.user.market,
    active: true,
    permissions: sanitizePermissions(permissions) || [],
  });

  const { passwordHash: _omit, ...safeWorker } = worker.toObject();

  notifyOwners(req.user.market, `👤 Yangi xodim qo'shildi: ${name} (${username})`).catch((err) =>
    console.error('Telegram notify error', err)
  );

  res.status(201).json({ worker: safeWorker });
}

async function update(req, res) {
  const { name, active, permissions } = req.body;
  const sanitizedPermissions = sanitizePermissions(permissions);
  const worker = await User.findOneAndUpdate(
    { _id: req.params.id, role: 'cashier', market: req.user.market },
    {
      ...(name && { name }),
      ...(active !== undefined && { active }),
      ...(sanitizedPermissions !== undefined && { permissions: sanitizedPermissions }),
    },
    { new: true, runValidators: true }
  ).select('-passwordHash');

  if (!worker) {
    return res.status(404).json({ message: 'Xodim topilmadi' });
  }
  res.json({ worker });
}

async function resetPassword(req, res) {
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ message: 'Yangi parol kerak' });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const worker = await User.findOneAndUpdate(
    { _id: req.params.id, role: 'cashier', market: req.user.market },
    { passwordHash },
    { new: true }
  ).select('-passwordHash');

  if (!worker) {
    return res.status(404).json({ message: 'Xodim topilmadi' });
  }
  res.json({ worker });
}

module.exports = { list, create, update, resetPassword };
