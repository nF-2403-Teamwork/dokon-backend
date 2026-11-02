const mongoose = require('mongoose');

// A repayment made against a Debtor's balance — kept as its own append-only
// record (rather than just decrementing Debtor.balance) so the Nasiya page
// can show a full payment history, not just the current total.
const debtPaymentSchema = new mongoose.Schema({
  market: { type: mongoose.Schema.Types.ObjectId, ref: 'Market', required: true },
  debtor: { type: mongoose.Schema.Types.ObjectId, ref: 'Debtor', required: true },
  amount: { type: Number, required: true },
  note: { type: String, trim: true },
  recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now },
});

debtPaymentSchema.index({ market: 1, debtor: 1, createdAt: -1 });

module.exports = mongoose.model('DebtPayment', debtPaymentSchema);
