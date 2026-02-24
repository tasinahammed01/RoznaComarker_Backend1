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
const { enforceStorageLimitFromUploadedFile } = require('./middlewares/usage.middleware');

const swaggerUi = require('swagger-ui-express');
const { createSwaggerSpec } = require('./config/swagger');

const { createCorsMiddleware } = require('./middlewares/cors.middleware');
const { createGlobalRateLimiter, createSensitiveRateLimiter } = require('./middlewares/rateLimit.middleware');

const app = express();

app.disable('x-powered-by');

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

app.use(createGlobalRateLimiter());

// Serve legacy static files with CORS support
app.use('/uploads/assignments', createCorsMiddleware(), express.static(path.join(uploadsRoot, 'assignments')));
app.use('/uploads/submissions', createCorsMiddleware(), express.static(path.join(uploadsRoot, 'submissions')));
app.use('/uploads/feedback', createCorsMiddleware(), express.static(path.join(uploadsRoot, 'feedback')));
app.use('/uploads/avatars', createCorsMiddleware(), express.static(path.join(uploadsRoot, 'avatars')));

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

app.post(
  '/upload',
  createSensitiveRateLimiter(),
  verifyJwtToken,
  requireRole('student'),
  setUploadType('submissions'),
  upload.single('file'),
  handleUploadError,
  validateUploadedFileSignature,
  enforceStorageLimitFromUploadedFile(),
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
