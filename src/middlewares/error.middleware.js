class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function errorHandler(err, req, res, next) {
  const logger = require('../utils/logger');
  const statusCode = err.statusCode || err.status || 500;
  const isProd = process.env.NODE_ENV === 'production';

  const message = statusCode === 413
    ? 'Request payload is too large.'
    : statusCode === 500 && isProd
      ? 'Internal Server Error'
      : err.message || 'Internal Server Error';

  try {
    if (statusCode >= 500) {
      if (isProd) {
        logger.error(err && err.message ? err.message : 'Internal Server Error');
      } else {
        logger.error(err);
      }
    } else {
      logger.warn(err && err.message ? err.message : err);
    }
  } catch (logErr) {
    // ignore
  }

  res.status(statusCode).json({
    success: false,
    ...(statusCode === 413 ? { code: 'PAYLOAD_TOO_LARGE' } : {}),
    message
  });
}

module.exports = {
  ApiError,
  errorHandler
};
