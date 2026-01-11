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
      // In development, allow localhost:4200 explicitly
      if (!isProd) {
        const devOrigins = [
          'http://localhost:4200',
          'http://localhost:4200/',
          'http://127.0.0.1:4200',
          'http://127.0.0.1:4200/'
        ];
        
        if (!origin || devOrigins.includes(origin) || devOrigins.includes(origin + '/')) {
          return callback(null, true);
        }
        return callback(null, true); // Allow any origin in development for flexibility
      }

      const normalizedOrigin = normalizeUrl(origin);

      if (normalizedOrigin === allowedOrigin) {
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
