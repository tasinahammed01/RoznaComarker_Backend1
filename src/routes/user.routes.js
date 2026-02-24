const express = require('express');

const userController = require('../controllers/user.controller');
const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');

const {
  upload,
  setUploadType,
  handleUploadError,
  validateUploadedFileSignature
} = require('../middlewares/upload.middleware');

const { param, body } = require('express-validator');
const { handleValidationResult } = require('../middlewares/validation.middleware');

const router = express.Router();

/**
 * @openapi
 * tags:
 *   - name: Users
 *     description: User lookup and admin actions
 */

// TEMP route (development only)
/**
 * @openapi
 * /api/users/mock-sync:
 *   post:
 *     tags:
 *       - Users
 *     summary: Create or get a user (Development helper)
 *     description: |
 *       Development helper to create/get a user document without Firebase.
 *       Not protected by JWT in current backend.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - firebaseUid
 *               - email
 *             properties:
 *               firebaseUid:
 *                 type: string
 *                 example: "firebase-uid-123"
 *               email:
 *                 type: string
 *                 example: "user@example.com"
 *               displayName:
 *                 type: string
 *                 nullable: true
 *               photoURL:
 *                 type: string
 *                 nullable: true
 *     responses:
 *       200:
 *         description: User document
 *       400:
 *         description: Validation error
 *       409:
 *         description: User already exists
 */
router.post(
  '/mock-sync',
  body('firebaseUid').isString().trim().notEmpty().withMessage('firebaseUid is required'),
  body('email').isString().trim().notEmpty().withMessage('email is required'),
  body('displayName').optional({ nullable: true }).isString(),
  body('photoURL').optional({ nullable: true }).isString(),
  handleValidationResult,
  userController.createOrGetUser
);

/**
 * @openapi
 * /api/users/firebase/{firebaseUid}:
 *   get:
 *     tags:
 *       - Users
 *     summary: Get user by Firebase UID
 *     parameters:
 *       - in: path
 *         name: firebaseUid
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: User
 *       400:
 *         description: Validation error
 *       404:
 *         description: User not found
 */
router.get(
  '/firebase/:firebaseUid',
  param('firebaseUid').isString().trim().notEmpty().withMessage('firebaseUid is required'),
  handleValidationResult,
  userController.getUserByFirebaseUid
);

router.get('/me', verifyJwtToken, userController.getMe);

router.patch(
  '/me',
  verifyJwtToken,
  body('displayName').optional({ nullable: true }).isString(),
  body('institution').optional({ nullable: true }).isString(),
  body('bio').optional({ nullable: true }).isString(),
  handleValidationResult,
  userController.updateMe
);

router.post(
  '/me/avatar',
  verifyJwtToken,
  setUploadType('avatars'),
  upload.single('file'),
  handleUploadError,
  validateUploadedFileSignature,
  userController.uploadMyAvatar
);

/**
 * @openapi
 * /api/users/{id}:
 *   get:
 *     tags:
 *       - Users
 *     summary: Get user by id
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: User
 *       400:
 *         description: Validation error
 *       404:
 *         description: User not found
 */
router.get(
  '/:id',
  param('id').isMongoId().withMessage('Invalid user id'),
  handleValidationResult,
  userController.getUserById
);

/**
 * @openapi
 * /api/users/{id}/deactivate:
 *   patch:
 *     tags:
 *       - Users
 *     summary: Deactivate a user
 *     description: Not protected by JWT in current backend.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Updated user
 *       400:
 *         description: Validation error
 *       404:
 *         description: User not found
 */
router.patch(
  '/:id/deactivate',
  param('id').isMongoId().withMessage('Invalid user id'),
  handleValidationResult,
  userController.deactivateUser
);

router.patch(
  '/me/role',
  verifyJwtToken,
  body('role').isString().trim().notEmpty().withMessage('role is required'),
  handleValidationResult,
  userController.setMyRole
);

module.exports = router;
