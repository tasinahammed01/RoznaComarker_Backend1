const mongoose = require('mongoose');

const { Schema } = mongoose;

const notificationSchema = new Schema(
  {
    recipient: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    actor: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: undefined,
      index: true
    },
    type: {
      type: String,
      required: true,
      trim: true,
      index: true
    },
    title: {
      type: String,
      required: true,
      trim: true
    },
    description: {
      type: String,
      required: true,
      trim: true
    },
    data: {
      type: Schema.Types.Mixed,
      default: undefined
    },
    readAt: {
      type: Date,
      default: undefined,
      index: true
    }
  },
  {
    timestamps: true
  }
);

notificationSchema.index({ recipient: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
