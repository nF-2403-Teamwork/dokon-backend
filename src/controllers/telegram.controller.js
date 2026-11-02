const User = require('../models/User');
const { getBotUsername, isEnabled } = require('../services/telegram');

async function status(req, res) {
  const user = await User.findById(req.user.id).select('telegramChatId');
  res.json({
    connected: !!user?.telegramChatId,
    botUsername: isEnabled() ? getBotUsername() : null,
  });
}

async function disconnect(req, res) {
  await User.findByIdAndUpdate(req.user.id, { $unset: { telegramChatId: '' } });
  res.json({ connected: false });
}

module.exports = { status, disconnect };
