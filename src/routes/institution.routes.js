const express = require('express');
const { body } = require('express-validator');
const controller = require('../controllers/institution.controller');
const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');
const { requireRole } = require('../middlewares/role.middleware');
const { handleValidationResult } = require('../middlewares/validation.middleware');
const router = express.Router();
router.get('/me', verifyJwtToken, requireRole('teacher'), controller.me);
router.get('/me/dashboard', verifyJwtToken, requireRole('teacher'), controller.dashboard);
router.post('/me/invites', verifyJwtToken, requireRole('teacher'), body('email').isEmail().normalizeEmail(),
  body('role').optional().isIn(['INSTITUTION_ADMIN', 'TEACHER']), handleValidationResult, controller.invite);
router.post('/invites/:token/accept', verifyJwtToken, requireRole('teacher'), controller.accept);
router.patch('/me/members/:memberId', verifyJwtToken, requireRole('teacher'),
  body('role').optional().isIn(['INSTITUTION_ADMIN', 'TEACHER']), body('monthlyCreditLimit').optional({ nullable: true }).isInt({ min: 0 }),
  handleValidationResult, controller.updateMember);
router.delete('/me/members/:memberId', verifyJwtToken, requireRole('teacher'), controller.remove);
router.post('/provision', verifyJwtToken, requireRole('admin'), body('name').isString().trim().notEmpty(),
  body('ownerUserId').isMongoId(), body('seatLimit').optional().isInt({ min: 1 }), body('monthlyCredits').isInt({ min: 0 }),
  body('status').optional().isIn(['ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELED']),
  body('cycleStart').optional().isISO8601(), body('cycleEnd').optional().isISO8601(), handleValidationResult, controller.provision);
module.exports = router;
