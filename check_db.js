require('dotenv').config({path:'.env'});
const mongoose = require('mongoose');

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Mongo connected');
    const Plan = require('./src/models/Plan');
    const free = await Plan.findOne({ name: 'Free', isActive: true });
    console.log('Free plan found:', !!free);
    if (!free) {
      console.log('Seeding defaults...');
      await Plan.seedDefaults();
      console.log('Free plan after seed:', !!(await Plan.findOne({ name: 'Free', isActive: true })));
    } else {
      console.log('Free plan limits:', free.limits);
    }
    process.exit(0);
  } catch (e) {
    console.error('DB error', e);
    process.exit(1);
  }
})();
