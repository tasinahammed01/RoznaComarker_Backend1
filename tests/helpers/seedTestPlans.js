const Plan = require('../../src/models/Plan');

async function seedTestPlans() {
  await Plan.create([
    {
      name: 'Free',
      slug: 'free',
      price: 0,
      durationDays: 30,
      billingInterval: 'month',
      billingType: 'monthly',
      isActive: true,
      features: {
        maxClasses: 5,
        maxStudents: 50,
        essayAnalysesPerMonth: 100,
        storageMB: 500
      },
      limits: {
        classes: 5,
        assignments: 20,
        students: 50,
        submissions: 100,
        storageMB: 500
      }
    },
    {
      name: 'Starter Monthly',
      slug: 'starter_monthly',
      price: 9.99,
      durationDays: 30,
      billingInterval: 'month',
      billingType: 'monthly',
      isActive: true,
      popular: true,
      features: {
        maxClasses: 20,
        maxStudents: 500,
        essayAnalysesPerMonth: 1000,
        storageMB: 2048
      },
      limits: {
        classes: 20,
        assignments: 200,
        students: 500,
        submissions: 1000,
        storageMB: 2048
      }
    }
  ]);
}

module.exports = { seedTestPlans };
