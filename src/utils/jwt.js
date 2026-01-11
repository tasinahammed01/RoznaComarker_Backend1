const jwt = require('jsonwebtoken');

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

  return jwt.sign(payload, getJwtSecret(), { expiresIn: '7d' });
}

function verifyJwt(token) {
  if (!token || typeof token !== 'string') {
    throw new Error('Token is required');
  }

  return jwt.verify(token, getJwtSecret());
}

module.exports = {
  signJwt,
  verifyJwt
};
