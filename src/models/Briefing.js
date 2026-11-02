const mongoose = require('mongoose');

const briefingSchema = new mongoose.Schema({
  market: { type: mongoose.Schema.Types.ObjectId, ref: 'Market', required: true },
  date: { type: String, required: true }, // YYYY-MM-DD, matches ai.controller's UTC-day convention
  text: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

// One briefing per market per day — also the cache key the controller checks
// before spending a Groq call.
briefingSchema.index({ market: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('Briefing', briefingSchema);
