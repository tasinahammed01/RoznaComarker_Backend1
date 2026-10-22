'use strict';
const fs = require('fs');
const path = require('path');
const { root, home, localDirectory, applyEnvironment } = require('./local-shadow/config.cjs');
const sol = require('./local-shadow/sol-verbatim.cjs');
async function main() {
  const source = sol.image();
  const key = require('dotenv').parse(fs.readFileSync(path.join(root, '.env'))).OPENROUTER_API_KEY?.trim();
  if (!key) throw Error('MISSING_OPENROUTER_API_KEY');
  localDirectory(home); localDirectory(path.join(home, 'private')); localDirectory(sol.DIRECTORY);
  if (fs.existsSync(path.join(sol.DIRECTORY, 'attempt.reserved.json'))) throw Error('SOL_ONE_SHOT_ALREADY_CONSUMED');
  if (!process.argv.includes('--run')) {
    console.log(JSON.stringify({ preflight: 'PASS', imagePath: source.file, sha256: source.sha256, bytes: source.bytes.length, mimeType: source.mime, credentialPresent: true, requestedModel: sol.MODEL, ledgerUnused: true, providerCalls: 0 })); return;
  }
  applyEnvironment();
  const network = require('./local-shadow/network.cjs');
  network.install({ realOne: true, imageHash: source.sha256,
    ledger: { reserve: kind => { if (kind !== 'shadow-http') throw Error('SOL_NON_OPENROUTER_REQUEST_FORBIDDEN'); sol.reserve(sol.DIRECTORY, 'http', source); }, auth: () => { throw Error('SOL_GOOGLE_FORBIDDEN'); } } });
  const gateway = require('../src/services/aiGateway.service');
  const result = await sol.run({ source, key, network, directory: sol.DIRECTORY, attempt: gateway.providerAttempt, fetchImpl: global.fetch });
  console.log(JSON.stringify({ status: result.state.status, providerCalls: result.state.providerCalls, requestedModel: sol.MODEL, returnedModel: result.state.returnedModel, errorCode: result.state.errorCode || null }));
  process.exitCode = result.state.status === 'COMPLETE' ? 0 : 1;
}
main().catch(error => { console.error(/^[A-Z0-9_]{1,100}$/.test(error.message || '') ? error.message : 'SOL_LOCAL_FAILURE'); process.exitCode = 1; });
