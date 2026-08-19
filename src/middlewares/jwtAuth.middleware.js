const mongoose = require('mongoose');

const User = require('../models/user.model');
const { verifyJwt } = require('../utils/jwt');

const { ensureActivePlan } = require('./usage.middleware');
const logger = require('../utils/logger');

function getBearerToken(req) {
  const header = req.headers.authorization;
  if (!header || typeof header !== 'string') return null;

  const [type, token] = header.split(' ');
  if (type !== 'Bearer' || !token) return null;

  return token.trim();
}

function authError(res, status, code, message) {
  return res.status(status).json({ success: false, code, message });
}

async function verifyJwtToken(req, res, next) {
  try {
    const token = getBearerToken(req);

    if (!token) {
      return authError(res, 401, 'AUTH_REQUIRED', 'Authentication is required');
    }

    const payload = verifyJwt(token);
    const userId = payload && payload.id;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return authError(res, 401, 'AUTH_INVALID', 'Authentication is invalid');
    }

    const user = await User.findById(userId);

    if (!user) {
      return authError(res, 401, 'AUTH_INVALID', 'Authentication is invalid');
    }

    if (user.isActive === false) {
      return authError(res, 403, 'ACCOUNT_INACTIVE', 'Account is inactive');
    }

    try {
      await ensureActivePlan(user);
    } catch (err) {
      logger.error({
        event: 'auth.ensureActivePlan.failed',
        userId: String(user._id),
        role: user.role,
        error: err instanceof Error ? {
          name: err.name,
          message: err.message,
          code: err.code,
          errors: err.errors,
          stack: err.stack
        } : err
      });
      return res.status(500).json({
        success: false,
        message: 'Failed to initialize subscription'
      });
    }

    req.user = user;
    req.jwt = payload;

    return next();
  } catch (err) {
    const expired = err && err.name === 'TokenExpiredError';
    return authError(
      res,
      401,
      expired ? 'AUTH_EXPIRED' : 'AUTH_INVALID',
      expired ? 'Authentication has expired' : 'Authentication is invalid'
    );
  }
}

module.exports = { getBearerToken, verifyJwtToken };
