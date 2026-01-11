const cors = require('cors');

function normalizeUrl(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\/+$/, '');
}

function createCorsMiddleware() {
  const isProd = process.env.NODE_ENV === 'production';
  const allowedOrigin = normalizeUrl(process.env.FRONTEND_URL);

  if (isProd && !allowedOrigin) {
    throw new Error('FRONTEND_URL must be set in production');
  }

  return cors({
    origin(origin, callback) {
      if (!origin) {
        return callback(null, true);
      }

      const normalizedOrigin = normalizeUrl(origin);

      if (!isProd) {
        return callback(null, true);
      }

      if (normalizedOrigin === allowedOrigin) {
        return callback(null, true);
      }

      const err = new Error('Not allowed by CORS');
      err.statusCode = 403;
      return callback(err);
    },
    credentials: true
  });
}

module.exports = {
  createCorsMiddleware
};
