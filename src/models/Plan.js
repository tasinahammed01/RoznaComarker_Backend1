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
    billingType: {
      type: String,
      enum: ['monthly', 'yearly', 'custom'],
      required: [true, 'billingType is required']
    },
    stripePriceId: {
      type: String,
      default: null,
      trim: true
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


planSchema.statics.seedDefaults = async function seedDefaults() {
  const createdAt = new Date('2026-02-14T00:00:00Z');
  const defaults = [
    {
      name: 'Free',
      price: 0,
      durationDays: 30,
      limits: {
        classes: 5,
        assignments: 20,
        students: 50,
        submissions: 100,
        storageMB: 500
      },
      createdAt,
      isActive: true,
      isPopular: false,
      billingType: 'monthly',
      stripePriceId: null
    },
    {
      name: 'Starter Monthly',
      price: 9.99,
      durationDays: 30,
      limits: {
        classes: 20,
        assignments: 200,
        students: 500,
        submissions: 5000,
        storageMB: 2048
      },
      createdAt,
      isActive: true,
      isPopular: true,
      billingType: 'monthly',
      stripePriceId: 'price_monthly_XXXX'
    },
    {
      name: 'Starter Yearly',
      price: 99.99,
      durationDays: 365,
      limits: {
        classes: 20,
        assignments: 200,
        students: 500,
        submissions: 5000,
        storageMB: 2048
      },
      createdAt,
      isActive: true,
      isPopular: false,
      billingType: 'yearly',
      stripePriceId: 'price_yearly_XXXX'
    },
    {
      name: 'Custom',
      price: null,
      durationDays: null,
      limits: {
        classes: null,
        assignments: null,
        students: null,
        submissions: null,
        storageMB: null
      },
      createdAt,
      isActive: true,
      isPopular: false,
      billingType: 'custom',
      stripePriceId: null
    }
  ];

  for (const def of defaults) {
    await this.updateOne(
      { name: def.name },
      { $set: def },
      { upsert: true }
    );
  }
};

module.exports = mongoose.model('Plan', planSchema);
