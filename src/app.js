const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const corsOrigins = require('./config/corsOrigins');
const authRoutes = require('./routes/auth.routes');
const workersRoutes = require('./routes/workers.routes');
const productsRoutes = require('./routes/products.routes');
const adminRoutes = require('./routes/admin.routes');
const salesRoutes = require('./routes/sales.routes');
const analyticsRoutes = require('./routes/analytics.routes');
const aiRoutes = require('./routes/ai.routes');
const telegramRoutes = require('./routes/telegram.routes');
const shiftsRoutes = require('./routes/shifts.routes');
const debtorsRoutes = require('./routes/debtors.routes');

const app = express();

app.use(helmet());
app.use(cors({ origin: corsOrigins }));
// Default express.json() limit is 100kb — a few hundred rows of a product
// import already exceeds that, so Express was hard-rejecting (413) before
// bulkImport ever ran. This is an authenticated, internal multi-tenant API
// (not an anonymous public upload surface), so a generous limit here is a
// reasonable trade for not silently capping how large a catalog import or
// bulk edit can be.
app.use(express.json({ limit: '20mb' }));

// Login endpoints are the one publicly-reachable surface that takes a
// password guess — throttle per IP so they can't be brute-forced.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Urinishlar koʻp. Iltimos, birozdan keyin qayta urining." },
});
app.use(['/api/auth/login', '/api/auth/admin-login'], loginLimiter);

// Every AI chat call is a billed Groq request — cap per-IP usage so one
// runaway client can't rack up cost or exhaust the account's rate limit.
const aiLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "AI so'rovlar chegarasiga yetdingiz. Birozdan keyin qayta urining." },
});
app.use('/api/ai', aiLimiter);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/auth', authRoutes);
app.use('/api/workers', workersRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/sales', salesRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/telegram', telegramRoutes);
app.use('/api/shifts', shiftsRoutes);
app.use('/api/debtors', debtorsRoutes);

app.use((req, res) => {
  res.status(404).json({ message: 'Sahifa topilmadi' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ message: err.message || 'Serverda xatolik yuz berdi' });
});

module.exports = app;
