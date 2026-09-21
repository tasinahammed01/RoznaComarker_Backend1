#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { REQUIRED_PLAN_MAPPINGS, getPaypalConfig, getPaypalPlanId, validatePaypalConfig } = require('../../src/config/paypal');
const { PayPalClient, redact } = require('../../src/services/paypal/paypalClient.service');

function yes(value) { return value ? 'PRESENT' : 'MISSING'; }

async function run({ environment = process.env, authenticate = process.argv.includes('--auth'), output = console,
  clientFactory = (env) => new PayPalClient({ environmentVariables: env, logger: {} }) } = {}) {
  const config = getPaypalConfig(environment);
  output.log('PayPal configuration readiness');
  output.log(`PAYMENT_PROVIDER: ${environment.PAYMENT_PROVIDER === 'paypal' ? 'PRESENT' : 'MISMATCH'}`);
  output.log(`PAYPAL_ENV: ${environment.PAYPAL_ENV ? 'PRESENT' : 'MISSING'}`);
  output.log(`PAYPAL_LIVE_ENABLED: ${String(environment.PAYPAL_LIVE_ENABLED).toLowerCase() === 'true' ? 'PRESENT' : 'MISSING'}`);
  try { require('../../src/config/paypal').getPaypalRedirectUrls('subscription', environment); output.log('Trusted frontend return URL: PRESENT'); } catch { output.log('Trusted frontend return URL: MISMATCH'); }
  output.log(`Environment: ${config.environment}`);
  output.log(`Live monetary operations enabled: ${yes(config.liveEnabled)}`);
  output.log(`Client ID configured (${config.variables.clientId}): ${yes(config.clientId)}`);
  output.log(`Client Secret configured (${config.variables.clientSecret}): ${yes(config.clientSecret)}`);
  output.log(`Webhook ID configured (${config.variables.webhookId}): ${yes(config.webhookId)}`);
  output.log(`Product ID configured (${config.variables.productId}): ${yes(config.productId)}`);
  output.log('Plans:');
  for (const [planKey, interval] of REQUIRED_PLAN_MAPPINGS) {
    const mapping = getPaypalPlanId(planKey, interval, environment);
    output.log(`  ${planKey}_${interval === 'yearly' ? 'annual' : interval} (${mapping.variable}): ${yes(mapping.value)}`);
  }
  try { validatePaypalConfig(environment, { purpose: 'check' }); }
  catch (error) { output.log(`Configuration inventory: FAILED (${redact(error?.message)})`); return { ok: false, authenticated: false }; }
  const purpose = authenticate ? 'authentication' : 'runtime';
  try { validatePaypalConfig(environment, { purpose }); output.log(`Configuration validation (${purpose}): OK`); }
  catch (error) { output.log(`Configuration validation: FAILED (${redact(error?.message)})`); return { ok: false, authenticated: false }; }
  if (!authenticate) { output.log('API authentication: SKIPPED (pass --auth for a read-only OAuth check)'); return { ok: true, authenticated: false }; }
  try {
    await clientFactory(environment).getAccessToken();
    output.log('API authentication: OK'); return { ok: true, authenticated: true };
  } catch (error) {
    output.log(`API authentication: FAILED (${redact(error?.message)})`); return { ok: false, authenticated: false };
  }
}

if (require.main === module) run().then((result) => { if (!result.ok) process.exitCode = 1; })
  .catch((error) => { console.error(redact(error?.message)); process.exitCode = 1; });

module.exports = { run };
