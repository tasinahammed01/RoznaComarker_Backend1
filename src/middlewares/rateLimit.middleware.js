const rateLimit = require('express-rate-limit');

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function buildRateLimitConfig({ windowMs, limit, message }) {
  return {
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      message
    }
  };
}

function createGlobalRateLimiter() {
  const windowMs = toPositiveInt(process.env.RATE_LIMIT_WINDOW, 15 * 60 * 1000);
  const limit = toPositiveInt(process.env.RATE_LIMIT_MAX, 100);

  return rateLimit(
    buildRateLimitConfig({
      windowMs,
      limit,
      message: 'Too many requests, please try again later.'
    })
  );
}

function createSensitiveRateLimiter() {
  const windowMs = toPositiveInt(process.env.SENSITIVE_RATE_LIMIT_WINDOW_MS,
    toPositiveInt(process.env.RATE_LIMIT_WINDOW, 15 * 60 * 1000));
  const limit = toPositiveInt(process.env.SENSITIVE_RATE_LIMIT_MAX, 20);

  return rateLimit(
    buildRateLimitConfig({
      windowMs,
      limit,
      message: 'Too many requests, please try again later.'
    })
  );
}

module.exports = {
  createGlobalRateLimiter,
  createSensitiveRateLimiter
};
