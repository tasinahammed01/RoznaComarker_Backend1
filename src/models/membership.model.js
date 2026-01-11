const mongoose = require('mongoose');

const { Schema } = mongoose;

const membershipSchema = new Schema(
  {
    student: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    class: {
      type: Schema.Types.ObjectId,
      ref: 'Class',
      required: true,
      index: true
    },
    joinedAt: {
      type: Date,
      default: Date.now
    },
    status: {
      type: String,
      enum: ['active', 'left'],
      default: 'active'
    }
  },
  {
    timestamps: false
  }
);

membershipSchema.index({ student: 1, class: 1 }, { unique: true });

module.exports = mongoose.model('Membership', membershipSchema);
