const express = require('express');
const { verifyToken, requireRole, loadMarket, requirePermission } = require('../middleware/auth.middleware');
const { summary, topProducts, daily, deadStock, inventoryValue } = require('../controllers/analytics.controller');

const router = express.Router();

router.use(verifyToken, requireRole('owner', 'cashier'), loadMarket());

// summary/top-products/inventory-value are shared with OverviewPage, so a
// cashier granted only the 'overview' permission (not 'analytics') still
// needs them — otherwise that page breaks for them.
router.get('/summary', requirePermission('overview', 'analytics'), summary);
router.get('/top-products', requirePermission('overview', 'analytics'), topProducts);
router.get('/daily', requirePermission('analytics'), daily);
router.get('/dead-stock', requirePermission('dead-stock'), deadStock);
router.get('/inventory-value', requirePermission('overview', 'analytics'), inventoryValue);

module.exports = router;
