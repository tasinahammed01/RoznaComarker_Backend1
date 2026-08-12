const cors = require('cors');
const logger = require('../utils/logger');

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

  let allowedOrigins = configuredOrigins.length
    ? configuredOrigins
    : (isProd ? [] : ['http://localhost:4200']);

  // Always allow localhost origins in development mode
  if (!isProd) {
    const devOrigins = ['http://localhost:4200', 'http://127.0.0.1:4200'];
    devOrigins.forEach((origin) => {
      if (!allowedOrigins.includes(origin)) {
        allowedOrigins.push(origin);
      }
    });
  }

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

      logger.warn({
        message: 'CORS origin rejected',
        origin: normalizedOrigin,
        nodeEnv: process.env.NODE_ENV,
        allowedOrigins
      });

      const err = new Error('Not allowed by CORS');
      err.statusCode = 403;
      return callback(err);
    },
    // Authentication is an explicit Authorization bearer header, not a
    // browser-managed cookie. Do not opt private APIs into credentialed CORS.
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    exposedHeaders: ['Content-Length', 'Content-Type']
  });
}

module.exports = {
  createCorsMiddleware
};
