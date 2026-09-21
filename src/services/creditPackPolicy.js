'use strict';
const paypalCurrencies = new Set('AUD BRL CAD CNY CZK DKK EUR HKD ILS MYR MXN NZD NOK PHP PLN GBP RUB SGD SEK CHF THB USD'.split(' '));
const isoCurrencies = new Set(Intl.supportedValuesOf('currency'));
function validMoney(price, currency) {
  return typeof price === 'number' && Number.isFinite(price) && price > 0 && /^\d+(?:\.\d{1,2})?$/.test(String(price)) &&
    Number.isSafeInteger(Math.round(price * 100)) && isoCurrencies.has(currency) &&
    new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits === 2;
}
function purchasablePack(pack, provider = 'paypal') {
  return provider === 'paypal' && packRejection(pack) === null;
}
function packRejection(pack) {
  if (pack.active !== true) return 'INACTIVE_PACK';
  if (typeof pack.name !== 'string' || !pack.name.trim()) return 'INVALID_NAME';
  if (!/^[A-Z0-9][A-Z0-9_-]{1,79}$/.test(pack.code)) return 'INVALID_CODE';
  if (!Number.isSafeInteger(pack.credits) || pack.credits <= 0) return 'INVALID_CREDITS';
  if (!Number.isSafeInteger(pack.displayOrder) || pack.displayOrder < 0) return 'INVALID_DISPLAY_ORDER';
  if (!paypalCurrencies.has(pack.currency)) return 'UNSUPPORTED_CURRENCY';
  if (!validMoney(pack.price, pack.currency)) return 'INVALID_PRICE';
  if (!Array.isArray(pack.allowedPlans) || !pack.allowedPlans.length ||
      pack.allowedPlans.some(slug => typeof slug !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(slug))) return 'PLAN_SLUG_MISMATCH';
  if (!pack.allowedPlans.some(slug => !['institution', 'custom'].includes(slug))) return 'NO_PERSONAL_PLAN';
  return null;
}
module.exports={validMoney,purchasablePack,packRejection};
