const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    // One MongoDB user per Firebase UID
    firebaseUid: {
      type: String,
      required: [true, 'firebaseUid is required'],
      unique: true,
      index: true,
      trim: true
    },
    email: {
      type: String,
      required: [true, 'email is required'],
      lowercase: true,
      index: true,
      trim: true
    },
    displayName: {
      type: String,
      trim: true
    },
    role: {
      type: String,
      enum: ['teacher', 'student', 'admin'],
      default: 'student'
    },
    plan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Plan'
    },
    planStartedAt: {
      type: Date
    },
    planExpiresAt: {
      type: Date
    },
    usage: {
      classes: { type: Number, default: 0, min: 0 },
      assignments: { type: Number, default: 0, min: 0 },
      students: { type: Number, default: 0, min: 0 },
      submissions: { type: Number, default: 0, min: 0 },
      storageMB: { type: Number, default: 0, min: 0 }
    },
    photoURL: {
      type: String,
      trim: true
    },
    isActive: {
      type: Boolean,
      default: true
    }
  },
  {
    timestamps: true
  }
);


const User = mongoose.model('User', userSchema);

module.exports = User;
