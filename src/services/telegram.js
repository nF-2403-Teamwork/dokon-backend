const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Market = require('../models/Market');
const Product = require('../models/Product');
const Sale = require('../models/Sale');
const TelegramDailyLog = require('../models/TelegramDailyLog');
const Groq = require('groq-sdk');
const { getOrCreateBriefing, runToolLoop } = require('../controllers/ai.controller');
const { buildMarketingTools, executeMarketingTool, buildMarketingSystemPrompt } = require('./marketingAiTools');
const { formatMoney } = require('../utils/formatMoney');
const { unitLabel } = require('../utils/units');
const { buildXlsxBuffer } = require('../utils/xlsxBuffer');

const PAYMENT_LABELS_UZ = { cash: 'Naqd', card: 'Karta', online: 'Onlayn' };

let bot = null;
let botUsername = null;

// In-memory per-chat login state for the /start flow (slug -> username ->
// password). Lost on restart, which just means an in-progress login has to
// be redone with /start — no data at risk since nothing is persisted until
// the final step succeeds.
const loginSessions = new Map();

const KEYBOARD = {
  reply_markup: {
    keyboard: [['📊 Bugungi hisobot', '🔥 Top mahsulotlar'], ['📦 Kam qolgan mahsulotlar']],
    resize_keyboard: true,
  },
};

const UPGRADE_MESSAGE =
  "Bu bot faqat Pro rejadagi do'konlar uchun mavjud. Davom etish uchun Pro rejaga o'ting.";

// Telegram bot is a Pro-plan feature (same gate as telegram.routes.js), but
// a plan downgrade only takes effect at the HTTP layer via loadMarket() —
// an already-linked chat has no per-request middleware, so every entry
// point below (notifyOwners, /start, and the general message handler) has
// to re-check this itself instead of trusting telegramChatId being set.
function isMarketPro(market) {
  return !!market && market.plan === 'pro' && market.active && market.subscriptionExpiresAt >= new Date();
}

// No-ops silently when the bot isn't configured, so controllers never need
// to check whether Telegram is enabled on this deployment before calling in.
async function notifyOwners(marketId, text) {
  if (!bot) return;
  const market = await Market.findById(marketId).select('plan active subscriptionExpiresAt');
  if (!isMarketPro(market)) return;

  const owners = await User.find({ market: marketId, role: 'owner', telegramChatId: { $exists: true, $ne: null } });
  await Promise.all(
    owners.map((owner) =>
      bot.sendMessage(owner.telegramChatId, text).catch((err) => console.error('Telegram sendMessage error', err.message))
    )
  );
}

// Independent of notifyOwners()'s per-owner /start linking flow — sends to
// one fixed chat (TELEGRAM_OWNER_CHAT_ID, set per-deployment) regardless of
// Pro plan or whether any owner has linked their account. Used for shift
// start/end pings.
async function notifyOwnerChat(text) {
  if (!bot) return;
  const chatId = process.env.TELEGRAM_OWNER_CHAT_ID;
  if (!chatId) return;
  await bot.sendMessage(chatId, text).catch((err) => console.error('Telegram notifyOwnerChat error', err.message));
}

async function handleStart(msg) {
  const chatId = msg.chat.id;

  const existing = await User.findOne({ telegramChatId: String(chatId) }).populate(
    'market',
    'name plan active subscriptionExpiresAt'
  );
  if (existing) {
    if (!isMarketPro(existing.market)) {
      existing.telegramChatId = undefined;
      await existing.save();
      await bot.sendMessage(chatId, UPGRADE_MESSAGE, { reply_markup: { remove_keyboard: true } });
      return;
    }
    await bot.sendMessage(chatId, 'Siz allaqachon ulangansiz.', KEYBOARD);
    return;
  }

  loginSessions.set(chatId, { step: 'slug' });
  await bot.sendMessage(chatId, "Xush kelibsiz! Do'koningiz kodini (slug) yuboring.");
}

async function handleStop(msg) {
  const chatId = msg.chat.id;
  loginSessions.delete(chatId);
  marketingChatHistory.delete(chatId);
  const owner = await User.findOne({ telegramChatId: String(chatId) });
  if (owner) {
    owner.telegramChatId = undefined;
    await owner.save();
  }
  await bot.sendMessage(chatId, 'Bot uzildi. Qayta ulash uchun /start yuboring.', {
    reply_markup: { remove_keyboard: true },
  });
}

// Mirrors auth.controller.js's tenant login checks (market by slug, active +
// subscription, then user by username/password) since this is the same
// login, just carried over chat messages instead of one HTTP request —
// plus the role check that HTTP login has no need for, since only owners
// get the bot.
async function handleLoginStep(msg) {
  const chatId = msg.chat.id;
  const session = loginSessions.get(chatId);
  if (!session) return false;

  const text = (msg.text || '').trim();
  if (!text) return true;

  if (session.step === 'slug') {
    session.slug = text.toLowerCase();
    session.step = 'username';
    await bot.sendMessage(chatId, 'Login (foydalanuvchi nomi)ni yuboring.');
    return true;
  }

  if (session.step === 'username') {
    session.username = text;
    session.step = 'password';
    await bot.sendMessage(chatId, 'Parolni yuboring.');
    return true;
  }

  // step === 'password' — final step. Delete the message right away so the
  // plaintext password doesn't linger in the chat history.
  loginSessions.delete(chatId);
  bot.deleteMessage(chatId, msg.message_id).catch(() => {});

  const market = await Market.findOne({ slug: session.slug });
  if (!market || !market.active || market.subscriptionExpiresAt < new Date()) {
    await bot.sendMessage(chatId, "❌ Do'kon topilmadi yoki obuna muddati tugagan. Qaytadan urinish uchun /start yuboring.");
    return true;
  }
  if (market.plan !== 'pro') {
    await bot.sendMessage(chatId, UPGRADE_MESSAGE);
    return true;
  }

  const user = await User.findOne({ market: market._id, username: session.username, active: true });
  const passwordMatches = user && (await bcrypt.compare(text, user.passwordHash));
  if (!passwordMatches) {
    await bot.sendMessage(chatId, "❌ Login yoki parol noto'g'ri. Qaytadan urinish uchun /start yuboring.");
    return true;
  }

  if (user.role !== 'owner') {
    await bot.sendMessage(chatId, "❌ Ushbu bot faqat do'kon egalari uchun mavjud. Kassir hisoblari ulana olmaydi.");
    return true;
  }

  user.telegramChatId = String(chatId);
  await user.save();
  await bot.sendMessage(
    chatId,
    `✅ Ulandi! Endi "${market.name}" do'koni uchun bildirishnomalar shu yerga keladi.`,
    KEYBOARD
  );
  return true;
}

async function handleBriefing(chatId, marketId) {
  const result = await getOrCreateBriefing(marketId);
  await bot.sendMessage(chatId, result.error || result.text, KEYBOARD);
}

async function handleTopProducts(chatId, marketId) {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const rows = await Sale.aggregate([
    { $match: { market: marketId, status: 'completed', completedAt: { $gte: startOfDay } } },
    { $unwind: '$items' },
    {
      $group: {
        _id: '$items.product',
        name: { $first: '$items.name' },
        unit: { $first: '$items.unit' },
        quantity: { $sum: '$items.quantity' },
        revenue: { $sum: '$items.lineTotal' },
      },
    },
    { $sort: { revenue: -1 } },
    { $limit: 5 },
  ]);

  if (rows.length === 0) {
    await bot.sendMessage(chatId, "Bugun hali savdo bo'lmagan.", KEYBOARD);
    return;
  }
  const lines = rows.map(
    (r, i) => `${i + 1}. ${r.name} — ${r.quantity} ${unitLabel(r.unit)}, ${formatMoney(r.revenue)}`
  );
  await bot.sendMessage(chatId, `🔥 Bugungi top mahsulotlar:\n\n${lines.join('\n')}`, KEYBOARD);
}

async function handleLowStock(chatId, marketId) {
  const products = await Product.find({ market: marketId, active: true, stock: { $lte: 5 } })
    .sort({ stock: 1 })
    .limit(10);

  if (products.length === 0) {
    await bot.sendMessage(chatId, "Kam qolgan mahsulot yo'q. 👍", KEYBOARD);
    return;
  }
  const lines = products.map((p) => `• ${p.name} — ${p.stock} ${unitLabel(p.unit)}`);
  await bot.sendMessage(chatId, `📦 Kam qolgan mahsulotlar:\n\n${lines.join('\n')}`, KEYBOARD);
}

// In-memory per-chat scrollback for handleMarketingChat, so a follow-up
// question ("u haqida ko'proq ayt" / "nega?") isn't answered cold — each
// question/answer pair is treated independently otherwise, which reads as
// the bot "forgetting" what was just discussed. Capped at the last few turns
// (not just MAX_HISTORY_MESSAGES-style trimming at request time) to bound
// memory for a long-running process serving many chats; cleared on /stop
// alongside the rest of that chat's state.
const MARKETING_CHAT_HISTORY_TURNS = 6;
const marketingChatHistory = new Map();

// Anything typed that isn't a login step or a keyboard button — free-text
// marketing/business questions, answered by the same tool-calling loop the
// dashboard AI assistant uses (ai.controller.js's runToolLoop), but with the
// marketing-scoped tool set (sales/stock tools + flag_question) and system
// prompt from marketingAiTools.js.
async function handleMarketingChat(chatId, marketId, marketName, question) {
  if (!process.env.GROQ_API_KEY) {
    await bot.sendMessage(chatId, "AI yordamchi sozlanmagan.", KEYBOARD);
    return;
  }

  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const history = marketingChatHistory.get(chatId) || [];
  const chatMessages = [
    { role: 'system', content: buildMarketingSystemPrompt(marketName) },
    ...history,
    { role: 'user', content: question },
  ];

  try {
    const text = await runToolLoop(groq, chatMessages, marketId, {
      tools: buildMarketingTools(),
      executeToolFn: executeMarketingTool,
      context: { question },
    });
    await bot.sendMessage(chatId, text || "Kechirasiz, javob topilmadi.", KEYBOARD);

    if (text) {
      const nextHistory = [...history, { role: 'user', content: question }, { role: 'assistant', content: text }];
      marketingChatHistory.set(chatId, nextHistory.slice(-MARKETING_CHAT_HISTORY_TURNS * 2));
    }
  } catch (err) {
    console.error('Telegram marketing chat error', err);
    await bot.sendMessage(chatId, "AI xizmati bilan bog'lanishda xatolik yuz berdi.", KEYBOARD);
  }
}

function registerHandlers() {
  bot.onText(/^\/start$/, (msg) => {
    handleStart(msg).catch((err) => console.error('Telegram /start error', err));
  });

  bot.onText(/^\/stop$/, (msg) => {
    handleStop(msg).catch((err) => console.error('Telegram /stop error', err));
  });

  bot.on('message', (msg) => {
    const text = (msg.text || '').trim();
    if (!text || text.startsWith('/')) return; // commands are handled by onText above

    handleLoginStep(msg)
      .then((handled) => {
        if (handled) return null;
        return User.findOne({ telegramChatId: String(msg.chat.id) })
          .populate('market', 'name plan active subscriptionExpiresAt')
          .then((owner) => {
            if (!owner) {
              // Not mid-login and not linked to any market — without this the
              // bot just stays silent, which looks broken/unresponsive to
              // anyone who types before sending /start.
              return bot.sendMessage(msg.chat.id, "Ulanish uchun /start yuboring.");
            }
            if (!isMarketPro(owner.market)) {
              owner.telegramChatId = undefined;
              return owner
                .save()
                .then(() => bot.sendMessage(msg.chat.id, UPGRADE_MESSAGE, { reply_markup: { remove_keyboard: true } }));
            }
            const marketId = owner.market._id;
            if (text === '📊 Bugungi hisobot') return handleBriefing(msg.chat.id, marketId);
            if (text === '🔥 Top mahsulotlar') return handleTopProducts(msg.chat.id, marketId);
            if (text === '📦 Kam qolgan mahsulotlar') return handleLowStock(msg.chat.id, marketId);
            return handleMarketingChat(msg.chat.id, marketId, owner.market.name, text);
          });
      })
      .catch((err) => console.error('Telegram message handler error', err));
  });

  bot.on('polling_error', (err) => console.error('Telegram polling error', err.message));
}

// node-cron only fires a tick if the process happens to be alive at that
// exact minute — a redeploy/restart around 08:00 silently drops that day's
// push with no retry. TelegramDailyLog is the dedup record that makes it
// safe to also attempt these sends from catchUpMissedDailyReports() on boot:
// "already logged for today" means the cron tick (or an earlier catch-up)
// already got it out, so a second attempt is a no-op instead of a duplicate.
function todayUtcDateKey() {
  return new Date().toISOString().slice(0, 10);
}

async function alreadySent(marketId, type, dateKey) {
  const existing = await TelegramDailyLog.findOne({ market: marketId, type, date: dateKey });
  return !!existing;
}

async function markSent(marketId, type, dateKey) {
  try {
    await TelegramDailyLog.create({ market: marketId, type, date: dateKey });
  } catch (err) {
    // Unique-index race (cron tick and a catch-up call landing at the same
    // moment) — the message already went out either way, nothing to do.
    if (err.code !== 11000) throw err;
  }
}

async function alreadySentToday(marketId, type) {
  return alreadySent(marketId, type, todayUtcDateKey());
}

async function markSentToday(marketId, type) {
  return markSent(marketId, type, todayUtcDateKey());
}

async function runMorningBriefingForMarket(marketId) {
  if (await alreadySentToday(marketId, 'briefing')) return;
  const result = await getOrCreateBriefing(marketId);
  if (result.error) return;
  await notifyOwners(marketId, `📊 Kunlik hisobot:\n\n${result.text}`);
  await markSentToday(marketId, 'briefing');
}

// Pushed only to Pro markets — matches the Pro-only gate on GET
// /api/ai/briefing (requirePlan('pro') in ai.routes.js).
function scheduleBriefingJob() {
  cron.schedule(
    '0 8 * * *',
    async () => {
      const markets = await Market.find({ plan: 'pro', active: true }).select('_id');
      for (const market of markets) {
        try {
          await runMorningBriefingForMarket(market._id);
        } catch (err) {
          console.error('Telegram daily briefing job error', err);
        }
      }
    },
    { timezone: 'Asia/Tashkent' }
  );
}

// Exact-day thresholds (not "<= N days") so each market gets one reminder
// per threshold instead of a daily message throughout the whole window.
function scheduleSubscriptionReminderJob() {
  const THRESHOLDS = new Set([7, 3, 1, 0]);
  cron.schedule(
    '0 9 * * *',
    async () => {
      const markets = await Market.find({ active: true });
      const now = new Date();
      for (const market of markets) {
        const daysLeft = Math.ceil((market.subscriptionExpiresAt - now) / (1000 * 60 * 60 * 24));
        if (!THRESHOLDS.has(daysLeft)) continue;
        const text =
          daysLeft === 0
            ? "⚠️ Obuna muddati bugun tugaydi. Yangilash uchun administrator bilan bog'laning."
            : `⚠️ Obuna muddati ${daysLeft} kundan so'ng tugaydi. Yangilash uchun administrator bilan bog'laning.`;
        try {
          await notifyOwners(market._id, text);
        } catch (err) {
          console.error('Telegram subscription reminder job error', err);
        }
      }
    },
    { timezone: 'Asia/Tashkent' }
  );
}

const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;

// ---- Monthly report: two .xlsx documents (the month's sales history, and
// the product catalog as it stood once that month was over) sent straight
// to every linked owner's chat, once the month they cover has fully ended.

// Like notifyOwners but for a file attachment instead of plain text — same
// Pro-plan gate and "every owner with a linked chat" fan-out.
async function notifyOwnersDocument(marketId, buffer, filename, caption) {
  if (!bot) return;
  const market = await Market.findById(marketId).select('plan active subscriptionExpiresAt');
  if (!isMarketPro(market)) return;

  const owners = await User.find({ market: marketId, role: 'owner', telegramChatId: { $exists: true, $ne: null } });
  await Promise.all(
    owners.map((owner) =>
      bot
        .sendDocument(
          owner.telegramChatId,
          buffer,
          { caption },
          { filename, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
        )
        .catch((err) => console.error('Telegram sendDocument error', err.message))
    )
  );
}

// "The calendar month immediately before the one `now` falls in" — well
// defined at any moment, which is what lets the catch-up path below run
// unconditionally on every boot instead of needing an hour/day gate like
// the daily jobs do: a previous month is, by definition, always already
// fully elapsed, so there's no "not due yet" case to guard against.
function previousTashkentMonthRange() {
  const tashkentNow = new Date(Date.now() + TASHKENT_OFFSET_MS);
  const y = tashkentNow.getUTCFullYear();
  const m = tashkentNow.getUTCMonth();
  const prevMonthFirst = new Date(Date.UTC(y, m - 1, 1));
  const py = prevMonthFirst.getUTCFullYear();
  const pm = prevMonthFirst.getUTCMonth();
  const start = new Date(Date.UTC(py, pm, 1, 0, 0, 0, 0) - TASHKENT_OFFSET_MS);
  // Date.UTC(py, pm + 1, 0, ...) is "day 0 of next month" = the last day of
  // this one, so this stays correct across every month length without a
  // lookup table.
  const end = new Date(Date.UTC(py, pm + 1, 0, 23, 59, 59, 999) - TASHKENT_OFFSET_MS);
  const key = `${py}-${String(pm + 1).padStart(2, '0')}`;
  const label = start.toLocaleDateString('uz-UZ', { timeZone: 'Asia/Tashkent', month: 'long', year: 'numeric' });
  return { key, start, end, label };
}

async function buildMonthlySalesXlsx(marketId, range) {
  const sales = await Sale.find({
    market: marketId,
    status: 'completed',
    completedAt: { $gte: range.start, $lte: range.end },
  })
    .sort({ completedAt: 1 })
    .populate('cashier', 'name')
    .lean();

  return buildXlsxBuffer({
    sheetName: 'Savdolar',
    columns: [
      { header: 'Sana', key: 'date', width: 20 },
      { header: 'Kassir', key: 'cashier', width: 16 },
      { header: "To'lov turi", key: 'payment', width: 14 },
      { header: 'Mahsulotlar tafsiloti', key: 'itemsDetail', width: 50 },
      { header: 'Mahsulotlar soni', key: 'itemCount', width: 14, format: 'number' },
      { header: 'Jami', key: 'total', width: 16, format: 'currency' },
    ],
    rows: sales.map((s) => ({
      date: new Date(s.completedAt).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' }),
      cashier: s.cashier?.name || '—',
      payment: PAYMENT_LABELS_UZ[s.paymentMethod] || s.paymentMethod,
      itemsDetail: s.items.map((it) => `${it.name} x${it.quantity} ${unitLabel(it.unit)}`).join(', '),
      itemCount: s.items.length,
      total: s.total,
    })),
  });
}

async function buildMonthlyProductsXlsx(marketId) {
  const products = await Product.find({ market: marketId, active: true }).sort({ name: 1 }).lean();

  return buildXlsxBuffer({
    sheetName: 'Mahsulotlar',
    columns: [
      { header: 'Shtrix-kod', key: 'barcode', width: 18 },
      { header: 'Nomi', key: 'name', width: 32 },
      { header: 'Narxi', key: 'price', width: 14, format: 'currency' },
      { header: 'Kirish narxi', key: 'costPrice', width: 14, format: 'currency' },
      { header: 'Qoldiq', key: 'stock', width: 12, format: 'number' },
    ],
    rows: products.map((p) => ({
      barcode: p.barcode,
      name: p.name,
      price: p.price,
      costPrice: p.costPrice ?? '',
      stock: p.stock,
    })),
  });
}

async function sendMonthlyReportIfDue(market) {
  const range = previousTashkentMonthRange();
  // Market didn't exist yet during the month being reported on — nothing
  // real to send (e.g. a market created this month would otherwise get an
  // empty "last month" report the moment it's linked).
  if (market.createdAt && market.createdAt > range.end) return;
  if (await alreadySent(market._id, 'monthly-report', range.key)) return;

  const [salesXlsx, productsXlsx] = await Promise.all([
    buildMonthlySalesXlsx(market._id, range),
    buildMonthlyProductsXlsx(market._id),
  ]);

  await notifyOwners(market._id, `📦 ${range.label} uchun oylik hisobot fayllari tayyor:`);
  await notifyOwnersDocument(
    market._id,
    salesXlsx,
    `savdolar-tarixi-${range.key}.xlsx`,
    `${range.label} — savdolar tarixi`
  );
  await notifyOwnersDocument(
    market._id,
    productsXlsx,
    `mahsulotlar-${range.key}.xlsx`,
    `${range.label} oxiridagi mahsulotlar ro'yxati`
  );

  await markSent(market._id, 'monthly-report', range.key);
}

// Every Pro market gets this.
function scheduleMonthlyReportJob() {
  cron.schedule(
    '30 8 1 * *',
    async () => {
      const markets = await Market.find({ plan: 'pro', active: true }).select('_id createdAt');
      for (const market of markets) {
        try {
          await sendMonthlyReportIfDue(market);
        } catch (err) {
          console.error('Telegram monthly report error', market._id.toString(), err);
        }
      }
    },
    { timezone: 'Asia/Tashkent' }
  );
}

// No hour/day gate needed (see previousTashkentMonthRange's comment) — safe
// to run on every boot. The common case (most boots, most days) is one cheap
// findOne per Pro market that finds the month already logged and skips.
async function catchUpMissedMonthlyReports() {
  const markets = await Market.find({ plan: 'pro', active: true }).select('_id createdAt');
  for (const market of markets) {
    try {
      await sendMonthlyReportIfDue(market);
    } catch (err) {
      console.error('Telegram monthly report catch-up error', market._id.toString(), err);
    }
  }
}

// Runs once at boot, after registerHandlers()/the cron schedules are set up.
// If the process starts after 08:00 Tashkent (a redeploy mid-morning, a
// crash-restart, etc.), that day's 08:00 cron tick already silently passed —
// this sends anything still missing for today instead of waiting until
// tomorrow's tick. alreadySentToday() inside each send path makes this safe
// to call unconditionally: a normal boot before 08:00 just finds nothing due
// yet, and a boot right after the cron tick already fired finds it already
// logged and skips.
function currentTashkentHour() {
  return new Date(Date.now() + TASHKENT_OFFSET_MS).getUTCHours();
}

async function catchUpMissedDailyReports() {
  if (currentTashkentHour() < 8) return;

  try {
    const proMarkets = await Market.find({ plan: 'pro', active: true }).select('_id');
    for (const market of proMarkets) {
      try {
        await runMorningBriefingForMarket(market._id);
      } catch (err) {
        console.error('Telegram briefing catch-up error', market._id.toString(), err);
      }
    }
  } catch (err) {
    console.error('Telegram briefing catch-up error', err);
  }
}

// Awaited by server.js before it starts accepting HTTP requests. getMe() is
// what fills in botUsername, and GET /api/telegram/status (SettingsPage's
// "Telegramda ochish" link) reads that value — if the server started
// serving requests while this was still in flight, any owner who opened
// Settings in that window saw "Bot bu serverda hali sozlanmagan" even
// though the bot was in fact configured and running, just not done
// introducing itself yet.
async function initBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log('TELEGRAM_BOT_TOKEN not set — Telegram bot disabled');
    return;
  }

  bot = new TelegramBot(token, { polling: true });
  try {
    const me = await bot.getMe();
    botUsername = me.username;
    console.log(`Telegram bot @${botUsername} started`);
  } catch (err) {
    console.error('Telegram getMe error', err.message);
  }

  registerHandlers();
  scheduleBriefingJob();
  scheduleSubscriptionReminderJob();
  scheduleMonthlyReportJob();

  try {
    await catchUpMissedDailyReports();
  } catch (err) {
    console.error('Telegram catch-up error', err);
  }

  try {
    await catchUpMissedMonthlyReports();
  } catch (err) {
    console.error('Telegram monthly catch-up error', err);
  }
}

function getBotUsername() {
  return botUsername;
}

function isEnabled() {
  return bot !== null;
}

module.exports = { initBot, notifyOwners, notifyOwnerChat, getBotUsername, isEnabled };
