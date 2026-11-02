const { Groq, toFile } = require('groq-sdk');
const Product = require('../models/Product');
const Market = require('../models/Market');
const { emitToMarket } = require('../socket');
const { paginationParams } = require('../utils/pagination');
const { escapeRegex } = require('../utils/escapeRegex');
const { buildNameSearchFilter } = require('../utils/nameSearch');
const { bestMatches } = require('../utils/fuzzyMatch');
const { notifyOwners } = require('../services/telegram');
const { formatMoney } = require('../utils/formatMoney');
const { normalizeUnit, unitLabel } = require('../utils/units');

async function list(req, res) {
  const filter = { market: req.user.market, active: true };
  if (req.query.search) {
    Object.assign(filter, buildNameSearchFilter(req.query.search));
  }
  if (req.query.maxStock !== undefined) {
    filter.stock = { $lte: Number(req.query.maxStock) };
  }
  const sort = req.query.maxStock !== undefined ? { stock: 1 } : { name: 1 };
  const { page, limit, skip } = paginationParams(req.query, { defaultLimit: 20, maxLimit: 100 });
  const [products, total] = await Promise.all([
    Product.find(filter).sort(sort).skip(skip).limit(limit),
    Product.countDocuments(filter),
  ]);
  res.json({ products, total, page, limit });
}

// Quick name search for the Kassa autocomplete. Kept permission-free like
// getByBarcode below — a cashier can already pull up any product by typing
// its exact barcode, so letting them find the same product by partial name
// is the same checkout capability, not a new one. costPrice is left out
// since this is a much broader browse surface (partial name vs. an exact
// code the cashier must already know) and margin data has no reason to ride
// along with it.
async function searchQuick(req, res) {
  const q = String(req.query.q || '').trim();
  const nameFilter = buildNameSearchFilter(q);
  if (!nameFilter) return res.json({ products: [] });
  const products = await Product.find({
    market: req.user.market,
    active: true,
    ...nameFilter,
  })
    .select('name price barcode unit stock')
    .sort({ name: 1 })
    .limit(8);
  res.json({ products });
}

async function getByBarcode(req, res) {
  const product = await Product.findOne({
    market: req.user.market,
    active: true,
    $or: [{ barcode: req.params.barcode }, { extraBarcodes: req.params.barcode }],
  });
  if (!product) {
    return res.status(404).json({ message: 'Mahsulot topilmadi' });
  }
  res.json({ product });
}

// 4000000000000 is the start of the GS1 "restricted circulation" EAN-13
// range (prefixes 200-299, here using 400...) reserved for internal/in-store
// use — real manufacturer barcodes never fall in this range, so generated
// codes can never collide with a scanned product's actual barcode.
const GENERATED_BARCODE_BASE = 4000000000000;

async function generateBarcode(req, res) {
  // Sequential (base, base+1, base+2...) rather than random: a random code
  // can — and, per a past incident, did — eventually repeat and collide
  // with an unrelated product added later. An atomic per-market counter can
  // never produce the same code twice, no uniqueness check needed.
  const market = await Market.findByIdAndUpdate(
    req.user.market,
    { $inc: { barcodeSeq: 1 } },
    { new: true }
  );
  // barcodeSeq is post-increment (1 on the first ever call), so subtract 1
  // to make the first generated code exactly the base value. No fixed-width
  // padding — the digit count is whatever this number naturally is.
  const barcode = String(GENERATED_BARCODE_BASE + market.barcodeSeq - 1);
  res.json({ barcode });
}

// Trims/dedupes a submitted extra-barcode list and drops anything that's
// blank or equal to the product's own primary barcode (that'd be a
// pointless duplicate lookup key for the same code).
function sanitizeExtraBarcodes(list, primaryBarcode) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const result = [];
  for (const raw of list) {
    const code = String(raw ?? '').trim();
    if (!code || code === primaryBarcode || seen.has(code)) continue;
    seen.add(code);
    result.push(code);
  }
  return result;
}

async function create(req, res) {
  const { barcode, extraBarcodes, name, price, costPrice, stock, unit } = req.body;
  if (!barcode || !name || price === undefined) {
    return res.status(400).json({ message: 'Shtrix-kod, nomi va narxi kerak' });
  }

  const extras = sanitizeExtraBarcodes(extraBarcodes, barcode);
  const allCodes = [barcode, ...extras];

  // Catches collisions against ANY other active product's primary barcode OR
  // extra barcodes — the model's unique indexes only cover same-field
  // collisions (barcode-vs-barcode via its own index, extraBarcodes-vs-
  // extraBarcodes via its multikey index), not a code submitted here as an
  // extra matching another product's primary field or vice versa.
  const conflict = await Product.findOne({
    market: req.user.market,
    active: true,
    $or: [{ barcode: { $in: allCodes } }, { extraBarcodes: { $in: allCodes } }],
  });
  if (conflict) {
    return res.status(409).json({ message: 'Bu shtrix-kod allaqachon mavjud' });
  }

  const existing = await Product.findOne({ barcode, market: req.user.market });
  if (existing) {
    // Only reachable when `existing` is inactive — an active match on the
    // primary barcode would already have been caught by `conflict` above.
    // remove() now hard-deletes, so this only still matches products that
    // were soft-deleted (active: false) before that change shipped; revive
    // that leftover record with the new details instead of blocking.
    existing.name = name;
    existing.price = price;
    existing.costPrice = costPrice;
    existing.stock = stock || 0;
    existing.unit = normalizeUnit(unit);
    // Never leave this as `[]` — must stay truly absent so the partial
    // unique index on { market, extraBarcodes } excludes it (see Product.js).
    existing.extraBarcodes = extras.length > 0 ? extras : undefined;
    existing.active = true;
    await existing.save();
    emitToMarket(req.user.market, 'stock:changed', [
      { productId: existing._id, stock: existing.stock, name: existing.name, barcode: existing.barcode },
    ]);
    return res.status(201).json({ product: existing });
  }

  const product = await Product.create({
    market: req.user.market,
    barcode,
    // Omitted entirely (not `[]`) when there are no extras — see Product.js.
    ...(extras.length > 0 && { extraBarcodes: extras }),
    name,
    price,
    costPrice,
    stock: stock || 0,
    unit: normalizeUnit(unit),
    active: true,
  });
  emitToMarket(req.user.market, 'stock:changed', [
    { productId: product._id, stock: product.stock, name: product.name, barcode: product.barcode },
  ]);
  res.status(201).json({ product });
}

async function update(req, res) {
  const { barcode, extraBarcodes, name, price, costPrice, stock, active, unit } = req.body;

  const before = await Product.findOne({ _id: req.params.id, market: req.user.market });
  if (!before) {
    return res.status(404).json({ message: 'Mahsulot topilmadi' });
  }

  // Only re-validate uniqueness when the barcode set is actually changing —
  // same reasoning as create()'s `conflict` check, but excluding this
  // product itself from the collision search.
  let extras;
  if (barcode !== undefined || extraBarcodes !== undefined) {
    const effectiveBarcode = barcode !== undefined ? barcode : before.barcode;
    extras = sanitizeExtraBarcodes(
      extraBarcodes !== undefined ? extraBarcodes : before.extraBarcodes,
      effectiveBarcode
    );
    const allCodes = [effectiveBarcode, ...extras];
    const conflict = await Product.findOne({
      market: req.user.market,
      active: true,
      _id: { $ne: req.params.id },
      $or: [{ barcode: { $in: allCodes } }, { extraBarcodes: { $in: allCodes } }],
    });
    if (conflict) {
      return res.status(409).json({ message: 'Bu shtrix-kod allaqachon mavjud' });
    }
  }

  const product = await Product.findOneAndUpdate(
    { _id: req.params.id, market: req.user.market },
    {
      $set: {
        ...(barcode !== undefined && { barcode }),
        // Only $set when non-empty — an empty array must stay truly absent
        // from the document, see Product.js's extraBarcodes index comment.
        ...(extras !== undefined && extras.length > 0 && { extraBarcodes: extras }),
        ...(name !== undefined && { name }),
        ...(price !== undefined && { price }),
        ...(costPrice !== undefined && { costPrice }),
        ...(stock !== undefined && { stock }),
        ...(unit !== undefined && { unit: normalizeUnit(unit) }),
        ...(active !== undefined && { active }),
      },
      ...(extras !== undefined && extras.length === 0 && { $unset: { extraBarcodes: '' } }),
    },
    { new: true, runValidators: true }
  );

  // Manual edit from the Products page — always the owner, since this route
  // is requireRole('owner')-only, but the owner still wants to see it happen.
  if (price !== undefined && price !== before.price) {
    notifyOwners(
      req.user.market,
      `✏️ "${product.name}": narx ${formatMoney(before.price)} → ${formatMoney(price)}`
    ).catch((err) => console.error('Telegram notify error', err));
  }
  if (stock !== undefined && stock !== before.stock) {
    notifyOwners(
      req.user.market,
      `✏️ "${product.name}": qoldiq ${before.stock} → ${stock} ${unitLabel(product.unit)}`
    ).catch((err) => console.error('Telegram notify error', err));
  }

  emitToMarket(req.user.market, 'stock:changed', [
    { productId: product._id, stock: product.stock, name: product.name, barcode: product.barcode },
  ]);
  res.json({ product });
}

async function remove(req, res) {
  const product = await Product.findOneAndDelete({ _id: req.params.id, market: req.user.market });
  if (!product) {
    return res.status(404).json({ message: 'Mahsulot topilmadi' });
  }
  emitToMarket(req.user.market, 'product:removed', { productId: product._id });
  res.json({ product });
}

async function bulkImport(req, res) {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: "Mahsulotlar roʻyxati boʻsh boʻlmasligi kerak" });
  }

  const errors = [];
  const ops = [];

  items.forEach((item, index) => {
    const barcode = String(item.barcode || '').trim();
    const name = String(item.name || '').trim();
    const price = Number(item.price);
    const stock = item.stock !== undefined && item.stock !== '' ? Number(item.stock) : 0;
    // Blank/omitted like 'unit' — don't overwrite an existing product's cost
    // price on re-import when the column is left empty.
    const costPrice =
      item.costPrice !== undefined && item.costPrice !== '' && !Number.isNaN(Number(item.costPrice))
        ? Number(item.costPrice)
        : null;
    // Blank/omitted 'unit' column must NOT overwrite an existing product's
    // unit on re-import — leave it untouched via $setOnInsert instead, so
    // only brand-new rows get the 'dona' default.
    const rawUnit = String(item.unit || '').trim().toLowerCase();
    const unit = rawUnit
      ? ['kg', 'kilo', 'kilogramm'].includes(rawUnit)
        ? 'kg'
        : ['metr', 'm', 'metrlik'].includes(rawUnit)
          ? 'metr'
          : 'dona'
      : null;

    if (!barcode || !name || Number.isNaN(price)) {
      errors.push({ row: index + 1, message: 'Shtrix-kod, nomi va toʻgʻri narx kerak' });
      return;
    }

    const set = { barcode, name, price, stock, market: req.user.market, active: true };
    if (unit) set.unit = unit;
    if (costPrice !== null) set.costPrice = costPrice;

    const update = { $set: set };
    if (!unit) update.$setOnInsert = { unit: 'dona' };

    ops.push({
      updateOne: {
        filter: { barcode, market: req.user.market },
        update,
        upsert: true,
      },
    });
  });

  let result = { matchedCount: 0, upsertedCount: 0 };
  if (ops.length > 0) {
    result = await Product.bulkWrite(ops);
    emitToMarket(req.user.market, 'products:bulk-changed');
  }

  res.json({
    imported: ops.length,
    created: result.upsertedCount || 0,
    updated: result.matchedCount || 0,
    errors,
  });
}

// Pro-only (gated at the route) voice version of searchQuick: a cashier
// speaks a product name instead of typing it. Two layers guard against a
// mangled transcription actually naming the wrong product: (1) the
// market's own catalog is fed to Whisper as a vocabulary hint via `prompt`,
// a standard technique for steering transcription toward domain-specific
// words it wouldn't otherwise guess correctly; (2) even a still-imperfect
// transcript is fuzzy-matched (Levenshtein) against every active product
// name, and only a clear, unambiguous winner is auto-picked — anything
// uncertain comes back as a short list for the cashier to tap instead of
// silently adding the wrong item to a real sale.
async function voiceSearch(req, res) {
  if (!process.env.GROQ_API_KEY) {
    return res.status(503).json({ message: "AI yordamchi sozlanmagan. Administrator bilan bogʻlaning." });
  }

  const { audio, mimeType } = req.body || {};
  if (!audio) {
    return res.status(400).json({ message: 'Audio kerak' });
  }

  const products = await Product.find({ market: req.user.market, active: true }).select(
    'name price barcode unit stock'
  );
  if (products.length === 0) {
    return res.json({ transcript: '', autoPick: false, matches: [] });
  }

  const vocabulary = products
    .map((p) => p.name)
    .join(', ')
    .slice(0, 800);

  let transcript;
  try {
    const file = await toFile(Buffer.from(audio, 'base64'), 'voice.webm', { type: mimeType || 'audio/webm' });
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const result = await groq.audio.transcriptions.create({
      file,
      model: 'whisper-large-v3-turbo',
      language: 'uz',
      prompt: vocabulary,
    });
    transcript = (result.text || '').trim();
  } catch (err) {
    console.error('Voice transcription error', err.message);
    return res.status(502).json({ message: "Ovozni tanib boʻlmadi. Qayta urinib koʻring." });
  }

  if (!transcript) {
    return res.json({ transcript: '', autoPick: false, matches: [] });
  }

  const ranked = bestMatches(transcript, products, { limit: 5 });
  const [top, second] = ranked;
  const autoPick = !!top && top.score >= 0.78 && (!second || top.score - second.score >= 0.12);

  res.json({
    transcript,
    autoPick,
    matches: ranked.filter((r) => r.score >= 0.35).map((r) => ({ product: r.item, score: r.score })),
  });
}

module.exports = { list, searchQuick, getByBarcode, generateBarcode, create, update, remove, bulkImport, voiceSearch };
