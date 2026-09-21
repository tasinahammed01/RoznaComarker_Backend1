const { configuredProviderName } = require('../src/services/payments/paymentProvider.service');
test.each([undefined, '', 'stripe', 'other'])('fails closed for provider %s', PAYMENT_PROVIDER => {
  expect(() => configuredProviderName({ PAYMENT_PROVIDER })).toThrow('explicitly be paypal');
});
test('explicit PayPal resolves in production', () => {
  expect(configuredProviderName({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'paypal' })).toBe('paypal');
});
test('legacy Stripe client cannot execute', () => {
  expect(() => require('../src/services/stripe.service').getStripe()).toThrow('PayPal-only');
});
