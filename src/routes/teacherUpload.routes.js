'use strict';
// /api/assignments/:assignmentId/teacher-uploads: a teacher uploads photos of students' handwritten work. Teachers only; the
// service answers 404 unless this teacher owns the assignment and its active class.
const fs = require('fs');
const router = require('express').Router({ mergeParams: true });
const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');
const { requireRole } = require('../middlewares/role.middleware');
const { createUserRateLimiter } = require('../middlewares/rateLimit.middleware');
const { upload, setUploadType, handleUploadError, validateUploadedFileSignature, detectSignatureKind } = require('../middlewares/upload.middleware');
const controller = require('../controllers/teacherUpload.controller');
// Teacher uploads are essay work: a speaking (audio) submission is refused.
const { refuseAudioSubmission } = require('../middlewares/essayOnly.middleware');

const { preflightImage, enforceImagePreflight } = require('../middlewares/imagePreflight.middleware');

// The same files the student upload screen accepts.
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'application/pdf']);
const UNSUPPORTED = 'Please use JPG, PNG or PDF.';
const maxFileMB = () => { const bytes = Number(process.env.MAX_FILE_SIZE); return Math.max(1, Math.ceil((Number.isFinite(bytes) && bytes > 0 ? bytes : 10 * 1024 * 1024) / (1024 * 1024))); };
const uploaded = req => [req.file, ...(Array.isArray(req.files) ? req.files : [])].filter(Boolean);
const discard = req => { for (const file of uploaded(req)) { try { if (file.path) fs.unlinkSync(file.path); } catch { /* already gone */ } } };

/** Upload errors in the words the teacher sees; anything else goes to the shared handler. */
function teacherUploadError(error, req, res, next) {
  if (!error) return next();
  discard(req);
  if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ success: false, code: 'FILE_TOO_LARGE', message: `Each image must be ${maxFileMB()} MB or smaller.` });
  if (['LIMIT_FILE_COUNT', 'LIMIT_UNEXPECTED_FILE'].includes(error.code))
    return res.status(400).json({ success: false, code: 'TEACHER_UPLOAD_TOO_MANY_FILES', message: 'Add up to 20 images per student.' });
  if (error.statusCode === 400 && /invalid file type/i.test(String(error.message)))
    return res.status(400).json({ success: false, code: 'UNSUPPORTED_FILE_TYPE', message: UNSUPPORTED });
  return handleUploadError(error, req, res, next);
}

/** JPG, PNG or PDF only, judged by the file's real signature (a HEIC, WebP or renamed file is refused whatever its extension). */
function requireAllowedSignatures(req, res, next) {
  for (const file of uploaded(req)) {
    let kind = null;
    try {
      const fd = fs.openSync(file.path, 'r');
      try { const head = Buffer.alloc(16); const read = fs.readSync(fd, head, 0, 16, 0); kind = detectSignatureKind(head.subarray(0, read)); }
      finally { fs.closeSync(fd); }
    } catch { kind = null; }
    if (!ALLOWED_TYPES.has(kind)) { discard(req); return res.status(400).json({ success: false, code: 'UNSUPPORTED_FILE_TYPE', message: UNSUPPORTED }); }
  }
  return next();
}
// The shared signature check answers with its own (PDF-inclusive) wording; map it to the teacher message.
function signatureCheck(req, res, next) {
  const json = res.json.bind(res);
  res.json = body => {
    if (res.statusCode === 400 && body && body.success === false && /invalid file type/i.test(String(body.message)))
      return json({ success: false, code: 'UNSUPPORTED_FILE_TYPE', message: UNSUPPORTED });
    return json(body);
  };
  return validateUploadedFileSignature(req, res, err => { res.json = json; next(err); });
}

/** The save never reads handwriting itself: it needs the page check the dialog ran (stored, server-side evidence for exactly these
 *  bytes, this student and this assignment). When that check no longer applies (the assignment text, the student's account or the
 *  reader changed since), the teacher is asked to check the pages again rather than getting a generic failure. */
function recheckWhenStale(req, res, next) {
  const json = res.json.bind(res);
  res.json = body => {
    if (body && body.success === false && body.code === 'OCR_GPT_SOURCE_PREFLIGHT_REQUIRED') {
      res.status(409);
      return json({ success: false, code: 'TEACHER_UPLOAD_RECHECK_REQUIRED',
        message: 'The handwriting check for these pages is out of date. Check the pages again, then save.' });
    }
    return json(body);
  };
  return next();
}

const checkLimiter = createUserRateLimiter({ windowMs: 10 * 60 * 1000, limit: 120, event: 'TEACHER_UPLOAD_RATE_LIMITED', reason: 'teacher_upload_check' });
const uploadLimiter = createUserRateLimiter({ windowMs: 10 * 60 * 1000, limit: Number(process.env.TEACHER_UPLOAD_RATE_LIMIT_MAX) || 400,
  event: 'TEACHER_UPLOAD_RATE_LIMITED', reason: 'teacher_upload_save' });
const preflightLimiter = createUserRateLimiter({ windowMs: 10 * 60 * 1000, limit: Number(process.env.TEACHER_UPLOAD_PREFLIGHT_RATE_LIMIT_MAX) || 600,
  event: 'TEACHER_UPLOAD_RATE_LIMITED', reason: 'teacher_upload_preflight' });
const retryLimiter = createUserRateLimiter({ windowMs: 10 * 60 * 1000, limit: 60, event: 'TEACHER_UPLOAD_RATE_LIMITED', reason: 'teacher_upload_retry' });
const sendLimiter = createUserRateLimiter({ windowMs: 10 * 60 * 1000, limit: Number(process.env.TEACHER_UPLOAD_SEND_RATE_LIMIT_MAX) || 60,
  event: 'TEACHER_UPLOAD_SEND_RATE_LIMITED', reason: 'teacher_upload_send' });

router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
// Every route states its guard (the route inventory in tests/helpers/studentRouteScan.js reads it per route).
router.get('/', verifyJwtToken, requireRole('teacher'), checkLimiter, controller.list);
router.post('/check', verifyJwtToken, requireRole('teacher'), checkLimiter, controller.check);
// The student screen's page check (basic image checks, then the handwriting check), bound to the student being uploaded for.
router.post('/image-preflight', verifyJwtToken, requireRole('teacher'), preflightLimiter, setUploadType('submissions'), upload.single('file'),
  teacherUploadError, signatureCheck, requireAllowedSignatures, controller.source, preflightImage);
router.post('/', verifyJwtToken, requireRole('teacher'), uploadLimiter, setUploadType('submissions'), upload.array('files', 20), teacherUploadError,
  signatureCheck, requireAllowedSignatures, controller.source, recheckWhenStale, enforceImagePreflight, controller.save);
router.post('/:submissionId/send', verifyJwtToken, requireRole('teacher'), refuseAudioSubmission, sendLimiter, controller.send);
router.post('/:submissionId/retry', verifyJwtToken, requireRole('teacher'), refuseAudioSubmission, retryLimiter, controller.retry);

module.exports = router;
