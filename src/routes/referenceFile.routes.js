'use strict';
// /api/reference-files: AI knowledge and reference files (teacher-only background material for marking). Behind REFERENCE_FILES_ENABLED
// (404 while off). Signed out 401, students 403, another teacher's class/assignment/file 404. Mutations and rubric drafts are rate-limited per
// teacher. Students, guests, recovery and PDF routes never use this router or the ReferenceFile collection (tests/referenceFileIsolation).
//   GET    /config                      { enabled, maxFiles, maxFileBytes } (answers { enabled: false } while off)
//   GET    /classes/:id                 class files
//   POST   /classes/:id                 upload one file (multipart: file, requestId)
//   GET    /assignments/:id             assignment files + the class files that also apply
//   POST   /assignments/:id             upload one file (multipart: file, requestId, markedAsRubric)
//   GET    /:fileId                     one file's status (polling)
//   DELETE /:fileId                     remove (soft delete, idempotent)
//   POST   /:fileId/rubric-draft        convert to a rubric draft for review (assignment files only, free)
//   POST   /:fileId/apply-rubric        apply the reviewed rubric { rubricDesigner, replace }
const router = require('express').Router();
const multer = require('multer');
const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');
const { requireRole } = require('../middlewares/role.middleware');
const { createUserRateLimiter } = require('../middlewares/rateLimit.middleware');
const { referenceFilesEnabled, LIMITS, MESSAGES } = require('../services/referenceFiles/policy');
const controller = require('../controllers/referenceFile.controller');

const envLimit = (name, fallback) => { const value = Number(process.env[name]); return Number.isInteger(value) && value > 0 ? value : fallback; };
const mutationLimiter = createUserRateLimiter({ windowMs: 15 * 60 * 1000, limit: envLimit('REFERENCE_FILE_RATE_LIMIT_MAX', 60),
  event: 'REFERENCE_FILE_RATE_LIMITED', reason: 'reference_file_mutation', responseCode: 'REFERENCE_FILE_RATE_LIMITED',
  responseMessage: 'Too many changes to reference files. Please wait a few minutes and try again.' });
const rubricLimiter = createUserRateLimiter({ windowMs: 15 * 60 * 1000, limit: envLimit('REFERENCE_RUBRIC_RATE_LIMIT_MAX', 10),
  event: 'REFERENCE_RUBRIC_RATE_LIMITED', reason: 'reference_rubric_draft', responseCode: 'REFERENCE_RUBRIC_RATE_LIMITED',
  responseMessage: 'Too many rubric conversions. Please wait a few minutes and try again.' });

// One file per request, in memory (checked by signature before anything is written).
const parseFile = multer({ storage: multer.memoryStorage(), limits: { fileSize: LIMITS.maxFileBytes, files: 1, fields: 5, fieldSize: 1024, parts: 7 } }).single('file');
function receiveFile(req, res, next) {
  parseFile(req, res, error => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ success: false, code: 'REFERENCE_FILE_TOO_LARGE', message: MESSAGES.REFERENCE_FILE_TOO_LARGE });
    if (['LIMIT_FILE_COUNT', 'LIMIT_UNEXPECTED_FILE', 'LIMIT_PART_COUNT', 'LIMIT_FIELD_COUNT', 'LIMIT_FIELD_VALUE'].includes(error.code))
      return res.status(400).json({ success: false, code: 'REFERENCE_FILE_ONE_AT_A_TIME', message: 'Upload one file at a time.' });
    return res.status(400).json({ success: false, code: 'REFERENCE_FILE_UPLOAD_INVALID', message: 'The upload could not be read. Please try again.' });
  });
}

// Whether the teacher's forms show the feature (a create form has no class or assignment yet to ask about). Answers even while off.
router.get('/config', verifyJwtToken, requireRole('teacher'), (req, res) => res.json({ success: true,
  data: referenceFilesEnabled() ? { enabled: true, maxFiles: LIMITS.maxFilesPerScope, maxFileBytes: LIMITS.maxFileBytes } : { enabled: false } }));
router.use((req, res, next) => (referenceFilesEnabled() ? next() : res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Not found.' })));
// Every route states its own sign-in and teacher role (tests/helpers/studentRouteScan.js reads the role from each route).
router.get('/classes/:id', verifyJwtToken, requireRole('teacher'), controller.loadScope('class'), controller.list);
router.post('/classes/:id', verifyJwtToken, requireRole('teacher'), controller.loadScope('class'), mutationLimiter, receiveFile, controller.upload);
router.get('/assignments/:id', verifyJwtToken, requireRole('teacher'), controller.loadScope('assignment'), controller.list);
router.post('/assignments/:id', verifyJwtToken, requireRole('teacher'), controller.loadScope('assignment'), mutationLimiter, receiveFile, controller.upload);
router.get('/:fileId', verifyJwtToken, requireRole('teacher'), controller.get);
router.delete('/:fileId', verifyJwtToken, requireRole('teacher'), mutationLimiter, controller.remove);
router.post('/:fileId/rubric-draft', verifyJwtToken, requireRole('teacher'), rubricLimiter, controller.draftRubric);
router.post('/:fileId/apply-rubric', verifyJwtToken, requireRole('teacher'), mutationLimiter, controller.applyRubric);

module.exports = router;
