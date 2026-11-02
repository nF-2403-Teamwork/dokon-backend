const mongoose = require('mongoose');

// Records that a given market's periodic Telegram push (morning briefing
// or monthly export) already went out for a given
// period — the dedup key that makes catch-up-on-boot safe. Without this, a
// restart at 08:05 (after a missed cron tick) and the normal 08:00 cron on a
// later, uninterrupted day would have no way to tell "already sent" from
// "not yet due", and a restart could resend the same period's report twice.
// `date` holds a YYYY-MM-DD day key for 'briefing', or a
// YYYY-MM month key for 'monthly-report' — the two never collide since
// `type` always disambiguates which convention applies.
const telegramDailyLogSchema = new mongoose.Schema({
  market: { type: mongoose.Schema.Types.ObjectId, ref: 'Market', required: true },
  type: { type: String, enum: ['briefing', 'monthly-report'], required: true },
  date: { type: String, required: true },
  sentAt: { type: Date, default: Date.now },
});

telegramDailyLogSchema.index({ market: 1, type: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('TelegramDailyLog', telegramDailyLogSchema);
