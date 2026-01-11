const express = require('express');

const { verifyFirebaseToken } = require('../middlewares/firebaseAuth.middleware');
const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');
const { signJwt } = require('../utils/jwt');

const { createSensitiveRateLimiter } = require('../middlewares/rateLimit.middleware');

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
router.post('/login', createSensitiveRateLimiter(), verifyFirebaseToken, async (req, res) => {
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
});

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

module.exports = router;
