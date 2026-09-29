const crypto = require('crypto');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const logger = require('../utils/logger');
const { verifyJwt } = require('../utils/jwt');

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function safeHash(value) {
  const secret = process.env.RATE_LIMIT_HASH_SECRET || process.env.JWT_SECRET || 'local-rate-limit';
  return crypto.createHmac('sha256', secret).update(String(value || 'unknown')).digest('hex').slice(0, 16);
}

function normalizedIp(req) {
  return ipKeyGenerator(String(req.ip || req.socket?.remoteAddress || 'unknown'));
}

// The global guard runs before route authentication. Only a server-verified JWT
// may select a user bucket; an arbitrary header/body/query value never can.
function verifiedUserId(req) {
  if (req.rateLimitUserId !== undefined) return req.rateLimitUserId;
  const match = /^Bearer (\S+)$/.exec(String(req.headers.authorization || ''));
  try {
    const id = match && String(verifyJwt(match[1]).id || '');
    req.rateLimitUserId = id && /^[a-f\d]{24}$/i.test(id) ? id : null;
  } catch {
    req.rateLimitUserId = null;
  }
  return req.rateLimitUserId;
}

function normalizedEmail(req) {
  const email = req.body && typeof req.body.email === 'string' ? req.body.email : '';
  return email.normalize('NFKC').trim().toLowerCase().slice(0, 320);
}

function auditRateLimit(req, event, reason, scope) {
  logger.warn({
    event,
    scope,
    reason,
    userId: req.user?._id ? String(req.user._id) : undefined,
    role: req.user?.role ? String(req.user.role) : undefined,
    route: `${req.method} ${String(req.baseUrl || '')}${String(req.route?.path || req.path || '')}`,
    ipHash: safeHash(normalizedIp(req)),
    timestamp: new Date().toISOString()
  });
}

function buildRateLimitConfig({ windowMs, limit, keyGenerator, event = 'RATE_LIMITED', reason = 'policy',
  scope, skip, skipSuccessfulRequests = false, responseCode = 'RATE_LIMITED', responseMessage }) {
  return {
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator,
    skip,
    skipSuccessfulRequests,
    handler(req, res) {
      auditRateLimit(req, event, reason, scope);
      return res.status(429).json({
        success: false,
        code: responseCode,
        message: responseMessage || 'Too many requests. Please wait and try again.'
      });
    }
  };
}

function createLimiter(options) {
  return rateLimit(buildRateLimitConfig(options));
}

function createGlobalRateLimiter(options = {}) {
  return createLimiter({
    // RATE_LIMIT_WINDOW/MAX previously described an unused limiter in local
    // environments. Only the explicit Phase 2 window opt-in is inherited so
    // activating the baseline cannot unexpectedly impose the legacy 100 cap.
    windowMs: toPositiveInt(process.env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    limit: toPositiveInt(process.env.BASELINE_RATE_LIMIT_MAX, 300),
    keyGenerator: normalizedIp,
    event: 'API_RATE_LIMITED',
    reason: 'baseline_ip',
    skip: req => Boolean(options.skip?.(req) || verifiedUserId(req))
  });
}

function createCoarseIpRateLimiter(options = {}) {
  return createLimiter({
    windowMs: toPositiveInt(process.env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    limit: toPositiveInt(process.env.COARSE_IP_RATE_LIMIT_MAX, 6000),
    keyGenerator: normalizedIp,
    event: 'API_RATE_LIMITED', reason: 'coarse_ip',
    skip: options.skip
  });
}

function createAuthenticatedTrafficLimiter(options = {}) {
  return createLimiter({
    windowMs: toPositiveInt(process.env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    limit: req => ['GET', 'HEAD', 'OPTIONS'].includes(req.method)
      ? toPositiveInt(process.env.AUTH_READ_RATE_LIMIT_MAX, 600)
      : toPositiveInt(process.env.AUTH_WRITE_RATE_LIMIT_MAX, 180),
    keyGenerator: req => `user:${verifiedUserId(req)}:${['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? 'read' : 'write'}`,
    event: 'API_RATE_LIMITED', reason: 'authenticated_user',
    skip: req => Boolean(options.skip?.(req) || !verifiedUserId(req))
  });
}

function isBaselineExcludedRequest(req) {
  return req.path === '/health' || req.path === '/notifications/stream'
    || (req.method === 'POST' && req.path === '/auth/login');
}

function createSensitiveRateLimiter(options = {}) {
  return createLimiter({
    windowMs: toPositiveInt(options.windowMs || process.env.SENSITIVE_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    limit: toPositiveInt(options.limit || process.env.SENSITIVE_RATE_LIMIT_MAX, 20),
    keyGenerator: normalizedIp,
    event: options.event || 'SENSITIVE_OPERATION_RATE_LIMITED',
    reason: options.reason || 'sensitive_ip'
  });
}

function createUserRateLimiter(options = {}) {
  return createLimiter({
    windowMs: toPositiveInt(options.windowMs || process.env.AI_USER_RATE_LIMIT_WINDOW_MS, 5 * 60 * 1000),
    limit: toPositiveInt(options.limit || process.env.AI_USER_RATE_LIMIT_MAX, 10),
    keyGenerator: (req) => req.user?._id
      ? `user:${String(req.user._id)}`
      : req.firebase?.uid
        ? `firebase:${safeHash(req.firebase.uid)}`
        : `ip:${normalizedIp(req)}`,
    event: options.event || 'AI_GENERATION_RATE_LIMITED',
    reason: options.reason || 'authenticated_user',
    scope: options.scope,
    skipSuccessfulRequests: options.skipSuccessfulRequests,
    responseCode: options.responseCode,
    responseMessage: options.responseMessage
  });
}

function createEmailRateLimiter(options = {}) {
  return createLimiter({
    windowMs: toPositiveInt(options.windowMs, 15 * 60 * 1000),
    limit: toPositiveInt(options.limit, 5),
    keyGenerator: (req) => `email:${safeHash(normalizedEmail(req) || normalizedIp(req))}`,
    event: options.event || 'EMAIL_OPERATION_RATE_LIMITED',
    reason: options.reason || 'normalized_email'
  });
}

function createAuthIpRateLimiter(options = {}) {
  return createLimiter({
    windowMs: toPositiveInt(options.windowMs, 15 * 60 * 1000),
    limit: toPositiveInt(options.limit, 20),
    keyGenerator: normalizedIp,
    event: options.event || 'AUTH_RATE_LIMITED',
    reason: options.reason || 'auth_ip',
    scope: options.scope,
    skipSuccessfulRequests: options.skipSuccessfulRequests,
    responseCode: options.responseCode,
    responseMessage: options.responseMessage
  });
}

module.exports = {
  auditRateLimit,
  createAuthIpRateLimiter,
  createEmailRateLimiter,
  createCoarseIpRateLimiter,
  createAuthenticatedTrafficLimiter,
  createGlobalRateLimiter,
  createSensitiveRateLimiter,
  createUserRateLimiter,
  isBaselineExcludedRequest,
  normalizedEmail,
  normalizedIp,
  safeHash,
  toPositiveInt
};
