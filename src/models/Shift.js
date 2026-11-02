const mongoose = require('mongoose');

// A cashier's work session, started/ended from CashierPage before they can
// use the till. Deliberately just start/end timestamps, not tied to any
// Sale — ending a shift never touches that cashier's open sale tickets (see
// sales.controller.js), it only blocks new sales until the next shift starts.
const shiftSchema = new mongoose.Schema({
  market: { type: mongoose.Schema.Types.ObjectId, ref: 'Market', required: true },
  cashier: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['open', 'closed'], default: 'open' },
  startedAt: { type: Date, default: Date.now },
  endedAt: { type: Date },
});

// Fast lookup of "does this cashier currently have an open shift" — the
// check every POST /sales makes.
shiftSchema.index({ market: 1, cashier: 1, status: 1 });

module.exports = mongoose.model('Shift', shiftSchema);
