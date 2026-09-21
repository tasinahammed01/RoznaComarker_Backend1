'use strict';

const { getStripe } = require('../stripe.service');
const { PayPalClient } = require('../paypal/paypalClient.service');

class StripePaymentProvider {
  constructor({ clientFactory = getStripe } = {}) { this.name = 'stripe'; this.clientFactory = clientFactory; }
  getClient() { throw Object.assign(new Error('Stripe execution is disabled: CoMarker is PayPal-only'), { code: 'PAYMENT_PROVIDER_DISABLED' }); }
}

class PayPalPaymentProvider {
  constructor({ client, environment = process.env } = {}) {
    this.name = 'paypal';
    this.client = client || new PayPalClient({ environmentVariables: environment });
  }
  getClient() { return this.client; }
}

function configuredProviderName(environment = process.env) {
  const name = String(environment.PAYMENT_PROVIDER || '').trim().toLowerCase();
  if (name !== 'paypal') {
    throw Object.assign(new Error('PAYMENT_PROVIDER must explicitly be paypal'), { code: 'PAYMENT_PROVIDER_INVALID' });
  }
  return name;
}

function createPaymentProvider({ environment = process.env, stripeOptions, paypalOptions } = {}) {
  return configuredProviderName(environment) === 'paypal'
    ? new PayPalPaymentProvider({ ...paypalOptions, environment })
    : new StripePaymentProvider(stripeOptions);
}

module.exports = { StripePaymentProvider, PayPalPaymentProvider, configuredProviderName, createPaymentProvider };
