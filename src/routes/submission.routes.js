const express = require('express');

const submissionController = require('../controllers/submission.controller');
const { preflightImage, enforceImagePreflight } = require('../middlewares/imagePreflight.middleware');
const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');
const { requireRole } = require('../middlewares/role.middleware');
const {
  upload,
  setUploadType,
  handleUploadError,
  validateUploadedFileSignature
} = require('../middlewares/upload.middleware');

const { param } = require('express-validator');
const { handleValidationResult } = require('../middlewares/validation.middleware');

const { createSensitiveRateLimiter, createUserRateLimiter } = require('../middlewares/rateLimit.middleware');
const { createUserConcurrencyGuard } = require('../middlewares/concurrency.middleware');

const {
  enforceStorageLimitFromUploadedFile
  , enforceStorageLimitFromUploadedFiles
} = require('../middlewares/usage.middleware');

const router = express.Router();
const humanReview=require('../controllers/sourceHumanReview.controller');
const reviewLimiter=createUserRateLimiter({windowMs:60000,limit:40,event:'SOURCE_REVIEW_RATE_LIMITED',reason:'source_human_review'});
router.post('/:submissionId/guest-access/revoke', verifyJwtToken, requireRole('teacher'),
  param('submissionId').isMongoId(), handleValidationResult, require('../controllers/guestSubmission.controller').revoke);
const uploadUserLimiter = createUserRateLimiter({
  windowMs: process.env.UPLOAD_USER_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000,
  limit: process.env.UPLOAD_USER_RATE_LIMIT_MAX || 30,
  event: 'UPLOAD_RATE_LIMITED',
  reason: 'submission_upload_user'
});
// The two-phase preview must still support 20 files. Cheap basic requests have
// their own bounded allowance; paid source checks retain the upload allowance.
const basicPreflightLimiter=createUserRateLimiter({windowMs:process.env.UPLOAD_USER_RATE_LIMIT_WINDOW_MS||15*60*1000,
  limit:process.env.UPLOAD_USER_RATE_LIMIT_MAX||30,event:'UPLOAD_RATE_LIMITED',reason:'image_preflight_basic'});
const noStore = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
};

// Temporary upload: basic checks and opt-in private exact source evidence;
// no persisted File/Submission or assessment credits.
router.post('/image-preflight', verifyJwtToken, requireRole('student'),
  createUserConcurrencyGuard({ operation: 'image_preflight', maxConcurrent: 2 }),
  noStore, setUploadType('submissions'), upload.single('file'), handleUploadError,
  validateUploadedFileSignature,
  (req,res,next)=>{
    let admitted=false;
    res.once('finish',()=>{if(!admitted&&req.file?.path)require('fs/promises').unlink(req.file.path).catch(()=>{});});
    return (req.body?.phase==='basic'?basicPreflightLimiter:uploadUserLimiter)(req,res,()=>{admitted=true;next();});
  },preflightImage);

/**
 * @openapi
 * tags:
 *   - name: Submissions
 *     description: Student submissions for assignments
 */

/**
 * @openapi
 * /api/submissions/qr/{qrToken}:
 *   post:
 *     tags:
 *       - Submissions
 *     summary: Submit using assignment QR token (Student)
 *     description: |
 *       Requires JWT + role `student`.
 *       Upload a file as `multipart/form-data` field `file`.
 *       Enforces storage limit (plan `storageMB`).
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: qrToken
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - file
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Submission created/updated
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden / limit exceeded / deadline passed
 *       404:
 *         description: Invalid QR / assignment not found
 */
router.post(
  '/qr/:qrToken',
  verifyJwtToken,
  requireRole('student'),
  uploadUserLimiter,
  param('qrToken').isString().trim().notEmpty().withMessage('Invalid QR'),
  handleValidationResult,
  setUploadType('submissions'),
  upload.fields([
    { name: 'files', maxCount: 20 },
    { name: 'file', maxCount: 1 }
  ]),
  handleUploadError,
  validateUploadedFileSignature,
  (req, res, next) => {
    const list = Array.isArray(req.files) ? req.files : (req.files && req.files.files ? req.files.files : []);
    const single = req.files && req.files.file ? req.files.file[0] : req.file;
    if (!Array.isArray(req.files)) {
      req.files = [];
      if (Array.isArray(list)) req.files.push(...list);
      if (single) req.files.push(single);
    }
    return next();
  },
  enforceImagePreflight,
  enforceStorageLimitFromUploadedFiles(),
  submissionController.submitByQrToken
);

router.post(
  '/upload',
  verifyJwtToken,
  requireRole('student'),
  uploadUserLimiter,
  setUploadType('submissions'),
  upload.fields([
    { name: 'files', maxCount: 20 },
    { name: 'file', maxCount: 1 }
  ]),
  handleUploadError,
  validateUploadedFileSignature,
  (req, res, next) => {
    const list = Array.isArray(req.files) ? req.files : (req.files && req.files.files ? req.files.files : []);
    const single = req.files && req.files.file ? req.files.file[0] : req.file;
    if (!Array.isArray(req.files)) {
      req.files = [];
      if (Array.isArray(list)) req.files.push(...list);
      if (single) req.files.push(single);
    }
    return next();
  },
  enforceStorageLimitFromUploadedFiles(),
  submissionController.uploadHandwrittenForOcr
);

/**
 * @openapi
 * /api/submissions/{assignmentId}:
 *   post:
 *     tags:
 *       - Submissions
 *     summary: Submit using assignment id (Student)
 *     description: Upload a file as `multipart/form-data` field `file`.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: assignmentId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - file
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Submission created/updated
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden / limit exceeded / deadline passed
 *       404:
 *         description: Assignment not found
 *       409:
 *         description: Already submitted (in some race conditions)
 */
router.post(
  '/:assignmentId',
  verifyJwtToken,
  requireRole('student'),
  uploadUserLimiter,
  param('assignmentId').isMongoId().withMessage('Invalid assignment id'),
  handleValidationResult,
  setUploadType('submissions'),
  upload.fields([
    { name: 'files', maxCount: 20 },
    { name: 'file', maxCount: 1 }
  ]),
  handleUploadError,
  validateUploadedFileSignature,
  (req, res, next) => {
    const list = Array.isArray(req.files) ? req.files : (req.files && req.files.files ? req.files.files : []);
    const single = req.files && req.files.file ? req.files.file[0] : req.file;
    if (!Array.isArray(req.files)) {
      req.files = [];
      if (Array.isArray(list)) req.files.push(...list);
      if (single) req.files.push(single);
    }
    return next();
  },
  enforceImagePreflight,
  enforceStorageLimitFromUploadedFiles(),
  submissionController.submitByAssignmentId
);

router.get(
  '/assignment/:assignmentId/my',
  noStore,
  verifyJwtToken,
  requireRole('student'),
  param('assignmentId').isMongoId().withMessage('Invalid assignment id'),
  handleValidationResult,
  submissionController.getMySubmissionByAssignmentId
);

/**
 * @openapi
 * /api/submissions/assignment/{assignmentId}:
 *   get:
 *     tags:
 *       - Submissions
 *     summary: List submissions for an assignment (Teacher)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: assignmentId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Submissions list
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Assignment/Class not found
 */
router.get(
  '/assignment/:assignmentId',
  noStore,
  verifyJwtToken,
  requireRole('teacher'),
  param('assignmentId').isMongoId().withMessage('Invalid assignment id'),
  handleValidationResult,
  submissionController.getSubmissionsByAssignment
);

/**
 * @openapi
 * /api/submissions/my:
 *   get:
 *     tags:
 *       - Submissions
 *     summary: List my submissions (Student)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Submissions list
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */
router.get('/my', noStore, verifyJwtToken, requireRole('student'), submissionController.getMySubmissions);

router.get(
  '/:submissionId/draft-comparison',
  noStore,
  verifyJwtToken,
  requireRole(['student', 'teacher']),
  param('submissionId').isMongoId().withMessage('Invalid submission id'),
  handleValidationResult,
  submissionController.getDraftComparison
);

router.delete(
  '/:submissionId',
  verifyJwtToken,
  requireRole('teacher'),
  param('submissionId').isMongoId().withMessage('Invalid submission id'),
  handleValidationResult,
  submissionController.removeSubmission
);

const getOcrCorrectionsMiddleware = [
  noStore,
  verifyJwtToken,
  requireRole(['student', 'teacher']),
  param('submissionId').isMongoId().withMessage('Invalid submission id'),
  handleValidationResult,
  submissionController.getOcrCorrections
];

router.get(
  '/:submissionId/ocr-corrections',
  ...getOcrCorrectionsMiddleware
);

// Kept temporarily for backward compatibility with older clients.
router.post(
  '/:submissionId/ocr-corrections',
  ...getOcrCorrectionsMiddleware
);

router.post('/:submissionId/ocr-corrections/regenerate', createSensitiveRateLimiter(), verifyJwtToken, requireRole('teacher'),
  createUserRateLimiter({ event: 'AI_GENERATION_RATE_LIMITED', reason: 'ocr_correction_retry_user' }),
  createUserConcurrencyGuard({ operation: 'ocr_correction_retry', maxConcurrent: 2 }),
  param('submissionId').isMongoId().withMessage('Invalid submission id'), handleValidationResult,
  submissionController.regenerateCanonicalCorrections);

router.post('/:submissionId/evaluation/retry', verifyJwtToken, requireRole('teacher'),
  createSensitiveRateLimiter(),
  createUserRateLimiter({ event: 'AI_GENERATION_RATE_LIMITED', reason: 'evaluation_retry_user' }),
  createUserConcurrencyGuard({ operation: 'evaluation_retry', maxConcurrent: 2 }),
  param('submissionId').isMongoId().withMessage('Invalid submission id'), handleValidationResult,
  submissionController.retryCanonicalEvaluation);

router.get(
  '/:assignmentId',
  verifyJwtToken,
  requireRole('student'),
  param('assignmentId').isMongoId().withMessage('Invalid assignment id'),
  handleValidationResult,
  submissionController.getMySubmissionByAssignmentId
);

// Keep the established QR routes ahead of this generic submission-ID prefix.
router.post('/:submissionId/source-review',verifyJwtToken,requireRole('teacher'),reviewLimiter,param('submissionId').isMongoId(),handleValidationResult,humanReview.prepare);
router.get('/:submissionId/source-review/:itemId/crop',verifyJwtToken,requireRole('teacher'),reviewLimiter,createUserConcurrencyGuard({operation:'source_review_crop',maxConcurrent:2}),param('submissionId').isMongoId(),param('itemId').matches(/^[a-f0-9]{64}$/),handleValidationResult,humanReview.crop);
router.post('/:submissionId/source-review/:itemId/resolve',verifyJwtToken,requireRole('teacher'),reviewLimiter,createUserConcurrencyGuard({operation:'source_review_resolve',maxConcurrent:1}),param('submissionId').isMongoId(),param('itemId').matches(/^[a-f0-9]{64}$/),handleValidationResult,humanReview.resolve);
router.get('/:submissionId/source-review/page/:pageIndex',verifyJwtToken,requireRole('teacher'),reviewLimiter,param('submissionId').isMongoId(),param('pageIndex').matches(/^(0|[1-9]\d*)$/),handleValidationResult,humanReview.page);
router.get('/:submissionId/source-review/page/:pageIndex/image',verifyJwtToken,requireRole('teacher'),reviewLimiter,createUserConcurrencyGuard({operation:'source_review_page_image',maxConcurrent:2}),param('submissionId').isMongoId(),param('pageIndex').matches(/^(0|[1-9]\d*)$/),handleValidationResult,humanReview.pageImage);
router.post('/:submissionId/source-review/page/:pageIndex/resolve',verifyJwtToken,requireRole('teacher'),reviewLimiter,createUserConcurrencyGuard({operation:'source_review_resolve',maxConcurrent:1}),param('submissionId').isMongoId(),param('pageIndex').matches(/^(0|[1-9]\d*)$/),handleValidationResult,humanReview.pageResolve);
module.exports = router;
