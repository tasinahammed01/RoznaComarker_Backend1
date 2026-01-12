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
      required: [true, 'price is required'],
      min: 0
    },
    durationDays: {
      type: Number,
      required: [true, 'durationDays is required'],
      min: 0
    },
    limits: {
      classes: { type: Number, required: true, min: 0 },
      assignments: { type: Number, required: true, min: 0 },
      students: { type: Number, required: true, min: 0 },
      submissions: { type: Number, required: true, min: 0 },
      storageMB: { type: Number, required: true, min: 0 }
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
  const defaults = [
    {
      name: 'Free',
      price: 0,
      durationDays: 0,
      limits: {
        classes: 1,
        assignments: 10,
        students: 30,
        submissions: 100,
        storageMB: 100
      }
    },
    {
      name: 'Pro',
      price: 9.99,
      durationDays: 30,
      limits: {
        classes: 20,
        assignments: 200,
        students: 500,
        submissions: 5000,
        storageMB: 2048
      }
    },
    {
      name: 'School',
      price: 99.99,
      durationDays: 30,
      limits: {
        classes: 200,
        assignments: 2000,
        students: 10000,
        submissions: 100000,
        storageMB: 10240
      }
    }
  ];

  for (const def of defaults) {
    await this.updateOne(
      { name: def.name },
      { $setOnInsert: def },
      { upsert: true }
    );
  }
};

module.exports = mongoose.model('Plan', planSchema);
