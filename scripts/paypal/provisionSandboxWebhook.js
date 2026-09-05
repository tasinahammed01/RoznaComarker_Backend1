#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { PayPalClient } = require('../../src/services/paypal/paypalClient.service');
const { getPaypalConfig, validatePaypalConfig } = require('../../src/config/paypal');

const EVENTS = ['BILLING.SUBSCRIPTION.CREATED', 'BILLING.SUBSCRIPTION.ACTIVATED', 'BILLING.SUBSCRIPTION.UPDATED',
  'BILLING.SUBSCRIPTION.CANCELLED', 'BILLING.SUBSCRIPTION.SUSPENDED', 'BILLING.SUBSCRIPTION.EXPIRED',
  'BILLING.SUBSCRIPTION.PAYMENT.FAILED', 'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.REFUNDED',
  'PAYMENT.CAPTURE.REVERSED'];

function names(webhook) { return new Set((webhook?.event_types || []).map((item) => item.name)); }
function exactEvents(webhook) { const set = names(webhook); return set.size === EVENTS.length && EVENTS.every((name) => set.has(name)); }

function publicWebhookUrl(environment) {
  let url;
  try { url = new URL(String(environment.PAYPAL_WEBHOOK_URL || '')); }
  catch { throw new Error('PAYPAL_WEBHOOK_URL must be a public HTTPS URL'); }
  if (url.protocol !== 'https:' || url.username || url.password
    || ['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error('PAYPAL_WEBHOOK_URL must be a public HTTPS URL');
  }
  return url;
}

async function run({ environment = process.env, client, output = console } = {}) {
  validatePaypalConfig(environment, { purpose: 'webhookProvisioning' });
  const url = publicWebhookUrl(environment);
  const paypalClient = client || new PayPalClient({ environmentVariables: environment });
  const list = await paypalClient.listWebhooks();
  const sameUrl = (list?.webhooks || []).filter((item) => item.url === url.toString());
  const exact = sameUrl.filter(exactEvents);
  if (exact.length > 1 || (sameUrl.length && exact.length !== 1)) throw new Error('PAYPAL_WEBHOOK_AMBIGUOUS: conflicting webhook registrations exist');
  const webhook = exact[0] || await paypalClient.createWebhook({ url: url.toString(), event_types: EVENTS.map((name) => ({ name })) },
    'roznahub-paypal-subscriptions-webhook-v1');
  if (!webhook?.id) throw new Error('PayPal did not return a Webhook ID');
  output.log('PayPal Sandbox Webhook');
  output.log(`${getPaypalConfig(environment).variables.webhookId}=${webhook.id}`);
  output.log(`PAYPAL_WEBHOOK_URL=${url.toString()}`);
  output.log(`EVENT_COUNT=${EVENTS.length}`);
  return webhook;
}

if (require.main === module) run().catch((error) => {
  console.error(error?.message || 'PayPal webhook provisioning failed'); process.exitCode = 1;
});

module.exports = { EVENTS, exactEvents, publicWebhookUrl, run };
