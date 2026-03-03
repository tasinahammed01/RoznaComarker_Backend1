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
    collection: 'plans',
    versionKey: false
  }
);

module.exports = mongoose.model('PricingPlans', pricingPlansDocSchema);
