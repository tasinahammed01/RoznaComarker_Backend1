'use strict';

const { runtimeContractFingerprint, safeRevision } = require('../src/services/runtimeContractFingerprint.service');
const { compareRuntime, verifyRuntime } = require('../scripts/verify-runtime-contract');

describe('runtime contract fingerprint', () => {
  test('is deterministic, source-owned, frozen, and free of sensitive values', () => {
    const env = { NODE_ENV: 'test', APP_DEPLOYMENT_REVISION: 'release-123', OPENROUTER_API_KEY: 'secret-value',
      MONGO_URI: 'mongodb://private-host/database' };
    const first = runtimeContractFingerprint(env);
    expect(first).toEqual(runtimeContractFingerprint(env));
    expect(first).toMatchObject({ applicationVersion: '1.0.0', environment: 'test', deploymentRevision: 'release-123',
      contracts: { correctionPrompt: 'ai-only-correction-detection-v4', correctionSchema: 'semantic-corrections-v8',
        rubricPrompt: 'semantic-rubric-assessment-v4', rubricSchema: 'semantic-rubric-assessment-json-v4',
        canonicalCorrection: 'canonical-5-ai-only', canonicalEvaluation: 'canonical-evaluation-6-evidence-schema-comments' },
      contractHash: expect.stringMatching(/^[a-f0-9]{16}$/) });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.contracts)).toBe(true);
    expect(JSON.stringify(first)).not.toMatch(/secret-value|private-host/u);
    expect(safeRevision('unsafe revision with spaces')).toBe('local');
  });

  test.each([['correctionSchema', 'old-correction'], ['rubricSchema', 'old-rubric'],
    ['canonicalEvaluation', 'old-evaluation']])('rejects stale %s', (field, value) => {
    const expected = runtimeContractFingerprint({ NODE_ENV: 'test' });
    const running = JSON.parse(JSON.stringify(expected)); running.contracts[field] = value;
    expect(compareRuntime(expected, { success: true, runtime: running })).toMatchObject({ ok: false, code: 'CONTRACT_MISMATCH' });
  });

  test('rejects a stale application version', () => {
    const expected = runtimeContractFingerprint({ NODE_ENV: 'test' });
    expect(compareRuntime(expected, { success: true, runtime: { ...expected, applicationVersion: '0.9.0' } }))
      .toMatchObject({ ok: false, code: 'CONTRACT_MISMATCH' });
  });

  test('passes matching health and distinguishes revision mismatch', () => {
    const expected = runtimeContractFingerprint({ NODE_ENV: 'test', APP_DEPLOYMENT_REVISION: 'release-1' });
    expect(compareRuntime(expected, { success: true, runtime: expected }, 'release-1')).toMatchObject({ ok: true, code: 'MATCH' });
    expect(compareRuntime(expected, { success: true, runtime: expected }, 'release-2')).toMatchObject({ ok: false, code: 'REVISION_MISMATCH' });
  });

  test('fails cleanly when health is unreachable or malformed', async () => {
    const unreachable = await verifyRuntime({ env: { NODE_ENV: 'test' },
      fetchImpl: async () => { throw new Error('contains-secret-that-must-not-escape'); } });
    expect(unreachable).toEqual({ ok: false, code: 'BACKEND_UNREACHABLE', message: 'Backend health endpoint is unreachable.' });
    const malformed = await verifyRuntime({ env: { NODE_ENV: 'test' },
      fetchImpl: async () => ({ ok: true, json: async () => ({ success: true }) }) });
    expect(malformed).toMatchObject({ ok: false, code: 'MALFORMED_HEALTH_RESPONSE' });
    expect(JSON.stringify({ unreachable, malformed })).not.toContain('contains-secret');
  });
});
