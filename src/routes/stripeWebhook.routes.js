const express = require('express');
const { stripeWebhook } = require('../controllers/stripeWebhook.controller');

const router = express.Router();
router.post('/webhook', express.raw({ type: 'application/json' }), stripeWebhook);
module.exports = router;
