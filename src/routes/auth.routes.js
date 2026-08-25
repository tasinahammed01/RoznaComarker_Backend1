const express = require('express');

const { verifyFirebaseToken } = require('../middlewares/firebaseAuth.middleware');
const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');
const { signJwt } = require('../utils/jwt');
const { issueToken: issueSseToken } = require('../services/sseToken.service');

const {
  createAuthIpRateLimiter,
  createUserRateLimiter
} = require('../middlewares/rateLimit.middleware');

const router = express.Router();

/**
 * @openapi
 * /api/auth/login:
 *   post:
 *     tags:
 *       - Auth
 *     summary: Exchange Firebase ID token for backend JWT
 *     description: |
 *       Send a Firebase ID token in the `Authorization` header. The backend verifies it and returns a signed JWT.
 *       Note: user creation is automatic on first login.
 *     parameters: []
 *     requestBody:
 *       required: false
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: JWT issued
 *         content:
 *           application/json:
 *             examples:
 *               success:
 *                 value:
 *                   success: true
 *                   token: "<jwt>"
 *                   user:
 *                     id: "65a000000000000000000001"
 *                     email: "student@example.com"
 *                     role: "student"
 *       401:
 *         description: Invalid or missing token
 *         content:
 *           application/json:
 *             examples:
 *               missing:
 *                 value:
 *                   success: false
 *                   message: Authorization token missing
 */
router.post(
  '/login',
  createAuthIpRateLimiter({
    windowMs: process.env.LOGIN_IP_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000,
    limit: process.env.LOGIN_IP_RATE_LIMIT_MAX || 60,
    event: 'API_RATE_LIMITED',
    scope: 'auth_login',
    reason: 'too_many_ip_attempts',
    skipSuccessfulRequests: true,
    responseCode: 'AUTH_RATE_LIMITED',
    responseMessage: 'Too many login attempts. Please wait a moment and try again.'
  }),
  verifyFirebaseToken,
  createUserRateLimiter({
    windowMs: process.env.LOGIN_ACCOUNT_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000,
    limit: process.env.LOGIN_ACCOUNT_RATE_LIMIT_MAX || 10,
    event: 'API_RATE_LIMITED',
    scope: 'auth_login',
    reason: 'too_many_account_attempts',
    skipSuccessfulRequests: true,
    responseCode: 'AUTH_RATE_LIMITED',
    responseMessage: 'Too many login attempts. Please wait a moment and try again.'
  }),
  async (req, res) => {
  const token = signJwt(req.user);

  return res.json({
    success: true,
    token,
    user: {
      id: req.user._id,
      email: req.user.email,
      role: req.user.role
    }
  });
  }
);

/**
 * @openapi
 * /api/auth/me:
 *   get:
 *     tags:
 *       - Auth
 *     summary: Get current user from JWT
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Current user
 *         content:
 *           application/json:
 *             examples:
 *               success:
 *                 value:
 *                   success: true
 *                   user:
 *                     id: "65a000000000000000000001"
 *                     email: "student@example.com"
 *                     role: "student"
 *       401:
 *         description: Invalid or missing JWT
 */
router.get('/me', verifyJwtToken, async (req, res) => {
  return res.json({
    success: true,
    user: {
      id: req.user._id,
      email: req.user.email,
      role: req.user.role
    }
  });
});

/**
 * @openapi
 * /api/auth/jwt-test:
 *   get:
 *     tags:
 *       - Auth
 *     summary: Simple JWT-protected route
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Access granted
 *         content:
 *           application/json:
 *             examples:
 *               success:
 *                 value:
 *                   success: true
 *                   message: JWT protected route access granted
 *       401:
 *         description: Invalid or missing JWT
 */
router.get('/jwt-test', verifyJwtToken, async (req, res) => {
  return res.json({
    success: true,
    message: 'JWT protected route access granted'
  });
});

/**
 * @openapi
 * /api/auth/sse-token:
 *   post:
 *     tags:
 *       - Auth
 *     summary: Issue a short-lived one-time token for SSE connections
 *     description: |
 *       Returns a one-time token (60 second TTL, single-use) that can be passed
 *       as the `?token=` query parameter when opening an EventSource. This avoids
 *       sending the long-lived JWT in URLs.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: One-time SSE token
 *       401:
 *         description: Unauthorized
 */
router.post('/sse-token', verifyJwtToken, createUserRateLimiter({
  windowMs: process.env.SSE_TOKEN_RATE_LIMIT_WINDOW_MS || 60 * 1000,
  limit: process.env.SSE_TOKEN_RATE_LIMIT_MAX || 12,
  event: 'SSE_RECONNECT_RATE_LIMITED',
  reason: 'sse_token_user'
}), async (req, res) => {
  const sseToken = issueSseToken(req.user._id);
  return res.json({
    success: true,
    sseToken,
    expiresInSeconds: 60
  });
});

module.exports = router;
