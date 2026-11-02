const mongoose = require('mongoose');

const marketNoteSchema = new mongoose.Schema({
  market: { type: mongoose.Schema.Types.ObjectId, ref: 'Market', required: true },
  type: { type: String, enum: ['flag', 'daily'], required: true },
  text: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

marketNoteSchema.index({ market: 1, createdAt: -1 });

module.exports = mongoose.model('MarketNote', marketNoteSchema);
