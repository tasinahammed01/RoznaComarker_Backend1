const Stripe = require('stripe');

let client;

function getStripe() {
  const key = String(process.env.STRIPE_SECRET_KEY || '').trim();
  if (!key) {
    const error = new Error('Stripe is not configured');
    error.statusCode = 503;
    throw error;
  }
  if (!client) client = new Stripe(key);
  return client;
}

function getFrontendUrl() {
  const value = String(process.env.FRONTEND_URL || '').trim().replace(/\/+$/, '');
  if (!value) {
    const error = new Error('FRONTEND_URL is not configured');
    error.statusCode = 503;
    throw error;
  }
  return value;
}

module.exports = { getStripe, getFrontendUrl };
