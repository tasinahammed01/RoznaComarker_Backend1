const mongoose = require('mongoose');

const planSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'name is required'],
      trim: true,
      unique: true,
      index: true
    },
    slug: {
      type: String,
      trim: true,
      index: true
    },
    price: {
      type: Number,
      min: 0,
      default: null
    },
    durationDays: {
      type: Number,
      min: 0,
      default: null
    },
    annualPrice: { type: Number, min: 0, default: null },
    displayOrder: { type: Number, default: 0, index: true },
    assessmentCreditNudges: {
      softThresholdPercent: { type: Number, min: 0, max: 100, default: 50 },
      warningThresholdPercent: { type: Number, min: 0, max: 100, default: 80 }
    },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    currency: {
      type: String,
      trim: true,
      default: 'USD'
    },
    billingInterval: {
      type: String,
      trim: true,
      default: null
    },
    features: {
      maxClasses: { type: Number, min: 0, default: null },
      maxStudents: { type: Number, min: 0, default: null },
      essayAnalysesPerMonth: { type: Number, min: 0, default: null },
      storageMB: { type: Number, min: 0, default: null },
      aiFlashcards: { type: Boolean, default: false },
      aiFlashcardsLimit: { type: Number, min: 0, default: null },
      aiWorksheets: { type: Boolean, default: false },
      aiWorksheetsLimit: { type: Number, min: 0, default: null },
      adaptiveLearning: { type: Boolean, default: false },
      adaptiveLearningLimit: { type: Number, min: 0, default: null },
      priorityAIProcessing: { type: Boolean, default: false },
      analyticsAccess: { type: Boolean, default: false },
      dedicatedSupport: { type: Boolean, default: false }
    },
    display: {
      title: { type: String, trim: true, default: null },
      description: { type: String, trim: true, default: null },
      priceLabel: { type: String, trim: true, default: null },
      cta: { type: String, trim: true, default: null }
    },
    limits: {
      classes: { type: Number, min: 0, default: null },
      assignments: { type: Number, min: 0, default: null },
      students: { type: Number, min: 0, default: null },
      submissions: { type: Number, min: 0, default: null },
      storageMB: { type: Number, min: 0, default: null }
    },
    isActive: {
      type: Boolean,
      default: true
    },
    isPopular: {
      type: Boolean,
      default: false
    },
    popular: {
      type: Boolean,
      default: false
    },
    billingType: {
      type: String,
      enum: ['monthly', 'yearly', 'custom'],
      default: null
    },
    stripe: {
      productId: { type: String, trim: true },
      priceId: { type: String, trim: true },
      monthlyPriceId: { type: String, trim: true },
      annualPriceId: { type: String, trim: true }
    },
    badgeText: {
      type: String,
      default: null,
      trim: true
    },
    description: {
      type: String,
      default: null,
      trim: true
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  },
  {
    versionKey: false
  }
);

planSchema.index(
  { 'stripe.priceId': 1 },
  { unique: true, partialFilterExpression: { 'stripe.priceId': { $type: 'string' } } }
);


module.exports = mongoose.model('Plan', planSchema);
