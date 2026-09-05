#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const mongoose = require('mongoose');
const Plan = require('../../src/models/Plan');
const { PayPalClient } = require('../../src/services/paypal/paypalClient.service');
const { provisionSandboxPlans } = require('../../src/services/paypal/paypalProvisioning.service');
const { getPaypalConfig, getPaypalPlanVariableName, validatePaypalConfig } = require('../../src/config/paypal');

const manifestPath = path.join(__dirname, '..', '..', '.paypal', 'paypal-sandbox-manifest.json');

function readManifest() {
  try { return JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    throw Object.assign(new Error('The PayPal sandbox manifest is invalid'), { code: 'PAYPAL_MANIFEST_INVALID' });
  }
}

function writeManifest(manifest) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const temporary = `${manifestPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, manifestPath);
}

function printResult(result, environment = process.env) {
  console.log('\nPayPal Sandbox Provisioning\n');
  console.log(`Mode: ${result.dryRun ? 'DRY RUN (no PayPal resources created)' : 'PROVISIONED'}`);
  console.log('\nProduct');
  console.log(`${getPaypalConfig(environment).variables.productId}=${result.product.productId || '(would create or discover)'}`);
  console.log('\nPlans');
  for (const plan of result.plans) {
    console.log(`${plan.planKey.toUpperCase()} ${plan.interval}: ${plan.price} ${plan.currency} -> ${plan.planId || '(would create or discover)'} [${plan.action}]`);
  }
  console.log('\nEnvironment variables to configure:');
  if (result.product.productId) console.log(`${getPaypalConfig(environment).variables.productId}=${result.product.productId}`);
  for (const plan of result.plans) if (plan.planId) {
    console.log(`${getPaypalPlanVariableName(plan.planKey, plan.interval, environment)}=${plan.planId}`);
  }
  if (!result.dryRun) console.log(`\nNon-secret manifest written: ${manifestPath}`);
}

async function run({
  environment = process.env,
  dryRun = process.argv.slice(2).includes('--dry-run'),
  PlanModel = Plan,
  connect = (uri) => mongoose.connect(uri),
  disconnect = () => mongoose.disconnect(),
  clientFactory = (env) => new PayPalClient({ environmentVariables: env })
} = {}) {
  validatePaypalConfig(environment, { purpose: 'provisioning' });
  const mongoUri = String(environment.MONGO_URI || '').trim();
  if (!mongoUri) throw Object.assign(new Error('Missing required env var: MONGO_URI'), { code: 'PAYPAL_PROVISIONING_DB_CONFIG_INVALID' });
  await connect(mongoUri);
  let plans;
  try {
    plans = await PlanModel.find({ isActive: true }).sort({ displayOrder: 1, slug: 1 }).lean();
  } finally {
    await disconnect();
  }
  const client = dryRun ? null : clientFactory(environment);
  const result = await provisionSandboxPlans({
    client, plans, environment, manifest: readManifest(), dryRun,
    saveManifest: async (manifest) => writeManifest(manifest)
  });
  printResult(result, environment);
  return result;
}

if (require.main === module) run().catch(async (error) => {
  try { await mongoose.disconnect(); } catch {}
  const code = error?.code || 'PAYPAL_PROVISIONING_FAILED';
  console.error(`${code}: ${error?.message || 'PayPal Sandbox provisioning failed'}`);
  if (error?.details && code === 'PAYPAL_PLAN_PRICE_MISMATCH') {
    console.error(JSON.stringify(error.details, null, 2));
  }
  process.exitCode = 1;
});

module.exports = { manifestPath, printResult, readManifest, run, writeManifest };
