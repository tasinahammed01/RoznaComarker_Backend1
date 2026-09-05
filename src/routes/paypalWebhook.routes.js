'use strict';
const express = require('express');
const { paypalWebhook } = require('../controllers/paypalWebhook.controller');
const router = express.Router();
router.post('/', express.raw({ type: 'application/json', limit: '1mb' }), paypalWebhook);
module.exports = router;
