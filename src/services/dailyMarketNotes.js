const cron = require('node-cron');
const Groq = require('groq-sdk');
const Market = require('../models/Market');
const MarketNote = require('../models/MarketNote');
const { TOOLS, executeTool } = require('./aiTools');
const { runToolLoop } = require('../controllers/ai.controller');

function buildAdminNotePrompt(marketName, today) {
  return `Siz "${marketName}" do'koni uchun superadmin panelidagi kuzatuv yordamchisiz. Bugungi sana: ${today}.

Vazifa: ushbu do'kon holati haqida superadmin uchun 2-3 qisqa gapdan iborat holat eslatmasi yozing.

Qat'iy qoidalar:
1. Avval mos vositalarni chaqirib haqiqiy raqamlarni oling: so'nggi savdo statistikasi, kam qolgan yoki tugagan mahsulotlar.
2. Faqat muhim narsalarni ayting: savdo yaxshi yoki yomonligi, muammo bo'lsa (masalan savdo umuman yo'q yoki ombor deyarli bo'sh) ochiq ayting.
3. Pul miqdorlarini "so'm" bilan va minglik ajratgich bilan yozing (masalan: 591 000 so'm).
4. O'zbek tilida, qisqa va aniq yozing — ro'yxat emas, bog'langan matn.`;
}

// Runs for every active market regardless of plan — this is oversight for
// the platform owner (superadmin), not a tenant-facing paid feature, so it
// isn't gated by Pro like the owner's own daily briefing (ai.controller.js).
function scheduleDailyMarketNotes() {
  cron.schedule(
    '30 7 * * *',
    async () => {
      if (!process.env.GROQ_API_KEY) return;

      const markets = await Market.find({ active: true }).select('_id name');
      const today = new Date().toISOString().slice(0, 10);

      for (const market of markets) {
        try {
          const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
          const chatMessages = [
            { role: 'system', content: buildAdminNotePrompt(market.name, today) },
            { role: 'user', content: 'Bugungi holat eslatmasini tayyorlang.' },
          ];
          const text = await runToolLoop(groq, chatMessages, market._id, {
            tools: TOOLS,
            executeToolFn: executeTool,
          });
          if (text) {
            await MarketNote.create({ market: market._id, type: 'daily', text });
          }
        } catch (err) {
          console.error('Daily market note error', market._id.toString(), err);
        }
      }
    },
    { timezone: 'Asia/Tashkent' }
  );
}

module.exports = { scheduleDailyMarketNotes };
