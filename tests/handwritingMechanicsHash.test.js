'use strict';
// D3: with the check off, or for typed essays, the correction source hash and the runtime contract fingerprint stay byte-identical to the
// values recorded on the base commit (b439c267) before any S3 code existed. Essays in flight at deploy are therefore unaffected.
const f = require('./helpers/handwritingMechanicsHashFixture');
const pipeline = require('../src/services/canonicalCorrectionsPipeline.service');
const { runtimeContractFingerprint } = require('../src/services/runtimeContractFingerprint.service');
const stage = require('../src/services/handwritingMechanics/stage.service');

const hashFor = (doc, env) => pipeline.buildCorrectionSourceHash({ ...f.inputs, doc, env });

test.each([
  ['flag off, typed essay', f.typedDoc, f.envOff],
  ['flag off, exact-source essay', f.exactDoc, f.envOff],
  ['flag on, typed essay', f.typedDoc, f.envOn],
  ['flag explicitly false, exact-source essay', f.exactDoc, { ...f.envOff, HANDWRITING_MECHANICS_CHECK_ENABLED: 'false' }]
])('%s: correction source hash equals the base value', (_name, doc, env) => {
  expect(hashFor(doc, env)).toBe(f.BASE_CORRECTION_SOURCE_HASH);
});

test('a call without the essay (old callers) keeps the base value', () => {
  expect(pipeline.buildCorrectionSourceHash({ ...f.inputs })).toBe(f.BASE_CORRECTION_SOURCE_HASH);
});

test('flag on, exact-source essay: a new hash, which follows the result-changing settings only', () => {
  const on = hashFor(f.exactDoc, f.envOn);
  expect(on).not.toBe(f.BASE_CORRECTION_SOURCE_HASH);
  expect(hashFor(f.exactDoc, { ...f.envOn, HANDWRITING_MECHANICS_CONCURRENCY: '2', HANDWRITING_MECHANICS_WAIT_AFTER_CORRECTION_MS: '100' })).toBe(on);
  expect(hashFor(f.exactDoc, { ...f.envOn, HANDWRITING_MECHANICS_LINES_PER_CROP: '3' })).not.toBe(on);
  expect(hashFor(f.exactDoc, { ...f.envOn, HANDWRITING_MECHANICS_MIN_CONFIDENCE: '0.9' })).not.toBe(on);
  expect(stage.hashIdentity(f.exactDoc, f.envOn)).not.toBeNull();
});

test('runtime contract fingerprint: unchanged while off; carries the check identity when on', () => {
  expect(runtimeContractFingerprint(f.envOff).contractHash).toBe(f.BASE_CONTRACT_HASH);
  expect(runtimeContractFingerprint({ ...f.envOff, HANDWRITING_MECHANICS_CHECK_ENABLED: 'false' }).contractHash).toBe(f.BASE_CONTRACT_HASH);
  expect(runtimeContractFingerprint(f.envOff).contracts).not.toHaveProperty('handwritingMechanicsCheck');
  const on = runtimeContractFingerprint(f.envOn);
  expect(on.contractHash).not.toBe(f.BASE_CONTRACT_HASH);
  expect(on.contracts.handwritingMechanicsCheck).toBe('handwriting-mechanics-v1|handwriting-mechanics-prompt-v2|handwriting-mechanics-schema-v3|0.8|1');
});
