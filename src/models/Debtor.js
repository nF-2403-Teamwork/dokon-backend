const mongoose = require('mongoose');

// A person a market sells to on credit ("nasiya"). `balance` is the amount
// currently owed — maintained via $inc (Sale.complete increases it, a
// DebtPayment decreases it), mirroring how Product.stock is kept in sync
// rather than recomputed from history on every read.
const debtorSchema = new mongoose.Schema({
  market: { type: mongoose.Schema.Types.ObjectId, ref: 'Market', required: true },
  name: { type: String, required: true, trim: true },
  phone: { type: String, trim: true },
  note: { type: String, trim: true },
  balance: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now },
});

debtorSchema.index({ market: 1, active: 1, name: 1 });

module.exports = mongoose.model('Debtor', debtorSchema);
