require('dotenv').config({path:'.env'});
const mongoose = require('mongoose');

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    const Plan = require('./src/models/Plan');
    await Plan.deleteMany({});
    console.log('Cleared plans collection');
    await Plan.seedDefaults();
    const free = await Plan.findOne({ name: 'Free', isActive: true });
    console.log('Free plan after manual seed:', !!free);
    if (free) console.log('Free plan limits:', free.limits);
    process.exit(0);
  } catch (e) {
    console.error('Error', e);
    process.exit(1);
  }
})();
