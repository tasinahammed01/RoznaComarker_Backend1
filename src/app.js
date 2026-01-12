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
const submissionRoutes = require('./routes/submission.routes');
const feedbackRoutes = require('./routes/feedback.routes');
const subscriptionRoutes = require('./routes/subscription.routes');
const notFound = require('./middlewares/notFound.middleware');
const { errorHandler } = require('./middlewares/error.middleware');

const swaggerUi = require('swagger-ui-express');
const { createSwaggerSpec } = require('./config/swagger');

const { createCorsMiddleware } = require('./middlewares/cors.middleware');
const { createGlobalRateLimiter } = require('./middlewares/rateLimit.middleware');

const app = express();

app.disable('x-powered-by');

const uploadBasePath = (process.env.UPLOAD_BASE_PATH || 'uploads').trim() || 'uploads';
const uploadsRoot = path.join(__dirname, '..', uploadBasePath);
fs.mkdirSync(path.join(uploadsRoot, 'assignments'), { recursive: true });
fs.mkdirSync(path.join(uploadsRoot, 'submissions'), { recursive: true });
fs.mkdirSync(path.join(uploadsRoot, 'feedback'), { recursive: true });

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

// Serve static files with CORS support
app.use(
  '/uploads',
  createCorsMiddleware(),
  express.static(
    uploadsRoot
  )
);

app.use('/api', healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/demo', demoRoutes);
app.use('/api/classes', classRoutes);
app.use('/api/memberships', membershipRoutes);
app.use('/api/assignments', assignmentRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/submissions', submissionRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/subscription', subscriptionRoutes);

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
