const logger = require('../utils/logger');

const activeByOperationAndUser = new Map();

function createUserConcurrencyGuard({ operation, maxConcurrent = 2 } = {}) {
  const safeOperation = String(operation || 'expensive_operation');
  const limit = Math.max(1, Number(maxConcurrent) || 2);

  return function userConcurrencyGuard(req, res, next) {
    const userId = req.user?._id ? String(req.user._id) : null;
    if (!userId) return next();

    const key = `${safeOperation}:${userId}`;
    const active = activeByOperationAndUser.get(key) || 0;
    if (active >= limit) {
      logger.warn({
        event: 'AI_CONCURRENCY_LIMITED',
        operation: safeOperation,
        userId,
        role: req.user?.role,
        timestamp: new Date().toISOString()
      });
      return res.status(429).json({
        success: false,
        code: 'RATE_LIMITED',
        message: 'Too many requests. Please try again later.'
      });
    }

    activeByOperationAndUser.set(key, active + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const current = activeByOperationAndUser.get(key) || 1;
      if (current <= 1) activeByOperationAndUser.delete(key);
      else activeByOperationAndUser.set(key, current - 1);
    };
    res.once('finish', release);
    res.once('close', release);
    return next();
  };
}

function resetConcurrencyStateForTests() {
  activeByOperationAndUser.clear();
}

module.exports = { createUserConcurrencyGuard, resetConcurrencyStateForTests };
