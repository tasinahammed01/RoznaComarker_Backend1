'use strict';
const PaymentCheckoutAttempt = require('../models/PaymentCheckoutAttempt');

let verifiedDatabase;
async function verifyCheckoutIndex() {
  const database = PaymentCheckoutAttempt.db.db;
  if (verifiedDatabase === database && database) return;
  const indexes = await PaymentCheckoutAttempt.collection.indexes();
  if (!indexes.some(index => index.unique === true && index.key.activeOperationKey === 1 &&
      Object.keys(index.key).length === 1 && index.partialFilterExpression?.activeOperationKey?.$type === 'string')) {
    throw Object.assign(new Error('Checkout operation index must be deployed before accepting payments'),
      { code: 'PAYMENT_INDEX_REQUIRED', statusCode: 503 });
  }
  verifiedDatabase = database;
}
module.exports = { verifyCheckoutIndex };
