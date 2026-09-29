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
module.exports = { fail, minor, money, prorate };
