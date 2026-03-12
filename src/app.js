const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const fs = require('fs');
const path = require('path');
const hpp = require('hpp');

const { sanitizeRequest } = require('./middlewares/sanitize.middleware');

const healthRoutes = require('./routes/health.routes');
const userRoutes = require('./routes/user.routes');
const authRoutes = require('./routes/auth.routes');
const demoRoutes = require('./routes/demo.routes');
const classRoutes = require('./routes/class.routes');
const membershipRoutes = require('./routes/membership.routes');
const assignmentRoutes = require('./routes/assignment.routes');
const fileRoutes = require('./routes/file.routes');
const uploadRoutes = require('./routes/upload.routes');
const secureFileRoutes = require('./routes/secureFile.routes');
const submissionRoutes = require('./routes/submission.routes');
const feedbackRoutes = require('./routes/feedback.routes');
const pdfRoutes = require('./routes/pdf.routes');
const plansRoutes = require('./routes/plans.routes');
const subscriptionRoutes = require('./routes/subscription.routes');
const writingCorrectionsRoutes = require('./routes/writingCorrections.routes');
const notificationRoutes = require('./routes/notification.routes');
const notFound = require('./middlewares/notFound.middleware');
const { errorHandler } = require('./middlewares/error.middleware');

const submissionController = require('./controllers/submission.controller');
const { verifyJwtToken } = require('./middlewares/jwtAuth.middleware');
const { requireRole } = require('./middlewares/role.middleware');
const {
  upload,
  setUploadType,
  handleUploadError,
  validateUploadedFileSignature
} = require('./middlewares/upload.middleware');
const { enforceStorageLimitFromUploadedFile, enforceStorageLimitFromUploadedFiles } = require('./middlewares/usage.middleware');

const swaggerUi = require('swagger-ui-express');
const { createSwaggerSpec } = require('./config/swagger');

const { createCorsMiddleware } = require('./middlewares/cors.middleware');
const { createGlobalRateLimiter, createSensitiveRateLimiter } = require('./middlewares/rateLimit.middleware');

const app = express();

 // When running behind a reverse proxy (common on VPS with Nginx/Apache),
 // trust X-Forwarded-* headers so req.protocol and req.get('host') are correct.
 // This directly affects generated public URLs for uploaded files.
 if (process.env.TRUST_PROXY === 'true' || process.env.NODE_ENV === 'production') {
   app.set('trust proxy', 1);
 }

app.disable('x-powered-by');

// Prevent conditional GET caching (ETag/If-None-Match) from returning 304 for API responses.
// This avoids stale submission payloads after students upload and are redirected to the submission page.
app.set('etag', false);

const uploadBasePath = (process.env.UPLOAD_BASE_PATH || 'uploads').trim() || 'uploads';
const uploadsRoot = path.join(__dirname, '..', uploadBasePath);
fs.mkdirSync(path.join(uploadsRoot, 'assignments'), { recursive: true });
fs.mkdirSync(path.join(uploadsRoot, 'submissions'), { recursive: true });
fs.mkdirSync(path.join(uploadsRoot, 'feedback'), { recursive: true });
fs.mkdirSync(path.join(uploadsRoot, 'original'), { recursive: true });
fs.mkdirSync(path.join(uploadsRoot, 'processed'), { recursive: true });
fs.mkdirSync(path.join(uploadsRoot, 'transcripts'), { recursive: true });
fs.mkdirSync(path.join(uploadsRoot, 'avatars'), { recursive: true });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(createCorsMiddleware());

const cspDirectives = {
  ...helmet.contentSecurityPolicy.getDefaultDirectives(),
  'frame-ancestors': ["'none'"]
};

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: cspDirectives
    },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    frameguard: { action: 'deny' },
    hsts: process.env.NODE_ENV === 'production'
      ? { maxAge: 15552000, includeSubDomains: true, preload: true }
      : false,
    xXssProtection: true
  })
);

app.use(sanitizeRequest);
app.use(hpp());

app.use(
  morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev')
);

// app.use(createGlobalRateLimiter()); // Global rate limiter disabled

// Serve legacy static files with CORS support
app.use('/uploads/assignments', createCorsMiddleware(), express.static(path.join(uploadsRoot, 'assignments')));
app.use('/uploads/submissions', createCorsMiddleware(), express.static(path.join(uploadsRoot, 'submissions')));
app.use('/uploads/feedback', createCorsMiddleware(), express.static(path.join(uploadsRoot, 'feedback')));
app.use('/uploads/avatars', createCorsMiddleware(), express.static(path.join(uploadsRoot, 'avatars')));
app.use('/uploads/original', createCorsMiddleware(), express.static(path.join(uploadsRoot, 'original')));
app.use('/uploads/processed', createCorsMiddleware(), express.static(path.join(uploadsRoot, 'processed')));

app.use('/api', healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/demo', demoRoutes);
app.use('/api/classes', classRoutes);
app.use('/api/memberships', membershipRoutes);
app.use('/api/assignments', assignmentRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/submissions', submissionRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/pdf', pdfRoutes);
app.use('/api/plans', plansRoutes);
app.use('/api/subscription', subscriptionRoutes);
app.use('/api/writing-corrections', writingCorrectionsRoutes);
app.use('/api/notifications', notificationRoutes);

app.post(
  '/upload',
  createSensitiveRateLimiter(),
  verifyJwtToken,
  requireRole('student'),
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
  (req, res, next) => {
    req.params = req.params || {};
    req.params.assignmentId = req.body && req.body.assignmentId ? String(req.body.assignmentId) : undefined;
    return next();
  },
  submissionController.submitByAssignmentId
);

app.use('/files', secureFileRoutes);

app.get('/files/submissions/:filename', (req, res) => {
  const filename = req.params && req.params.filename ? String(req.params.filename) : '';
  if (!filename) {
    return res.status(404).json({
      success: false,
      message: 'Route not found'
    });
  }

  return res.redirect(`/uploads/submissions/${encodeURIComponent(filename)}`);
});

const swaggerSpec = createSwaggerSpec();
app.get('/api/docs.json', (req, res) => res.json(swaggerSpec));
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Root health check endpoint
app.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    message: "Backend is running"
  });
});

app.use(notFound);
app.use(errorHandler);

module.exports = app;
