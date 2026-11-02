const mongoose = require('mongoose');
const Sale = require('../models/Sale');
const Product = require('../models/Product');
const Shift = require('../models/Shift');
const Debtor = require('../models/Debtor');
const User = require('../models/User');
const { emitToMarket } = require('../socket');
const { paginationParams } = require('../utils/pagination');
const { notifyOwners } = require('../services/telegram');
const { isFractionalUnit, unitLabel } = require('../utils/units');

const PAYMENT_METHODS = ['cash', 'card', 'online', 'nasiya'];

async function saveWithConflictHandling(res, sale) {
  try {
    await sale.save();
    return true;
  } catch (err) {
    if (err instanceof mongoose.Error.VersionError) {
      res.status(409).json({ message: 'Savdo boshqa amaliyot tomonidan yangilandi. Qayta urinib koʻring.' });
      return false;
    }
    throw err;
  }
}

async function listMine(req, res) {
  const sales = await Sale.find({
    cashier: req.user.id,
    market: req.user.market,
    status: 'open',
  }).sort({ createdAt: 1 });
  res.json({ sales });
}

async function listHistory(req, res) {
  const { from, to, cashier, paymentMethod } = req.query;
  const query = { market: req.user.market, status: 'completed' };

  if (req.user.role === 'cashier') {
    query.cashier = req.user.id;
  } else if (cashier) {
    query.cashier = cashier;
  }

  if (paymentMethod && PAYMENT_METHODS.includes(paymentMethod)) {
    query.paymentMethod = paymentMethod;
  }

  if (from || to) {
    query.completedAt = {};
    if (from) query.completedAt.$gte = new Date(from);
    if (to) query.completedAt.$lte = new Date(to);
  }

  const { page, limit, skip } = paginationParams(req.query, { defaultLimit: 20, maxLimit: 100 });
  const [sales, total] = await Promise.all([
    Sale.find(query)
      .sort({ completedAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('cashier', 'name')
      .populate('debtor', 'name'),
    Sale.countDocuments(query),
  ]);
  res.json({ sales, total, page, limit });
}

async function create(req, res) {
  // Owners aren't shift-tracked (see models/Shift.js) — only cashiers must
  // start a shift before the till accepts a new sale.
  if (req.user.role === 'cashier') {
    const openShift = await Shift.findOne({ market: req.user.market, cashier: req.user.id, status: 'open' });
    if (!openShift) {
      return res.status(403).json({ message: 'Avval ishni boshlash kerak' });
    }
  }

  const sale = await Sale.create({
    market: req.user.market,
    cashier: req.user.id,
    items: [],
    total: 0,
    status: 'open',
  });
  res.status(201).json({ sale });
}

async function getOne(req, res) {
  const sale = await Sale.findOne({ _id: req.params.id, market: req.user.market }).populate(
    'cashier',
    'name'
  );
  if (!sale) {
    return res.status(404).json({ message: 'Savdo topilmadi' });
  }
  if (req.user.role === 'cashier' && sale.cashier._id.toString() !== req.user.id) {
    return res.status(403).json({ message: 'Ruxsat yoʻq' });
  }
  res.json({ sale });
}

async function findOpenOwned(req) {
  const sale = await Sale.findOne({ _id: req.params.id, market: req.user.market });
  if (!sale) return { error: 404, message: 'Savdo topilmadi' };
  if (sale.cashier.toString() !== req.user.id) return { error: 403, message: 'Ruxsat yoʻq' };
  if (sale.status !== 'open') return { error: 409, message: 'Bu savdo allaqachon yakunlangan' };
  return { sale };
}

async function updateItems(req, res) {
  const { error, message, sale } = await findOpenOwned(req);
  if (error) return res.status(error).json({ message });

  const { items } = req.body; // [{ productId, quantity }]
  if (!Array.isArray(items)) {
    return res.status(400).json({ message: "Mahsulotlar roʻyxati kerak" });
  }

  const resolvedItems = [];
  for (let { productId, quantity } of items) {
    if (!quantity || quantity <= 0) continue;
    const product = await Product.findOne({
      _id: productId,
      market: req.user.market,
      active: true,
    });
    if (!product) {
      return res.status(404).json({ message: 'Mahsulot topilmadi' });
    }

    // 'dona' items are always whole pieces; fractional-unit items ('kg',
    // 'metr') are sold by weight/length, so round to 1/1000 precision to
    // avoid floating-point noise (e.g. 0.1+0.2) from the cashier UI's
    // +/- stepper.
    if (isFractionalUnit(product.unit)) {
      quantity = Math.round(quantity * 1000) / 1000;
    } else if (!Number.isInteger(quantity)) {
      return res.status(400).json({
        message: `"${product.name}" donalik mahsulot — miqdor butun son bo'lishi kerak`,
        productId: product._id,
      });
    }
    if (quantity <= 0) continue;

    if (quantity > product.stock) {
      return res.status(409).json({
        message: `Omborda faqat ${product.stock} ${unitLabel(product.unit)} "${product.name}" bor`,
        productId: product._id,
        available: product.stock,
      });
    }
    resolvedItems.push({
      product: product._id,
      barcode: product.barcode,
      name: product.name,
      price: product.price,
      unit: product.unit,
      quantity,
      lineTotal: product.price * quantity,
    });
  }

  sale.items = resolvedItems;
  sale.total = resolvedItems.reduce((sum, i) => sum + i.lineTotal, 0);
  if (!(await saveWithConflictHandling(res, sale))) return;
  res.json({ sale });
}

async function complete(req, res) {
  const { paymentMethod, debtorId } = req.body || {};
  if (!PAYMENT_METHODS.includes(paymentMethod)) {
    return res.status(400).json({ message: "To'lov turini tanlang" });
  }

  const { error, message, sale } = await findOpenOwned(req);
  if (error) return res.status(error).json({ message });

  if (sale.items.length === 0) {
    return res.status(400).json({ message: "Boʻsh savdoni yakunlab boʻlmaydi" });
  }

  // Nasiya is a Pro-only, per-cashier-permission feature (unlike the rest of
  // this endpoint's payment methods, which every cashier can always use), so
  // it's gated here rather than on the whole route — see requirePlan/
  // requirePermission in auth.middleware.js for the same checks applied as
  // route-level middleware on debtors.routes.js.
  let debtor = null;
  if (paymentMethod === 'nasiya') {
    if (req.market.plan !== 'pro') {
      return res.status(403).json({ message: 'Bu funksiya faqat Pro rejada mavjud' });
    }
    if (req.user.role === 'cashier') {
      const cashier = await User.findById(req.user.id).select('permissions active');
      if (!cashier || !cashier.active || !cashier.permissions.includes('nasiya')) {
        return res.status(403).json({ message: 'Ruxsat yoʻq' });
      }
    }
    debtor = await Debtor.findOne({ _id: debtorId, market: req.user.market, active: true });
    if (!debtor) {
      return res.status(404).json({ message: 'Nasiyachi topilmadi' });
    }
  }

  const products = [];
  for (const item of sale.items) {
    const product = await Product.findById(item.product);
    if (!product || product.stock < item.quantity) {
      return res.status(409).json({ message: `Omborda "${item.name}" uchun yetarli miqdor yoʻq` });
    }
    products.push(product);
  }

  const stockDiffs = [];
  for (let i = 0; i < sale.items.length; i++) {
    const item = sale.items[i];
    const product = products[i];
    await Product.updateOne({ _id: item.product }, { $inc: { stock: -item.quantity } });
    stockDiffs.push({
      productId: product._id,
      stock: product.stock - item.quantity,
      name: product.name,
      barcode: product.barcode,
    });
  }

  sale.status = 'completed';
  sale.completedAt = new Date();
  sale.paymentMethod = paymentMethod;
  if (debtor) sale.debtor = debtor._id;
  if (!(await saveWithConflictHandling(res, sale))) return;
  if (debtor) await Debtor.updateOne({ _id: debtor._id }, { $inc: { balance: sale.total } });
  emitToMarket(req.user.market, 'stock:changed', stockDiffs);

  const outOfStock = stockDiffs.filter((d) => d.stock === 0);
  if (outOfStock.length > 0) {
    const names = outOfStock.map((d) => `"${d.name}"`).join(', ');
    notifyOwners(req.user.market, `🚨 Omborda tugadi: ${names}`).catch((err) =>
      console.error('Telegram notify error', err)
    );
  }

  res.json({ sale });
}

async function returnItems(req, res) {
  const sale = await Sale.findOne({ _id: req.params.id, market: req.user.market });
  if (!sale) {
    return res.status(404).json({ message: 'Savdo topilmadi' });
  }
  if (sale.status !== 'completed') {
    return res.status(409).json({ message: 'Faqat yakunlangan savdoni qaytarish mumkin' });
  }

  const { items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: "Qaytariladigan mahsulotlar kerak" });
  }

  let totalRefund = 0;
  const stockDiffs = [];
  for (const { itemIndex, quantity } of items) {
    const line = sale.items[itemIndex];
    if (!line) {
      return res.status(400).json({ message: 'Mahsulot qatori topilmadi' });
    }

    let qty = Number(quantity);
    if (isFractionalUnit(line.unit)) {
      qty = Math.round(qty * 1000) / 1000;
    } else if (!Number.isInteger(qty)) {
      return res.status(400).json({
        message: `"${line.name}" donalik mahsulot — qaytarish miqdori butun son bo'lishi kerak`,
      });
    }

    const remaining = line.quantity - (line.returnedQuantity || 0);
    if (!qty || qty <= 0 || qty > remaining) {
      return res.status(400).json({ message: `"${line.name}" uchun qaytarish miqdori noto'g'ri` });
    }

    const refundAmount = qty * line.price;
    line.returnedQuantity = (line.returnedQuantity || 0) + qty;
    line.lineTotal -= refundAmount;
    totalRefund += refundAmount;

    const updatedProduct = await Product.findOneAndUpdate(
      { _id: line.product, market: req.user.market },
      { $inc: { stock: qty } },
      { new: true }
    );
    if (updatedProduct) {
      stockDiffs.push({
        productId: updatedProduct._id,
        stock: updatedProduct.stock,
        name: updatedProduct.name,
        barcode: updatedProduct.barcode,
      });
    }
  }

  sale.total -= totalRefund;
  sale.returnedTotal = (sale.returnedTotal || 0) + totalRefund;
  if (!(await saveWithConflictHandling(res, sale))) return;

  if (sale.debtor) {
    const debtor = await Debtor.findById(sale.debtor);
    if (debtor) {
      debtor.balance = Math.max(0, debtor.balance - totalRefund);
      await debtor.save();
    }
  }

  if (stockDiffs.length > 0) {
    emitToMarket(req.user.market, 'stock:changed', stockDiffs);
  }

  res.json({ sale });
}

async function cancel(req, res) {
  const { error, message, sale } = await findOpenOwned(req);
  if (error) return res.status(error).json({ message });
  // Soft-delete: kept as 'cancelled' (not removed) so cancellations stay
  // countable in reports.
  sale.status = 'cancelled';
  sale.cancelledAt = new Date();
  if (!(await saveWithConflictHandling(res, sale))) return;
  res.json({ message: 'Bekor qilindi' });
}

module.exports = { listMine, listHistory, create, getOne, updateItems, complete, cancel, returnItems };
