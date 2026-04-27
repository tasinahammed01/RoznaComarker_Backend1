const Notification = require('../models/notification.model');
const { verifyJwt } = require('../utils/jwt');
const User = require('../models/user.model');
const { registerStream } = require('../services/notificationRealtime.service');
const { consumeToken: consumeSseToken } = require('../services/sseToken.service');

function sendSuccess(res, data) {
  return res.json({
    success: true,
    data
  });
}

function sendError(res, statusCode, message) {
  return res.status(statusCode).json({
    success: false,
    message
  });
}

async function listMyNotifications(req, res) {
  try {
    const userId = req.user && req.user._id;
    if (!userId) return sendError(res, 401, 'Unauthorized');

    const limitRaw = req.query && req.query.limit;
    const limit = Math.max(1, Math.min(200, Number(limitRaw) || 50));

    const items = await Notification.find({ recipient: userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('actor', '_id email displayName photoURL role');

    return sendSuccess(res, items);
  } catch {
    return sendError(res, 500, 'Failed to fetch notifications');
  }
}

async function getUnreadCount(req, res) {
  try {
    const userId = req.user && req.user._id;
    if (!userId) return sendError(res, 401, 'Unauthorized');

    const count = await Notification.countDocuments({
      recipient: userId,
      readAt: { $exists: false }
    });

    return sendSuccess(res, { count });
  } catch {
    return sendError(res, 500, 'Failed to fetch unread count');
  }
}

async function markAllRead(req, res) {
  try {
    const userId = req.user && req.user._id;
    if (!userId) return sendError(res, 401, 'Unauthorized');

    const now = new Date();
    await Notification.updateMany(
      {
        recipient: userId,
        readAt: { $exists: false }
      },
      { $set: { readAt: now } }
    );

    return sendSuccess(res, { readAt: now.toISOString() });
  } catch {
    return sendError(res, 500, 'Failed to mark all as read');
  }
}

async function markRead(req, res) {
  try {
    const userId = req.user && req.user._id;
    if (!userId) return sendError(res, 401, 'Unauthorized');

    const id = req.params && req.params.id ? String(req.params.id) : '';
    if (!id) return sendError(res, 400, 'Invalid notification id');

    const doc = await Notification.findOne({ _id: id, recipient: userId });
    if (!doc) return sendError(res, 404, 'Notification not found');

    if (!doc.readAt) {
      doc.readAt = new Date();
      await doc.save();
    }

    const populated = await Notification.findById(doc._id)
      .populate('actor', '_id email displayName photoURL role');

    return sendSuccess(res, populated);
  } catch {
    return sendError(res, 500, 'Failed to mark notification as read');
  }
}

function getBearerTokenFromHeader(req) {
  const header = req.headers.authorization;
  if (!header || typeof header !== 'string') return null;
  const [type, token] = header.split(' ');
  if (type !== 'Bearer' || !token) return null;
  return token.trim();
}

async function resolveUserForSse(req) {
  // Preferred: one-time SSE token in query (issued via POST /api/auth/sse-token).
  // Long-lived JWTs are NOT accepted via query string to avoid token leakage in
  // logs, browser history, and referrer headers.
  const sseTokenFromQuery = req.query && req.query.sseToken ? String(req.query.sseToken) : '';
  if (sseTokenFromQuery) {
    const userId = consumeSseToken(sseTokenFromQuery);
    if (!userId) return null;
    const user = await User.findById(userId);
    if (!user || user.isActive === false) return null;
    return user;
  }

  // Fallback: standard Bearer header (used by non-browser SSE clients that
  // can set headers, e.g. server-to-server). EventSource cannot set headers.
  const headerToken = getBearerTokenFromHeader(req);
  if (!headerToken) return null;

  let payload;
  try {
    payload = verifyJwt(headerToken);
  } catch {
    return null;
  }
  const userId = payload && payload.id;
  if (!userId) return null;

  const user = await User.findById(userId);
  if (!user || user.isActive === false) return null;

  return user;
}

async function streamMyNotifications(req, res) {
  try {
    const user = await resolveUserForSse(req);
    if (!user) {
      return sendError(res, 401, 'Unauthorized');
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    // CORS proxies sometimes buffer; flush headers early
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    // initial ping so client knows it's connected
    res.write('event: ready\ndata: {}\n\n');

    registerStream({ userId: user._id, res });

    // keep-alive ping
    const timer = setInterval(() => {
      try {
        res.write('event: ping\ndata: {}\n\n');
      } catch {
        // ignore
      }
    }, 25000);

    req.on('close', () => {
      clearInterval(timer);
    });
  } catch {
    return sendError(res, 500, 'Failed to open notifications stream');
  }
}

module.exports = {
  listMyNotifications,
  markRead,
  getUnreadCount,
  markAllRead,
  streamMyNotifications
};
