const cors = require('cors');

function normalizeUrl(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\/+$/, '');
}

function parseAllowedOrigins(value) {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((x) => normalizeUrl(x))
    .filter(Boolean);
}

function createCorsMiddleware() {
  const isProd = process.env.NODE_ENV === 'production';
  const configuredOrigins = parseAllowedOrigins(
    process.env.CORS_ALLOWED_ORIGINS || process.env.CORS_ORIGINS || process.env.FRONTEND_URL
  );
  const allowedOrigins = configuredOrigins.length
    ? configuredOrigins
    : (isProd ? [] : ['http://localhost:4200']);

  if (isProd && !allowedOrigins.length) {
    throw new Error('CORS_ALLOWED_ORIGINS, CORS_ORIGINS, or FRONTEND_URL must be set in production');
  }

  return cors({
    origin(origin, callback) {
      if (!origin) {
        return callback(null, true);
      }

      const normalizedOrigin = normalizeUrl(origin);

      if (allowedOrigins.includes(normalizedOrigin)) {
        return callback(null, true);
      }

      const err = new Error('Not allowed by CORS');
      err.statusCode = 403;
      return callback(err);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    exposedHeaders: ['Content-Length', 'Content-Type']
  });
}

module.exports = {
  createCorsMiddleware
};
