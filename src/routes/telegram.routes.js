const express = require('express');
const { verifyToken, requireRole, loadMarket, requirePlan } = require('../middleware/auth.middleware');
const { status, disconnect } = require('../controllers/telegram.controller');

const router = express.Router();

// Telegram bot is a Pro-plan feature, same gating pattern as ai.routes.js.
router.use(verifyToken, requireRole('owner'), loadMarket(), requirePlan('pro'));

router.get('/status', status);
router.post('/disconnect', disconnect);

module.exports = router;
