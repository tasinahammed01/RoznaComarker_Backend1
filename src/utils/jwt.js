const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const JWT_ALGORITHM = 'HS256';
const JWT_EXPIRES_IN = '7d';

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || typeof secret !== 'string' || secret.trim().length === 0) {
    throw new Error('JWT_SECRET is not configured');
  }
  return secret;
}

function signJwt(user) {
  if (!user) {
    throw new Error('User is required to sign JWT');
  }

  const payload = {
    id: String(user._id || user.id),
    firebaseUid: user.firebaseUid,
    role: user.role
  };

  return jwt.sign(payload, getJwtSecret(), {
    algorithm: JWT_ALGORITHM,
    expiresIn: JWT_EXPIRES_IN,
    subject: String(user._id || user.id),
    jwtid: crypto.randomUUID()
  });
}

function verifyJwt(token) {
  if (!token || typeof token !== 'string') {
    throw new Error('Token is required');
  }

  return jwt.verify(token, getJwtSecret(), {
    algorithms: [JWT_ALGORITHM],
    maxAge: JWT_EXPIRES_IN
  });
}

module.exports = {
  signJwt,
  verifyJwt,
  JWT_ALGORITHM,
  JWT_EXPIRES_IN
};
