const mongoose = require('mongoose');
const { UNIT_VALUES } = require('../utils/units');

const saleItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  barcode: { type: String, required: true },
  name: { type: String, required: true },
  price: { type: Number, required: true },
  quantity: { type: Number, required: true },
  unit: { type: String, enum: UNIT_VALUES, default: 'dona' },
  lineTotal: { type: Number, required: true },
  // How much of `quantity` has been returned so far (see returnItems() in
  // sales.controller.js). `quantity`/`lineTotal` stay at their original
  // sold amounts; a return instead decrements `lineTotal` (and the parent
  // sale's `total`) by the refunded amount so every existing revenue
  // aggregation (analytics, AI tools, exports) reflects the return with no
  // changes of its own — it just sums `total`/`lineTotal` as always.
  returnedQuantity: { type: Number, default: 0 },
}, { _id: false });

const saleSchema = new mongoose.Schema({
  market: { type: mongoose.Schema.Types.ObjectId, ref: 'Market', required: true },
  cashier: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  items: { type: [saleItemSchema], default: [] },
  total: { type: Number, required: true, default: 0 },
  // Cumulative amount refunded across all returns on this sale. `total`
  // above is net (original minus this) — original total is `total +
  // returnedTotal` when needed for display.
  returnedTotal: { type: Number, default: 0 },
  status: { type: String, enum: ['open', 'completed', 'cancelled'], default: 'open' },
  paymentMethod: { type: String, enum: ['cash', 'card', 'online', 'nasiya'], default: 'cash' },
  // Set only when paymentMethod === 'nasiya' — who the sale's total was
  // credited to (see sales.controller.js's complete()).
  debtor: { type: mongoose.Schema.Types.ObjectId, ref: 'Debtor' },
  createdAt: { type: Date, default: Date.now },
  completedAt: { type: Date },
  // Set when a cashier cancels an open ticket. Cancelling is a soft-delete
  // (see sales.controller.js's cancel()) so reports can count how many
  // tickets got cancelled.
  cancelledAt: { type: Date },
});

// Sale had no indexes at all beyond _id — sales history, every analytics
// endpoint, every AI reporting tool, and the
// per-shift revenue breakdown all filter by market (+status, +completedAt
// range, +cashier) and were full-collection-scanning every sale ever made
// by every tenant on every request. These two compound indexes cover that
// family of query shapes; dropping the leading `market` field out of either
// would defeat the whole point, since market is the field every query filters
// on first (see CLAUDE.md's multi-tenancy note).
saleSchema.index({ market: 1, status: 1, completedAt: -1 });
saleSchema.index({ market: 1, cashier: 1, status: 1, completedAt: -1 });

module.exports = mongoose.model('Sale', saleSchema);
