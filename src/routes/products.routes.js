const express = require('express');
const { verifyToken, requireRole, loadMarket, requirePermission, requirePlan } = require('../middleware/auth.middleware');
const {
  list,
  searchQuick,
  getByBarcode,
  generateBarcode,
  create,
  update,
  remove,
  bulkImport,
  voiceSearch,
} = require('../controllers/products.controller');

const router = express.Router();

router.use(verifyToken, loadMarket());

// Shared with OverviewPage's low-stock widget, so 'overview' also grants
// this — not just the 'products' permission.
router.get('/', requirePermission('overview', 'products'), list);
// Barcode-generation stays owner-only: BarcodeGeneratorPage isn't in the
// cashier permission set at all (see WorkersPage/App.jsx).
router.get('/generate-barcode', requireRole('owner'), generateBarcode);
router.get('/search', searchQuick);
router.post('/voice-search', requirePlan('pro'), voiceSearch);
router.get('/barcode/:barcode', getByBarcode);
router.post('/', requirePermission('products'), create);
router.post('/import', requirePermission('products'), bulkImport);
router.put('/:id', requirePermission('products'), update);
router.delete('/:id', requirePermission('products'), remove);

module.exports = router;
