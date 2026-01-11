const express = require('express');

const router = express.Router();

/**
 * @openapi
 * /api/health:
 *   get:
 *     tags:
 *       - Health
 *     summary: Health check
 *     responses:
 *       200:
 *         description: Service is healthy
 *         content:
 *           application/json:
 *             examples:
 *               success:
 *                 value:
 *                   success: true
 *                   status: OK
 *                   environment: development
 *                   timestamp: "2026-01-01T00:00:00.000Z"
 */
router.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'OK',
    environment: process.env.NODE_ENV,
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
