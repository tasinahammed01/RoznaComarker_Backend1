const mongoose = require('mongoose');

const User = require('../models/user.model');
const { verifyJwt } = require('../utils/jwt');

const { ensureActivePlan } = require('./usage.middleware');

function getBearerToken(req) {
  const header = req.headers.authorization;
  if (!header || typeof header !== 'string') return null;

  const [type, token] = header.split(' ');
  if (type !== 'Bearer' || !token) return null;

  return token.trim();
}

async function verifyJwtToken(req, res, next) {
  try {
    const token = getBearerToken(req);

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Authorization token missing'
      });
    }

    const payload = verifyJwt(token);
    const userId = payload && payload.id;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired token'
      });
    }

    const user = await User.findById(userId);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User not found'
      });
    }

    if (user.isActive === false) {
      return res.status(403).json({
        success: false,
        message: 'User is inactive'
      });
    }

    try {
      await ensureActivePlan(user);
    } catch (err) {
      return res.status(500).json({
        success: false,
        message: 'Failed to initialize subscription'
      });
    }

    req.user = user;
    req.jwt = payload;

    return next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token'
    });
  }
}

module.exports = {
  verifyJwtToken
};
