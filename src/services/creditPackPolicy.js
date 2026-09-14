'use strict';
const paypalCurrencies = new Set('AUD BRL CAD CNY CZK DKK EUR HKD ILS MYR MXN NZD NOK PHP PLN GBP RUB SGD SEK CHF THB USD'.split(' '));
const isoCurrencies = new Set(Intl.supportedValuesOf('currency'));
function validMoney(price, currency) {
  return typeof price === 'number' && Number.isFinite(price) && price > 0 && /^\d+(?:\.\d{1,2})?$/.test(String(price)) &&
    Number.isSafeInteger(Math.round(price * 100)) && isoCurrencies.has(currency) &&
    new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits === 2;
}
function purchasablePack(pack, provider = 'paypal') {
  return provider === 'paypal' && pack.active === true && typeof pack.name === 'string' && pack.name.trim() &&
    /^[A-Z0-9][A-Z0-9_-]{1,79}$/.test(pack.code) && Number.isSafeInteger(pack.credits) && pack.credits > 0 &&
    Number.isSafeInteger(pack.displayOrder) && pack.displayOrder >= 0 && Array.isArray(pack.allowedPlans) && pack.allowedPlans.length > 0 &&
    validMoney(pack.price,pack.currency) && paypalCurrencies.has(pack.currency);
}
module.exports={validMoney,purchasablePack};
