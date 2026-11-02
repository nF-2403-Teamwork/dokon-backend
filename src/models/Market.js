const mongoose = require('mongoose');

const marketSchema = new mongoose.Schema({
  name: { type: String, required: true },
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
  active: { type: Boolean, default: true },
  plan: { type: String, enum: ['starter', 'pro'], default: 'starter' },
  subscriptionExpiresAt: { type: Date, required: true },
  // Sequential counter backing products.controller.js's generateBarcode() —
  // each call atomically increments this and formats the new value as the
  // barcode, so generated codes are 1, 2, 3... per market rather than
  // random, and can never collide with an earlier generated code.
  barcodeSeq: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Market', marketSchema);
