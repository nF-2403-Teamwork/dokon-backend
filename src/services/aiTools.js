const Product = require('../models/Product');
const Sale = require('../models/Sale');
const Shift = require('../models/Shift');
const User = require('../models/User');
const { buildNameSearchFilter } = require('../utils/nameSearch');

// OpenAI-compatible function-calling schemas (Groq uses the same shape).
// Every executor below takes the caller's market id explicitly — the model
// never supplies or sees it, so a tenant's data can't leak across markets.
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_sales_summary',
      description:
        "Berilgan sana oralig'idagi umumiy savdo statistikasi: jami daromad, savdolar soni, o'rtacha chek. Sana ko'rsatilmasa (null bo'lsa), oxirgi 30 kun olinadi.",
      parameters: {
        type: 'object',
        properties: {
          from: { type: ['string', 'null'], description: "Boshlanish sanasi (YYYY-MM-DD), bo'lmasa null" },
          to: { type: ['string', 'null'], description: "Tugash sanasi (YYYY-MM-DD), bo'lmasa null" },
        },
        required: ['from', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_top_products',
      description: "Berilgan davrda eng ko'p daromad keltirgan mahsulotlar ro'yxati.",
      parameters: {
        type: 'object',
        properties: {
          from: { type: ['string', 'null'], description: "Boshlanish sanasi (YYYY-MM-DD), bo'lmasa null" },
          to: { type: ['string', 'null'], description: "Tugash sanasi (YYYY-MM-DD), bo'lmasa null" },
          limit: { type: ['integer', 'null'], description: "Nechta mahsulot qaytarilsin, bo'lmasa null (standart 10)" },
        },
        required: ['from', 'to', 'limit'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_products',
      description:
        "Mahsulotlarni nomi bo'yicha qidirish, yoki qoldiq (stock) chegarasi bo'yicha filtrlash (masalan kam qolgan mahsulotlarni topish uchun).",
      parameters: {
        type: 'object',
        properties: {
          search: { type: ['string', 'null'], description: "Mahsulot nomida qidiriladigan matn, bo'lmasa null" },
          maxStock: {
            type: ['integer', 'null'],
            description: "Faqat shu sondan kam yoki teng qoldiqli mahsulotlarni qaytarish, bo'lmasa null",
          },
          limit: { type: ['integer', 'null'], description: "Bo'lmasa null (standart 20, maksimal 50)" },
        },
        required: ['search', 'maxStock', 'limit'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_dead_stock',
      description: "Omborda turgan, lekin ko'rsatilgan kun ichida sotilmagan mahsulotlar ro'yxati.",
      parameters: {
        type: 'object',
        properties: { days: { type: ['integer', 'null'], description: "Bo'lmasa null (standart 30)" } },
        required: ['days'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_profit_summary',
      description:
        "Berilgan sana oralig'idagi foyda (profit) hisoboti: jami daromad, tannarx va sof foyda, foyda marjasi foizda. Mahsulotning JORIY tannarxidan hisoblanadi (sotilgan paytdagi emas), shuning uchun agar tannarx keyinchalik o'zgargan bo'lsa, natija taxminiy bo'lishi mumkin — javob berishda buni eslatib o'tish shart emas, lekin raqamni to'qib chiqarmang.",
      parameters: {
        type: 'object',
        properties: {
          from: { type: ['string', 'null'], description: "Boshlanish sanasi (YYYY-MM-DD), bo'lmasa null" },
          to: { type: ['string', 'null'], description: "Tugash sanasi (YYYY-MM-DD), bo'lmasa null" },
        },
        required: ['from', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compare_sales_periods',
      description:
        "Ikki davr savdosini solishtiradi (masalan 'bu hafta' va 'o'tgan hafta', yoki 'bu oy' va 'o'tgan oy') — daromad, savdolar soni va o'zgarish foizini qaytaradi. compareFrom/compareTo berilmasa, birinchi davr bilan bir xil uzunlikdagi undan oldingi davr avtomatik olinadi.",
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: "Asosiy davr boshlanishi (YYYY-MM-DD)" },
          to: { type: 'string', description: "Asosiy davr tugashi (YYYY-MM-DD)" },
          compareFrom: { type: ['string', 'null'], description: "Solishtiriladigan davr boshlanishi, bo'lmasa null" },
          compareTo: { type: ['string', 'null'], description: "Solishtiriladigan davr tugashi, bo'lmasa null" },
        },
        required: ['from', 'to', 'compareFrom', 'compareTo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_cashier_performance',
      description:
        "Berilgan davrda har bir kassir(xodim) bo'yicha savdo statistikasi: jami daromad, savdolar soni, ishlagan smenalar soni, VA har bir alohida smenada qancha daromad qilingani (smena boshlanish/tugash vaqti bilan birga).",
      parameters: {
        type: 'object',
        properties: {
          from: { type: ['string', 'null'], description: "Boshlanish sanasi (YYYY-MM-DD), bo'lmasa null" },
          to: { type: ['string', 'null'], description: "Tugash sanasi (YYYY-MM-DD), bo'lmasa null" },
        },
        required: ['from', 'to'],
      },
    },
  },
];

function dateRangeMatch(args) {
  const range = {};
  // A bare "YYYY-MM-DD" parses as exactly midnight UTC. When the model uses
  // the same date for both "from" and "to" (e.g. asking about "today"), that
  // collapses the window to a single instant unless "to" is pushed to the
  // end of that day.
  if (args.from) range.$gte = new Date(args.from);
  if (args.to) {
    const to = new Date(args.to);
    to.setUTCHours(23, 59, 59, 999);
    range.$lte = to;
  }
  if (!args.from && !args.to) {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    range.$gte = d;
  }
  return range;
}

// Shared by get_sales_summary and compare_sales_periods so the two periods
// in a comparison are computed with identical logic.
async function salesSummaryForRange(marketId, range) {
  const match = { market: marketId, status: 'completed', completedAt: range };
  const [result] = await Sale.aggregate([
    { $match: match },
    { $group: { _id: null, totalRevenue: { $sum: '$total' }, totalTransactions: { $sum: 1 } } },
  ]);
  const totalRevenue = result?.totalRevenue || 0;
  const totalTransactions = result?.totalTransactions || 0;
  return {
    totalRevenue,
    totalTransactions,
    averageSale: totalTransactions > 0 ? Math.round(totalRevenue / totalTransactions) : 0,
  };
}

async function executeTool(name, args, marketId) {
  switch (name) {
    case 'get_sales_summary': {
      return salesSummaryForRange(marketId, dateRangeMatch(args));
    }

    case 'get_top_products': {
      const match = { market: marketId, status: 'completed', completedAt: dateRangeMatch(args) };
      const limit = Math.min(Number(args.limit) || 10, 50);
      const rows = await Sale.aggregate([
        { $match: match },
        { $unwind: '$items' },
        {
          $group: {
            _id: '$items.product',
            name: { $first: '$items.name' },
            unit: { $first: '$items.unit' },
            quantity: { $sum: '$items.quantity' },
            revenue: { $sum: '$items.lineTotal' },
          },
        },
        { $sort: { revenue: -1 } },
        { $limit: limit },
      ]);
      return {
        products: rows.map((r) => ({ name: r.name, quantity: r.quantity, unit: r.unit || 'dona', revenue: r.revenue })),
      };
    }

    case 'search_products': {
      const filter = { market: marketId, active: true };
      if (args.search) {
        const nameFilter = buildNameSearchFilter(args.search);
        if (nameFilter) Object.assign(filter, nameFilter);
      }
      if (args.maxStock !== undefined && args.maxStock !== null) filter.stock = { $lte: Number(args.maxStock) };
      const limit = Math.min(Number(args.limit) || 20, 50);
      const products = await Product.find(filter).sort({ stock: 1 }).limit(limit);
      return {
        products: products.map((p) => ({
          name: p.name,
          barcode: p.barcode,
          price: p.price,
          stock: p.stock,
          unit: p.unit,
        })),
      };
    }

    case 'get_dead_stock': {
      const days = Number(args.days) || 30;
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      const lastSold = await Sale.aggregate([
        { $match: { market: marketId, status: 'completed' } },
        { $unwind: '$items' },
        { $group: { _id: '$items.product', lastSoldAt: { $max: '$completedAt' } } },
      ]);
      const lastSoldMap = new Map(lastSold.map((r) => [r._id.toString(), r.lastSoldAt]));
      const products = await Product.find({ market: marketId, active: true, stock: { $gt: 0 } });
      const rows = products
        .map((p) => ({
          name: p.name,
          stock: p.stock,
          unit: p.unit,
          lastSoldAt: lastSoldMap.get(p._id.toString()) || null,
        }))
        .filter((p) => !p.lastSoldAt || p.lastSoldAt < cutoff)
        .slice(0, 30);
      return { products: rows };
    }

    case 'get_profit_summary': {
      const match = { market: marketId, status: 'completed', completedAt: dateRangeMatch(args) };
      const rows = await Sale.aggregate([
        { $match: match },
        { $unwind: '$items' },
        {
          $group: {
            _id: '$items.product',
            quantity: { $sum: '$items.quantity' },
            revenue: { $sum: '$items.lineTotal' },
          },
        },
      ]);
      const products = await Product.find({ _id: { $in: rows.map((r) => r._id) } }).select('costPrice');
      const costById = new Map(products.map((p) => [p._id.toString(), p.costPrice]));

      let totalRevenue = 0;
      let totalCost = 0;
      let productsWithoutCostPrice = 0;
      for (const r of rows) {
        totalRevenue += r.revenue;
        const costPrice = costById.get(r._id?.toString());
        if (costPrice === undefined || costPrice === null) {
          productsWithoutCostPrice += 1;
          continue;
        }
        totalCost += costPrice * r.quantity;
      }
      const profit = totalRevenue - totalCost;
      return {
        totalRevenue,
        totalCost,
        profit,
        marginPercent: totalRevenue > 0 ? Math.round((profit / totalRevenue) * 100) : 0,
        // Products that have no costPrice set are excluded from totalCost —
        // a high count here means the real profit is lower than reported.
        productsWithoutCostPrice,
      };
    }

    case 'compare_sales_periods': {
      const range = dateRangeMatch({ from: args.from, to: args.to });
      let compareRange;
      if (args.compareFrom || args.compareTo) {
        compareRange = dateRangeMatch({ from: args.compareFrom, to: args.compareTo });
      } else {
        const from = new Date(args.from);
        const to = new Date(args.to);
        to.setUTCHours(23, 59, 59, 999);
        const lengthMs = to.getTime() - from.getTime() + 1;
        const compareTo = new Date(from.getTime() - 1);
        const compareFrom = new Date(compareTo.getTime() - lengthMs + 1);
        compareRange = { $gte: compareFrom, $lte: compareTo };
      }
      const [current, previous] = await Promise.all([
        salesSummaryForRange(marketId, range),
        salesSummaryForRange(marketId, compareRange),
      ]);
      const revenueChangePercent =
        previous.totalRevenue > 0
          ? Math.round(((current.totalRevenue - previous.totalRevenue) / previous.totalRevenue) * 100)
          : null;
      return { current, previous, revenueChangePercent };
    }

    case 'get_cashier_performance': {
      const range = dateRangeMatch(args);
      const shifts = await Shift.find({ market: marketId, startedAt: range }).sort({ startedAt: 1 });
      if (shifts.length === 0) return { cashiers: [] };

      const cashierIds = [...new Set(shifts.map((s) => s.cashier.toString()))];
      const users = await User.find({ _id: { $in: cashierIds } }).select('name');
      const nameById = new Map(users.map((u) => [u._id.toString(), u.name]));

      // Pull every completed sale spanning all the shifts once, then bucket
      // it into shifts in memory — cheaper than one aggregate per shift.
      const earliestStart = shifts.reduce((min, s) => (s.startedAt < min ? s.startedAt : min), shifts[0].startedAt);
      const sales = await Sale.find({
        market: marketId,
        status: 'completed',
        cashier: { $in: cashierIds },
        completedAt: { $gte: earliestStart },
      }).select('cashier total completedAt');

      const byCashier = new Map();
      for (const shift of shifts) {
        const end = shift.endedAt || new Date();
        const shiftSales = sales.filter(
          (s) =>
            s.cashier.toString() === shift.cashier.toString() &&
            s.completedAt >= shift.startedAt &&
            s.completedAt <= end
        );
        const revenue = shiftSales.reduce((sum, s) => sum + s.total, 0);
        const cashierName = nameById.get(shift.cashier.toString()) || "Noma'lum";

        const agg = byCashier.get(shift.cashier.toString()) || {
          cashierName,
          totalRevenue: 0,
          totalTransactions: 0,
          shiftsCount: 0,
          shifts: [],
        };
        agg.totalRevenue += revenue;
        agg.totalTransactions += shiftSales.length;
        agg.shiftsCount += 1;
        agg.shifts.push({
          startedAt: shift.startedAt.toISOString(),
          endedAt: shift.endedAt ? shift.endedAt.toISOString() : null,
          status: shift.status,
          revenue,
          transactions: shiftSales.length,
        });
        byCashier.set(shift.cashier.toString(), agg);
      }

      return { cashiers: Array.from(byCashier.values()).sort((a, b) => b.totalRevenue - a.totalRevenue) };
    }

    default:
      return { error: `Noma'lum funksiya: ${name}` };
  }
}

module.exports = { TOOLS, executeTool };
