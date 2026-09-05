const mongoose = require('mongoose');

const Notification = require('../models/notification.model');
const { publishToUser } = require('./notificationRealtime.service');
const logger = require('../utils/logger');

const TAXONOMY = Object.freeze({
  assignment_submitted: ['ACTION_REQUIRED', 'HIGH'], credit_usage_nudge: ['ACTION_REQUIRED', 'HIGH'],
  adaptive_completed: ['STUDENT_PROGRESS', 'NORMAL'], referral_reward: ['REWARD', 'NORMAL'],
  bonus_reward: ['REWARD', 'NORMAL'], professional_milestone: ['REWARD', 'LOW'],
  payment_action_required: ['ACCOUNT', 'HIGH'], assignment_uploaded: ['WORKFLOW', 'NORMAL'],
  weekly_summary: ['WORKFLOW', 'NORMAL']
});
function safeData(data) {
  if (!data || typeof data !== 'object') return data;
  const route = data.route;
  if (!route) return data;
  const path = typeof route.path === 'string' ? route.path.trim() : '';
  // Navigation targets must be local application paths. This preserves all
  // established internal routes without allowing protocol or protocol-relative targets.
  if (!/^\/(?!\/)/.test(path)) return { ...data, route: undefined };
  return { ...data, route: { path, ...(Array.isArray(route.params) ? { params: route.params.map(String) } : {}),
    ...(route.queryParams && typeof route.queryParams === 'object' ? { queryParams: route.queryParams } : {}) } };
}

function populatedNotification(query) {
  return query.populate('recipient', '_id email displayName photoURL role')
    .populate('actor', '_id email displayName photoURL role');
}

async function createNotification({ recipientId, actorId, type, title, description, data, idempotencyKey, category, priority }) {
  if (!mongoose.Types.ObjectId.isValid(recipientId)) {
    throw new Error('Invalid recipient id');
  }

  const defaults = TAXONOMY[type] || ['WORKFLOW', 'NORMAL'];
  const resolvedCategory = category || defaults[0]; const resolvedPriority = priority || defaults[1];
  logger.info({ event: 'smart_notification_evaluated', recipientId: String(recipientId), type, category: resolvedCategory, priority: resolvedPriority });
  let doc;
  try {
    doc = await Notification.create({
      recipient: recipientId,
      actor: actorId && mongoose.Types.ObjectId.isValid(actorId) ? actorId : undefined,
      type: String(type || '').trim(),
      category: resolvedCategory, priority: resolvedPriority,
      title: String(title || '').trim(),
      description: String(description || '').trim(),
      data: safeData(data),
      idempotencyKey: idempotencyKey ? String(idempotencyKey).trim() : undefined
    });
  } catch (error) {
    if (error?.code !== 11000 || !idempotencyKey) {
      logger.error({ event: 'smart_notification_failed', recipientId: String(recipientId), type,
        category: resolvedCategory, priority: resolvedPriority, errorCode: error?.code || 'CREATE_FAILED' });
      throw error;
    }
    logger.info({ event: 'smart_notification_duplicate', recipientId: String(recipientId), type, category: resolvedCategory, priority: resolvedPriority });
    return populatedNotification(Notification.findOne({ idempotencyKey: String(idempotencyKey).trim() }));
  }

  const populated = await populatedNotification(Notification.findById(doc._id));

  publishToUser({
    userId: recipientId,
    event: 'notification',
    payload: populated
  });
  logger.info({ event: 'smart_notification_created', recipientId: String(recipientId), type,
    category: resolvedCategory, priority: resolvedPriority, sourceId: data?.submissionId || data?.sessionId || data?.rewardGrantId });

  return populated;
}

const createSmartNotification = createNotification;

module.exports = {
  createNotification, createSmartNotification, TAXONOMY, safeData
};
