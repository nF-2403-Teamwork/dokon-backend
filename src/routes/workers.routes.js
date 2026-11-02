const express = require('express');
const { verifyToken, requireRole, loadMarket } = require('../middleware/auth.middleware');
const { list, create, update, resetPassword } = require('../controllers/workers.controller');

const router = express.Router();

router.use(verifyToken, requireRole('owner'), loadMarket());

router.get('/', list);
router.post('/', create);
router.put('/:id', update);
router.put('/:id/password', resetPassword);

module.exports = router;
