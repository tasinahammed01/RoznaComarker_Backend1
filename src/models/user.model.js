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
    institution: {
      type: String,
      trim: true
    },
    bio: {
      type: String,
      trim: true
    },
    aiConfig: {
      strictness: {
        type: String,
        enum: ['friendly', 'balanced', 'strict'],
        default: 'balanced'
      },
      checks: {
        grammarSpelling: { type: Boolean, default: true },
        coherenceLogic: { type: Boolean, default: true },
        factChecking: { type: Boolean, default: false }
      }
    },
    classroomDefaults: {
      gradingScale: {
        type: String,
        enum: ['score_0_100', 'grade_a_f', 'pass_fail'],
        default: 'score_0_100'
      },
      lateSubmissionPenaltyPercent: {
        type: Number,
        default: 10,
        min: 0,
        max: 100
      },
      autoPublishGrades: {
        type: Boolean,
        default: false
      }
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
    stripeCustomerId: { type: String, trim: true, index: true, unique: true, sparse: true },
    stripeSubscriptionId: { type: String, trim: true, index: true, unique: true, sparse: true },
    stripePriceId: { type: String, trim: true },
    stripeProductId: { type: String, trim: true },
    stripeSubscriptionStatus: {
      type: String,
      enum: ['active', 'trialing', 'past_due', 'unpaid', 'canceled', 'incomplete', 'incomplete_expired', 'paused'],
      default: null
    },
    stripeCurrentPeriodStart: { type: Date },
    stripeCurrentPeriodEnd: { type: Date },
    stripeCancelAtPeriodEnd: { type: Boolean, default: false },
    stripeCanceledAt: { type: Date },
    stripeLatestInvoiceId: { type: String, trim: true },
    stripeLatestInvoiceStatus: { type: String, trim: true },
    stripeLastPaymentFailedAt: { type: Date },
    usage: {
      classes: { type: Number, default: 0, min: 0 },
      assignments: { type: Number, default: 0, min: 0 },
      students: { type: Number, default: 0, min: 0 },
      submissions: { type: Number, default: 0, min: 0 },
      aiFlashcards: { type: Number, default: 0, min: 0 },
      aiWorksheets: { type: Number, default: 0, min: 0 },
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
