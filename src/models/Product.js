const mongoose = require('mongoose');
const { UNIT_VALUES } = require('../utils/units');

const productSchema = new mongoose.Schema({
  market: { type: mongoose.Schema.Types.ObjectId, ref: 'Market', required: true },
  barcode: { type: String, required: true },
  // Additional barcodes that also resolve to this same product (e.g. a
  // product restocked under a different manufacturer code, or sold in
  // multiple pack sizes each with their own code). `barcode` above stays the
  // one canonical code used for CSV export/import and the auto-generated
  // sequential-barcode flow; these are purely extra lookup keys — see
  // products.controller.js's getByBarcode and the uniqueness checks in
  // create/update, which treat every value here as equally claimable as the
  // primary `barcode` field.
  // No `default: []` — deliberately left unset when a product has no extra
  // barcodes. See the partialFilterExpression note below for why: the index
  // needs this field truly absent, not present-as-empty-array, to exclude
  // the common "no extra barcodes" case. products.controller.js's create/
  // update/revive paths all omit (or $unset) this key rather than ever
  // writing `[]`.
  // `default: undefined` overrides Mongoose's built-in behavior of defaulting
  // every Array-typed path to `[]` on document construction — without it,
  // *any* new/upserted product (including via bulkWrite upserts, which also
  // hydrate schema defaults) silently got `extraBarcodes: []`, and a second
  // such product in the same market then collided on the index below
  // (confirmed by hand, 2026-10-08: a disposable bulkWrite upsert of two
  // brand-new products reproduced this exact E11000 on the second insert).
  extraBarcodes: { type: [String], default: undefined },
  name: { type: String, required: true },
  price: { type: Number, required: true },
  costPrice: { type: Number },
  stock: { type: Number, required: true, default: 0 },
  // 'dona' = sold/counted as whole pieces (integer quantities only). 'kg'/
  // 'metr' = sold by weight/length — price is per-unit, stock and sale
  // quantities can be fractional (e.g. 0.758 kg, 2.5 metr).
  unit: { type: String, enum: UNIT_VALUES, default: 'dona' },
  active: { type: Boolean, default: true },
}, { timestamps: true });

productSchema.index({ barcode: 1, market: 1 }, { unique: true });

// Multikey unique index: MongoDB enforces uniqueness per (market, array
// element) pair, so no two products in the same market can share an extra
// barcode value. Doesn't catch a collision against another product's
// *primary* `barcode` field (different field, different index) — that cross-
// field case is checked in the application layer, see products.controller.js.
//
// partialFilterExpression excludes any product with no extra barcodes from
// this index — required, not optional. `sparse: true` does NOT do this for a
// compound index: sparse only excludes a document missing *every* indexed
// field, and `market` is always present, so sparse alone still produced an
// E11000 (confirmed by hand against this collection).
//
// `$exists: true` relies entirely on the application NEVER writing
// `extraBarcodes: []` — only omitting/$unset-ing the key, or setting it to a
// genuinely non-empty array. An empty array would still satisfy `$exists:
// true` (the key is present, just empty) and MongoDB indexes an empty array
// as a single entry with key value `undefined` (documented multikey
// behavior) — so two products in the same market both left with `[]` would
// collide on that shared `undefined` entry. `$ne: []` would be the more
// obviously-correct filter, but MongoDB's partialFilterExpression validator
// rejects `$ne` outright ("Expression not supported in partial index: $not")
// — confirmed by hand, 2026-10-08, against this exact index. Hence the
// never-write-`[]` discipline in products.controller.js's create/update/
// revive paths instead.
productSchema.index(
  { market: 1, extraBarcodes: 1 },
  { unique: true, partialFilterExpression: { extraBarcodes: { $exists: true } } }
);

// Without these, every Products-page list/search and every low-stock widget
// (ProductsPage, OverviewPage, NotificationBell, the AI tools, dead-stock)
// was a full collection scan across every product of every tenant, sorted
// in memory — which MongoDB caps at 32MB and will hard-error past, not just
// slow down. These cover the two sort orders list() actually uses (by name,
// and by stock for the maxStock/low-stock path) scoped to one market's
// active products.
productSchema.index({ market: 1, active: 1, name: 1 });
productSchema.index({ market: 1, active: 1, stock: 1 });

module.exports = mongoose.model('Product', productSchema);
