const crypto = require('crypto');

// In-memory store: token -> { userId, expiresAt }
const sseTokens = new Map();

const TTL_MS = 60 * 1000; // 60 seconds

function pruneExpired() {
  const now = Date.now();
  for (const [token, entry] of sseTokens) {
    if (entry.expiresAt <= now) {
      sseTokens.delete(token);
    }
  }
}

function issueToken(userId) {
  pruneExpired();
  const token = crypto.randomBytes(32).toString('hex');
  sseTokens.set(token, {
    userId: String(userId),
    expiresAt: Date.now() + TTL_MS
  });
  return token;
}

/**
 * Atomically consume a one-time token. Returns the userId if valid and
 * unexpired, otherwise null. The token is invalidated on first successful
 * use (one-time use semantics).
 */
function consumeToken(token) {
  if (!token || typeof token !== 'string') return null;
  const entry = sseTokens.get(token);
  if (!entry) return null;
  // Invalidate immediately regardless of expiry to prevent replay.
  sseTokens.delete(token);
  if (entry.expiresAt <= Date.now()) return null;
  return entry.userId;
}

module.exports = {
  issueToken,
  consumeToken
};
