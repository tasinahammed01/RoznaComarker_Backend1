'use strict';

const { getStripe } = require('../stripe.service');
const { PayPalClient } = require('../paypal/paypalClient.service');

class StripePaymentProvider {
  constructor({ clientFactory = getStripe } = {}) { this.name = 'stripe'; this.clientFactory = clientFactory; }
  getClient() { return this.clientFactory(); }
}

class PayPalPaymentProvider {
  constructor({ client, environment = process.env } = {}) {
    this.name = 'paypal';
    this.client = client || new PayPalClient({ environmentVariables: environment });
  }
  getClient() { return this.client; }
}

function configuredProviderName(environment = process.env) {
  const name = String(environment.PAYMENT_PROVIDER || 'stripe').trim().toLowerCase();
  if (!['stripe', 'paypal'].includes(name)) {
    throw Object.assign(new Error('PAYMENT_PROVIDER must be stripe or paypal'), { code: 'PAYMENT_PROVIDER_INVALID' });
  }
  return name;
}

function createPaymentProvider({ environment = process.env, stripeOptions, paypalOptions } = {}) {
  return configuredProviderName(environment) === 'paypal'
    ? new PayPalPaymentProvider({ ...paypalOptions, environment })
    : new StripePaymentProvider(stripeOptions);
}

module.exports = { StripePaymentProvider, PayPalPaymentProvider, configuredProviderName, createPaymentProvider };
