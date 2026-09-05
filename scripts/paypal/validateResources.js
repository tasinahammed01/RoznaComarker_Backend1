#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const mongoose = require('mongoose');
const Plan = require('../../src/models/Plan');
const { validatePaypalConfig } = require('../../src/config/paypal');
const { PayPalClient, redact } = require('../../src/services/paypal/paypalClient.service');
const { validatePayPalResources } = require('../../src/services/paypal/paypalResourceValidation.service');

async function run({ environment = process.env, client, PlanModel = Plan, output = console } = {}) {
  validatePaypalConfig(environment, { purpose: 'resources' });
  let ownsConnection = false;
  if (!client && mongoose.connection.readyState === 0) {
    await mongoose.connect(environment.MONGO_URI); ownsConnection = true;
  }
  try {
    const plans = await PlanModel.find({ isActive: true }).lean();
    const result = await validatePayPalResources({ client: client || new PayPalClient({ environmentVariables: environment, logger: {} }),
      plans, environment });
    output.log(`PayPal ${result.environment} resource validation (read-only)`);
    output.log(`Product: ${result.product.pass ? 'PASS' : `FAIL ${result.product.error.code}`}`);
    for (const item of result.plans) {
      output.log(`${item.planKey}_${item.interval}: ${item.pass ? 'PASS' : `FAIL ${item.error.code}`}`);
    }
    return result;
  } finally { if (ownsConnection) await mongoose.disconnect(); }
}

if (require.main === module) run().then((result) => { if (!result.pass) process.exitCode = 1; })
  .catch((error) => { console.error(redact(error?.message)); process.exitCode = 1; });

module.exports = { run };
