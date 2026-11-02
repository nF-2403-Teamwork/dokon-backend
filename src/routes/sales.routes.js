const express = require('express');
const { verifyToken, requireRole, loadMarket, requirePermission } = require('../middleware/auth.middleware');
const { listMine, listHistory, create, getOne, updateItems, complete, cancel, returnItems } = require('../controllers/sales.controller');

const router = express.Router();

router.use(verifyToken, requireRole('owner', 'cashier'), loadMarket());

router.get('/mine', listMine);
router.get('/history', requirePermission('sales-history'), listHistory);
router.post('/', create);
router.get('/:id', getOne);
router.put('/:id/items', updateItems);
router.post('/:id/complete', complete);
router.post('/:id/return', requirePermission('sales-history', 'nasiya'), returnItems);
router.delete('/:id', cancel);

module.exports = router;
