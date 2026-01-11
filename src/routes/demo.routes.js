const express = require('express');

const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');
const { requireRole } = require('../middlewares/role.middleware');

const router = express.Router();

/**
 * @openapi
 * tags:
 *   - name: Demo
 *     description: Demo RBAC-protected routes
 */

/**
 * @openapi
 * /api/demo/teacher:
 *   get:
 *     tags:
 *       - Demo
 *     summary: Teacher-only demo endpoint
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Teacher access granted
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */
router.get('/teacher', verifyJwtToken, requireRole('teacher'), (req, res) => {
  return res.json({
    success: true,
    message: 'Teacher access granted'
  });
});

/**
 * @openapi
 * /api/demo/student:
 *   get:
 *     tags:
 *       - Demo
 *     summary: Student-only demo endpoint
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Student access granted
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */
router.get('/student', verifyJwtToken, requireRole('student'), (req, res) => {
  return res.json({
    success: true,
    message: 'Student access granted'
  });
});

/**
 * @openapi
 * /api/demo/shared:
 *   get:
 *     tags:
 *       - Demo
 *     summary: Shared demo endpoint (Teacher or Student)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Shared access granted
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */
router.get(
  '/shared',
  verifyJwtToken,
  requireRole(['teacher', 'student']),
  (req, res) => {
    return res.json({
      success: true,
      message: 'Shared access granted'
    });
  }
);

module.exports = router;
