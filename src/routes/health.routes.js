const crypto = require('crypto');
const express = require('express');
const { runtimeContractFingerprint } = require('../services/runtimeContractFingerprint.service');

const router = express.Router();

// The detail (prompt and model versions, contract hash, deployment revision) is for the deploy check, not for anyone who can reach the URL.
// It is returned only to a request that carries X-Deploy-Token equal to HEALTH_DETAIL_TOKEN. Unset, empty or shorter than MIN_TOKEN_LENGTH
// (a guessable token is no token): never. Both sides are hashed first, so the compare is constant-time whatever their lengths.
const MIN_TOKEN_LENGTH = 16;
const digest = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest();

function detailAllowed(req) {
  const expected = process.env.HEALTH_DETAIL_TOKEN;
  if (typeof expected !== 'string' || expected.length < MIN_TOKEN_LENGTH) return false;
  const given = req.get('x-deploy-token');
  if (typeof given !== 'string' || !given) return false;
  return crypto.timingSafeEqual(digest(expected), digest(given));
}

/**
 * @openapi
 * /api/health:
 *   get:
 *     tags:
 *       - Health
 *     summary: Health check
 *     description: Public answer is the status only. The runtime contract is returned only with the X-Deploy-Token header (HEALTH_DETAIL_TOKEN).
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
 */
router.get('/health', (req, res) => {
  const body = { success: true, status: 'OK' };
  if (detailAllowed(req)) {
    body.environment = process.env.NODE_ENV;
    body.timestamp = new Date().toISOString();
    body.runtime = runtimeContractFingerprint();
  }
  res.json(body);
});

module.exports = router;
module.exports.MIN_TOKEN_LENGTH = MIN_TOKEN_LENGTH;
