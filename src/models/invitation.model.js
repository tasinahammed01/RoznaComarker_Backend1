const mongoose = require('mongoose');

const invitationSchema = new mongoose.Schema(
  {
    class: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Class',
      required: [true, 'Class is required'],
      index: true
    },
    teacher: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Teacher is required'],
      index: true
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      lowercase: true,
      trim: true,
      index: true
    },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'expired'],
      default: 'pending',
      index: true
    },
    invitedAt: {
      type: Date,
      default: Date.now,
      index: true
    },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
      index: true
    },
    acceptedAt: {
      type: Date
    },
    token: {
      type: String,
      unique: true,
      index: true
    }
  },
  {
    timestamps: true
  }
);

// Create compound indexes for efficient queries
invitationSchema.index({ class: 1, email: 1 }, { unique: true });
invitationSchema.index({ teacher: 1, status: 1 });

// Pre-save middleware to generate token
invitationSchema.pre('save', function(next) {
  if (this.isNew && !this.token) {
    const crypto = require('crypto');
    this.token = crypto.randomBytes(32).toString('hex');
  }
  next();
});

// Static method to find valid invitation
invitationSchema.statics.findValidInvitation = function(classId, email) {
  return this.findOne({
    class: classId,
    email: email.toLowerCase().trim(),
    status: 'pending',
    expiresAt: { $gt: new Date() }
  });
};

// Instance method to accept invitation
invitationSchema.methods.accept = function() {
  this.status = 'accepted';
  this.acceptedAt = new Date();
  return this.save();
};

// Instance method to expire invitation
invitationSchema.methods.expire = function() {
  this.status = 'expired';
  return this.save();
};

const Invitation = mongoose.model('Invitation', invitationSchema);

module.exports = Invitation;
