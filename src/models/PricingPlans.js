const mongoose = require('mongoose');

const pricingPlanSchema = new mongoose.Schema(
  {
    name: { type: String, default: null, trim: true },
    slug: { type: String, default: null, trim: true },
    price: { type: Number, default: null },
    currency: { type: String, default: 'USD', trim: true },
    features: {
      classes: { type: mongoose.Schema.Types.Mixed, default: null },
      maxStudentsPerClass: { type: mongoose.Schema.Types.Mixed, default: null },
      essaysPerMonth: { type: mongoose.Schema.Types.Mixed, default: null },
      storageMB: { type: Number, default: null },
      storageGB: { type: Number, default: null },
      aiTokens: { type: mongoose.Schema.Types.Mixed, default: null },
      priorityProcessing: { type: Boolean, default: false },
      analyticsAccess: { type: Boolean, default: false }
    }
  },
  { _id: false }
);

const pricingPlansDocSchema = new mongoose.Schema(
  {
    plans: { type: [pricingPlanSchema], default: [] }
  },
  {
    collection: 'pricing_plans',
    versionKey: false
  }
);

pricingPlansDocSchema.statics.seedDefaults = async function seedDefaults() {
  const existingCount = await this.countDocuments({});
  if (existingCount > 0) {
    return;
  }

  const defaults = [
    {
      name: 'Free',
      slug: 'free',
      price: 0,
      currency: 'USD',
      description: 'Perfect to try the workflow.',
      badgeText: null,
      isPopular: false,
      features: {
        classes: 5,
        maxStudentsPerClass: 50,
        essaysPerMonth: 100,
        storageMB: 500,
        storageGB: null,
        aiTokens: 'limited',
        priorityProcessing: false,
        analyticsAccess: false
      }
    },
    {
      name: 'Expert',
      slug: 'expert',
      price: 9.99,
      currency: 'USD',
      description: 'Best for active teachers.',
      badgeText: 'Popular',
      isPopular: true,
      features: {
        classes: 20,
        maxStudentsPerClass: 500,
        essaysPerMonth: 5000,
        storageMB: null,
        storageGB: 2,
        aiTokens: 'unlimited',
        priorityProcessing: true,
        analyticsAccess: true
      }
    },
    {
      name: 'Researcher',
      slug: 'researcher',
      price: null,
      currency: 'USD',
      description: 'Advanced features for research.',
      badgeText: null,
      isPopular: false,
      features: {
        classes: 'unlimited',
        maxStudentsPerClass: 'unlimited',
        essaysPerMonth: 'unlimited',
        storageMB: null,
        storageGB: null,
        aiTokens: 'unlimited',
        priorityProcessing: true,
        analyticsAccess: true
      }
    }
  ];

  await this.create({ plans: defaults });
};

module.exports = mongoose.model('PricingPlans', pricingPlansDocSchema);
