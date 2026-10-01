'use strict';
const { priceForInterval } = require('./paypal/paypalPlanMapping.service');

function planPeriods(plan) {
  if (['free', 'custom', 'institution'].includes(plan.slug)) return [];
  return [['monthly', 'monthly'], ['annual', 'yearly']]
    .filter(([, interval]) => Number(priceForInterval(plan, interval)) > 0)
    .map(([period]) => period);
}

module.exports = { planPeriods };
