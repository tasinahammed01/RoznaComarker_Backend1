const logger = require('../utils/logger');

// In-memory SSE connections: userId -> Set<res>
const userStreams = new Map();

function registerStream({ userId, res }) {
  const key = String(userId);
  if (!userStreams.has(key)) {
    userStreams.set(key, new Set());
  }

  userStreams.get(key).add(res);

  res.on('close', () => {
    try {
      const set = userStreams.get(key);
      if (set) {
        set.delete(res);
        if (set.size === 0) userStreams.delete(key);
      }
    } catch (err) {
      // ignore
    }
  });
}

function publishToUser({ userId, event, payload }) {
  const key = String(userId);
  const set = userStreams.get(key);
  if (!set || set.size === 0) return;

  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;

  for (const res of Array.from(set)) {
    try {
      res.write(msg);
    } catch (err) {
      logger.warn('Failed to push SSE notification');
    }
  }
}

module.exports = {
  registerStream,
  publishToUser
};
