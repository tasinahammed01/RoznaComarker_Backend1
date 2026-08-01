'use strict';

const { runtimeContractFingerprint } = require('../src/services/runtimeContractFingerprint.service');

const DEFAULT_URL = 'http://localhost:5000/api/health';
const DEFAULT_TIMEOUT_MS = 5000;

function compareRuntime(expected, health, expectedRevision = '') {
  const runtime = health?.runtime;
  if (!health || health.success !== true || !runtime || typeof runtime !== 'object') {
    return { ok: false, code: 'MALFORMED_HEALTH_RESPONSE', message: 'Runtime health response is malformed.' };
  }
  if (runtime.applicationVersion !== expected.applicationVersion) {
    return { ok: false, code: 'CONTRACT_MISMATCH', message: 'Runtime application version does not match current source.' };
  }
  if (expectedRevision && runtime.deploymentRevision !== expectedRevision) {
    return { ok: false, code: 'REVISION_MISMATCH', message: 'Runtime deployment revision does not match.' };
  }
  const fields = Object.keys(expected.contracts);
  const mismatch = fields.find((field) => runtime.contracts?.[field] !== expected.contracts[field]);
  if (mismatch || runtime.contractHash !== expected.contractHash) {
    return { ok: false, code: 'CONTRACT_MISMATCH',
      message: `Runtime contract does not match current source${mismatch ? ` (${mismatch})` : ''}.` };
  }
  return { ok: true, code: 'MATCH', message: `Runtime contract verified (${expected.contractHash}).` };
}

async function requestHealth(url, { fetchImpl = global.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method: 'GET', signal: controller.signal,
      headers: { accept: 'application/json' } });
    if (!response?.ok) throw new Error(`HTTP_${Number(response?.status) || 0}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

async function verifyRuntime({ env = process.env, fetchImpl = global.fetch } = {}) {
  const url = String(env.RUNTIME_HEALTH_URL || DEFAULT_URL).trim() || DEFAULT_URL;
  const expected = runtimeContractFingerprint(env);
  let health;
  try { health = await requestHealth(url, { fetchImpl }); }
  catch { return { ok: false, code: 'BACKEND_UNREACHABLE', message: 'Backend health endpoint is unreachable.' }; }
  const requiredRevision = String(env.APP_DEPLOYMENT_REVISION || '').trim();
  return compareRuntime(expected, health, requiredRevision);
}

async function main() {
  const result = await verifyRuntime();
  const output = `[verify-runtime] ${result.code}: ${result.message}`;
  (result.ok ? console.log : console.error)(output);
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) void main();

module.exports = { DEFAULT_URL, DEFAULT_TIMEOUT_MS, compareRuntime, requestHealth, verifyRuntime };
