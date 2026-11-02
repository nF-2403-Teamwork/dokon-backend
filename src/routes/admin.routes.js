const express = require('express');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');
const { list, detail, create, renew, update, notes, remove } = require('../controllers/admin.controller');

const router = express.Router();

router.use(verifyToken, requireRole('superadmin'));

router.get('/markets', list);
router.get('/markets/:id', detail);
router.get('/markets/:id/notes', notes);
router.post('/markets', create);
router.put('/markets/:id', update);
router.put('/markets/:id/renew', renew);
router.delete('/markets/:id', remove);

module.exports = router;
