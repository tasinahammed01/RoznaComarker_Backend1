'use strict';
const fail = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
function minor(value) {
  const match = String(value).match(/^(\d{1,9})(?:\.(\d{1,2}))?$/u);
  if (!match) throw fail('BILLING_AMOUNT_INVALID', 'Amount must have at most two decimal places.');
  return Number(BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0')));
}
function money(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) throw fail('BILLING_AMOUNT_INVALID', 'Invalid money amount.');
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}
function prorate(paid, startsAt, endsAt, now) {
  const duration = new Date(endsAt).getTime() - new Date(startsAt).getTime();
  if (!Number.isSafeInteger(duration) || duration <= 0) throw fail('PRORATION_REVIEW_REQUIRED', 'This plan change needs billing review.', 409);
  const remaining = Math.max(0, Math.min(duration, new Date(endsAt).getTime() - now.getTime()));
  // Round unused credit down, never giving more value than was paid.
  return Number(BigInt(paid) * BigInt(remaining) / BigInt(duration));
}
function planMinor(plan, billingPeriod) {
  if (!['monthly', 'annual'].includes(billingPeriod)) throw fail('PLAN_PERIOD_INVALID', 'Billing period is invalid.');
  const variant = /_(monthly|annual)$/.exec(String(plan.slug));
  if (variant && variant[1] !== billingPeriod) throw fail('PLAN_UNAVAILABLE', 'Select an available plan and term.');
  // Separate catalog variants price their own term in price. Combined plans
  // retain distinct price/annualPrice fields; never guess a missing annual price.
  return minor(variant ? plan.price : billingPeriod === 'annual' ? plan.annualPrice : plan.price);
}
module.exports = { fail, minor, money, prorate, planMinor };
