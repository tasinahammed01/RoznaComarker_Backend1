const jwt = require('jsonwebtoken');

function signTestJwt({ id, firebaseUid, role }) {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET must be set for tests');
  }

  return jwt.sign(
    {
      id: String(id),
      firebaseUid,
      role
    },
    secret,
    { expiresIn: '1h' }
  );
}

module.exports = {
  signTestJwt
};
