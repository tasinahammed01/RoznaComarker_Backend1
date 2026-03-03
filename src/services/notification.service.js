const mongoose = require('mongoose');

const Notification = require('../models/notification.model');
const { publishToUser } = require('./notificationRealtime.service');

async function createNotification({ recipientId, actorId, type, title, description, data }) {
  if (!mongoose.Types.ObjectId.isValid(recipientId)) {
    throw new Error('Invalid recipient id');
  }

  const doc = await Notification.create({
    recipient: recipientId,
    actor: actorId && mongoose.Types.ObjectId.isValid(actorId) ? actorId : undefined,
    type: String(type || '').trim(),
    title: String(title || '').trim(),
    description: String(description || '').trim(),
    data
  });

  const populated = await Notification.findById(doc._id)
    .populate('recipient', '_id email displayName photoURL role')
    .populate('actor', '_id email displayName photoURL role');

  publishToUser({
    userId: recipientId,
    event: 'notification',
    payload: populated
  });

  return populated;
}

module.exports = {
  createNotification
};
