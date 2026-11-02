const mongoose = require('mongoose');
const Sale = require('../models/Sale');
const Product = require('../models/Product');
const { paginationParams } = require('../utils/pagination');

function buildMatch(req) {
  const match = { market: new mongoose.Types.ObjectId(req.user.market), status: 'completed' };

  const range = {};
  if (req.query.from) range.$gte = new Date(req.query.from);
  if (req.query.to) range.$lte = new Date(req.query.to);
  if (range.$gte || range.$lte) match.completedAt = range;

  return match;
}

async function summary(req, res) {
  const match = buildMatch(req);
  const [result] = await Sale.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalRevenue: { $sum: '$total' },
        totalTransactions: { $sum: 1 },
      },
    },
  ]);

  const totalRevenue = result?.totalRevenue || 0;
  const totalTransactions = result?.totalTransactions || 0;
  res.json({
    totalRevenue,
    totalTransactions,
    averageSale: totalTransactions > 0 ? Math.round(totalRevenue / totalTransactions) : 0,
  });
}

async function topProducts(req, res) {
  const match = buildMatch(req);
  const limit = Math.min(Number(req.query.limit) || 10, 100);

  const rows = await Sale.aggregate([
    { $match: match },
    { $unwind: '$items' },
    {
      $group: {
        _id: '$items.product',
        name: { $first: '$items.name' },
        barcode: { $first: '$items.barcode' },
        unit: { $first: '$items.unit' },
        quantity: { $sum: '$items.quantity' },
        revenue: { $sum: '$items.lineTotal' },
      },
    },
    { $sort: { revenue: -1 } },
    { $limit: limit },
  ]);

  res.json({ products: rows });
}

async function daily(req, res) {
  const match = buildMatch(req);

  const rows = await Sale.aggregate([
    { $match: match },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$completedAt' } },
        revenue: { $sum: '$total' },
        transactions: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  res.json({ days: rows.map((r) => ({ date: r._id, revenue: r.revenue, transactions: r.transactions })) });
}

// Current stock valued two ways: at selling price (what the shelf is worth
// if sold today) and at cost price (what was actually paid for it — the
// number that matters for "how much money is tied up in inventory"). Unlike
// the other endpoints this isn't a Sale aggregation — it's a snapshot of
// Product.stock right now, so quantity and unit (dona/kg) don't need any
// special handling: stock * price is already correct per-unit either way.
async function inventoryValue(req, res) {
  const [result] = await Product.aggregate([
    { $match: { market: new mongoose.Types.ObjectId(req.user.market), active: true } },
    {
      $group: {
        _id: null,
        totalSellValue: { $sum: { $multiply: ['$stock', '$price'] } },
        totalCostValue: { $sum: { $multiply: ['$stock', { $ifNull: ['$costPrice', 0] }] } },
        productCount: { $sum: 1 },
        missingCostPriceCount: {
          $sum: { $cond: [{ $eq: [{ $type: '$costPrice' }, 'missing'] }, 1, 0] },
        },
      },
    },
  ]);

  res.json({
    totalSellValue: result?.totalSellValue || 0,
    totalCostValue: result?.totalCostValue || 0,
    productCount: result?.productCount || 0,
    missingCostPriceCount: result?.missingCostPriceCount || 0,
  });
}

// ABC day-since-last-sold tiers (the "ABC tahlil" mode). Boundaries
// don't overlap at 5/15 — a product sold exactly 5 days ago lands in A, not B.
const ABC_BUCKETS = {
  A: (daysSince) => daysSince !== null && daysSince >= 1 && daysSince <= 5,
  B: (daysSince) => daysSince !== null && daysSince > 5 && daysSince <= 15,
  C: (daysSince) => daysSince === null || daysSince > 15,
};

async function deadStock(req, res) {
  const { to, bucket } = req.query;
  // Presence of `to`/`bucket` is what selects the new range+tier mode (used
  // by the ABC tahlil mode); omitting both keeps the original
  // `days`-threshold behavior so client/'s unmodified DeadStockPage keeps
  // working against the same endpoint.
  const useRange = to !== undefined || bucket !== undefined;

  let referenceDate;
  let days;
  let cutoff;
  if (useRange) {
    referenceDate = to ? new Date(to) : new Date();
  } else {
    days = Number(req.query.days) || 30;
    referenceDate = new Date();
    cutoff = new Date(referenceDate);
    cutoff.setDate(cutoff.getDate() - days);
  }

  const lastSold = await Sale.aggregate([
    {
      $match: {
        market: new mongoose.Types.ObjectId(req.user.market),
        status: 'completed',
        // Only bounded by the selected period's end (`to`), never its start —
        // a product's true "days since last sold" has to look as far back as
        // it takes, otherwise a short period could never surface a genuinely
        // dead (tier C) product. The period's start is purely a UI affordance
        // borrowed from the Tahlillar page's picker, not a query filter here.
        ...(useRange ? { completedAt: { $lte: referenceDate } } : {}),
      },
    },
    { $unwind: '$items' },
    { $group: { _id: '$items.product', lastSoldAt: { $max: '$completedAt' } } },
  ]);
  const lastSoldMap = new Map(lastSold.map((r) => [r._id.toString(), r.lastSoldAt]));

  const products = await Product.find({ market: req.user.market, active: true, stock: { $gt: 0 } });
  let allRows = products.map((p) => {
    const lastSoldAt = lastSoldMap.get(p._id.toString()) || null;
    const daysSince = lastSoldAt ? Math.floor((referenceDate - lastSoldAt) / (1000 * 60 * 60 * 24)) : null;
    return {
      _id: p._id,
      name: p.name,
      barcode: p.barcode,
      stock: p.stock,
      unit: p.unit,
      price: p.price,
      lastSoldAt,
      daysSince,
    };
  });

  if (useRange) {
    const matchesBucket = ABC_BUCKETS[bucket];
    allRows = allRows.filter((p) => (matchesBucket ? matchesBucket(p.daysSince) : p.daysSince === null || p.daysSince >= 1));
  } else {
    allRows = allRows.filter((p) => !p.lastSoldAt || p.lastSoldAt < cutoff);
  }
  allRows.sort((a, b) => (a.lastSoldAt?.getTime() || 0) - (b.lastSoldAt?.getTime() || 0));

  const { page, limit, skip } = paginationParams(req.query, { defaultLimit: 20, maxLimit: 100 });
  const rows = allRows.slice(skip, skip + limit);

  res.json({ products: rows, total: allRows.length, page, limit, ...(useRange ? { to: referenceDate, bucket: bucket || null } : { days }) });
}

module.exports = { summary, topProducts, daily, deadStock, inventoryValue };
