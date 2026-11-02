const Debtor = require('../models/Debtor');
const DebtPayment = require('../models/DebtPayment');
const Sale = require('../models/Sale');
const { buildNameSearchFilter } = require('../utils/nameSearch');

async function list(req, res) {
  const filter = { market: req.user.market, active: true };
  const q = String(req.query.q || '').trim();
  if (q) {
    Object.assign(filter, buildNameSearchFilter(q));
  }
  const debtors = await Debtor.find(filter).sort({ balance: -1, name: 1 });
  res.json({ debtors });
}

async function create(req, res) {
  const { name, phone, note } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ message: 'Ism kerak' });
  }
  const debtor = await Debtor.create({
    market: req.user.market,
    name: name.trim(),
    phone: phone?.trim(),
    note: note?.trim(),
    createdBy: req.user.id,
  });
  res.status(201).json({ debtor });
}

async function update(req, res) {
  const { name, phone, note, active } = req.body || {};
  const debtor = await Debtor.findOneAndUpdate(
    { _id: req.params.id, market: req.user.market },
    {
      ...(name !== undefined && { name: name.trim() }),
      ...(phone !== undefined && { phone: phone.trim() }),
      ...(note !== undefined && { note: note.trim() }),
      ...(active !== undefined && { active }),
    },
    { new: true, runValidators: true }
  );
  if (!debtor) {
    return res.status(404).json({ message: 'Nasiyachi topilmadi' });
  }
  res.json({ debtor });
}

async function getOne(req, res) {
  const debtor = await Debtor.findOne({ _id: req.params.id, market: req.user.market });
  if (!debtor) {
    return res.status(404).json({ message: 'Nasiyachi topilmadi' });
  }
  const [purchases, payments] = await Promise.all([
    Sale.find({ market: req.user.market, debtor: debtor._id, status: 'completed' })
      .select('items total completedAt')
      .sort({ completedAt: -1 }),
    DebtPayment.find({ market: req.user.market, debtor: debtor._id })
      .sort({ createdAt: -1 })
      .populate('recordedBy', 'name'),
  ]);
  res.json({ debtor, purchases, payments });
}

async function recordPayment(req, res) {
  const amount = Number(req.body?.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ message: "To'lov summasi noto'g'ri" });
  }

  const debtor = await Debtor.findOneAndUpdate(
    { _id: req.params.id, market: req.user.market, balance: { $gte: amount } },
    { $inc: { balance: -amount } },
    { new: true }
  );
  if (!debtor) {
    return res.status(409).json({ message: "Qarz summasi yetarli emas yoki nasiyachi topilmadi" });
  }

  const payment = await DebtPayment.create({
    market: req.user.market,
    debtor: debtor._id,
    amount,
    note: req.body?.note?.trim(),
    recordedBy: req.user.id,
  });

  res.status(201).json({ debtor, payment });
}

async function remove(req, res) {
  const debtor = await Debtor.findOne({ _id: req.params.id, market: req.user.market });
  if (!debtor) {
    return res.status(404).json({ message: 'Nasiyachi topilmadi' });
  }
  if (debtor.balance > 0) {
    return res.status(409).json({ message: "Qarzi tugamagan nasiyachini o'chirib bo'lmaydi" });
  }
  debtor.active = false;
  await debtor.save();
  res.json({ debtor });
}

module.exports = { list, create, update, getOne, recordPayment, remove };
