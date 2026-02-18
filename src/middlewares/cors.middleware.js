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
  const allowedOrigins = parseAllowedOrigins(process.env.FRONTEND_URL);

  if (isProd && !allowedOrigins.length) {
    throw new Error('FRONTEND_URL must be set in production');
  }

  return cors({
    origin(origin, callback) {
      if (!isProd) {
        return callback(null, true); // Allow any origin in development for flexibility
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
