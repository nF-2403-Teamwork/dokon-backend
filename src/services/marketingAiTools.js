const { TOOLS: BASE_TOOLS, executeTool: executeBaseTool } = require('./aiTools');
const MarketNote = require('../models/MarketNote');

const FLAG_TOOL = {
  type: 'function',
  function: {
    name: 'flag_question',
    description:
      "Savol qonunga zid, firibgarlik yoki axloqiy jihatdan nomaqbul bo'lsa chaqiring. Bu holat superadmin paneliga yoziladi.",
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: "Nima uchun bu savol nomaqbul ekanini qisqa tushuntiring" },
      },
      required: ['reason'],
    },
  },
};

function buildMarketingTools() {
  return [...BASE_TOOLS, FLAG_TOOL];
}

// context = { question } — the original user message, needed so the flag
// note records what was actually asked, not just the model's paraphrase.
async function executeMarketingTool(name, args, marketId, context) {
  if (name === 'flag_question') {
    await MarketNote.create({
      market: marketId,
      type: 'flag',
      text: `Savolga javob berishdan bosh tortildi: "${context?.question || 'nomaʼlum'}". Sabab: ${args.reason}`,
    });
    return { flagged: true };
  }
  return executeBaseTool(name, args, marketId);
}

function buildMarketingSystemPrompt(marketName) {
  return `Siz "${marketName}" do'koni uchun Telegram botidagi marketing va biznes yordamchisiz. Egasi (owner) bilan gaplashyapsiz.

Qat'iy qoidalar:
1. Faqat quyidagi mavzularga javob bering: marketing, reklama, mijozlar bilan ishlash, narxlash strategiyasi, va ushbu do'konning savdo/ombor ma'lumotlari.
2. Oddiy suhbat, hazil, shaxsiy mavzular yoki do'kon/marketingga aloqasi yo'q umumiy bilim savollariga javob bermang — muloyimlik bilan mavzuni marketing yoki do'konga qaytaring.
3. Savol qonunga zid, firibgarlik yoki axloqiy jihatdan nomaqbul bo'lsa — avval flag_question vositasini chaqiring, so'ng muloyim rad javobini bering. Oddiy noaniq yoki mavzudan tashqari savollarni flag qilmang, faqat haqiqatan nomaqbul bo'lganlarini.
4. Savdo, daromad, mahsulot yoki ombor haqida raqam kerak bo'lsa — HAR DOIM mos vositani chaqiring, hech qachon taxmin qilmang.
5. Javoblarni o'zbek tilida, qisqa, tabiiy va aniq yozing. Pul miqdorlarini "so'm" bilan va minglik ajratgich bilan ko'rsating (masalan: 591 000 so'm).`;
}

module.exports = { buildMarketingTools, executeMarketingTool, buildMarketingSystemPrompt };
