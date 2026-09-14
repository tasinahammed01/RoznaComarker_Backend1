'use strict';
const identity = require('../src/utils/assessmentInputIdentity');
const pipeline = require('../src/services/canonicalCorrectionsPipeline.service');
const evaluation = require('../src/services/canonicalEvaluation.service');
const { evaluationPolicyHash } = require('../src/services/teacherEvaluationPolicy.service');

describe('content identity release gate', () => {
  const input = { transcript: 'My essay.', fileContentIdentity: 'ordered-image-bytes',
    pages: [{ fileId: 'old-mongo-id', pageIndex: 0, text: 'My essay.' }],
    assignment: { title: 'Essay', description: 'Write an essay.' }, legend: { version: 'v1', contentHash: 'legend' } };
  test('transient file IDs and assignment metadata do not change correction identity', () => {
    expect(pipeline.buildCorrectionSourceHash(input)).toBe(pipeline.buildCorrectionSourceHash({ ...input,
      pages: [{ ...input.pages[0], fileId: 'new-mongo-id' }],
      assignment: { _id: 'another-id', title: 'Essay', instructions: 'Write an essay.', updatedAt: new Date() } }));
  });
  test('rubric changes preserve correction identity', () => {
    expect(pipeline.buildCorrectionSourceHash(input)).toBe(pipeline.buildCorrectionSourceHash({ ...input,
      assignment: { ...input.assignment, rubric: { criteria: [{ weight: 100 }] } } }));
  });
  test.each([
    { transcript: 'Changed essay.' }, { fileContentIdentity: 'changed-image-bytes' },
    { assignment: { title: 'A different task' } }, { transcriptLayoutVersion: 'future-layout' },
    { legend: { version: 'v2', contentHash: 'changed-legend' } }
  ])('changed content/context/version invalidates correction identity: %j', change => {
    expect(pipeline.buildCorrectionSourceHash({ ...input, ...change })).not.toBe(pipeline.buildCorrectionSourceHash(input));
  });
  test('ordered page content is significant but location IDs are not', () => {
    const pages = [{ text: 'one' }, { text: 'two' }];
    expect(identity.correctionInputHash({ ...input, pages })).not.toBe(identity.correctionInputHash({ ...input, pages: [...pages].reverse() }));
  });
  test('rubric and teacher policy invalidate only the evaluation identity', () => {
    const sourceHash = pipeline.buildCorrectionSourceHash(input);
    const context = { sourceHash, rubricHash: 'rubric-one', policyHash: evaluationPolicyHash(null), contextHash: 'context' };
    const original = evaluation.analysisInputHash(context);
    expect(evaluation.analysisInputHash({ ...context, rubricHash: 'rubric-two' })).not.toBe(original);
    expect(evaluation.analysisInputHash({ ...context, policyHash: evaluationPolicyHash({ strictness: 'strict' }) })).not.toBe(original);
    expect(pipeline.buildCorrectionSourceHash(input)).toBe(sourceHash);
  });
  test('evaluation algorithm versions are significant', () => {
    const input = { sourceHash: 'source', rubricHash: 'rubric', policyHash: 'policy', contextHash: 'context' };
    expect(identity.evaluationInputHash({ ...input, versions: { prompt: 'v1' } }))
      .not.toBe(identity.evaluationInputHash({ ...input, versions: { prompt: 'v2' } }));
  });
  test('canonical fingerprints do not use File IDs as an ordering tie-breaker', () => {
    const { canonicalFingerprint } = require('../src/services/correctionCanonical.service');
    const first = [{ fileId: 'a', page: 1, startChar: 0, endChar: 2, symbol: 'AGR', quotedText: 'is' },
      { fileId: 'z', page: 1, startChar: 0, endChar: 2, symbol: 'T', quotedText: 'is' }];
    expect(canonicalFingerprint(first, 'source')).toBe(canonicalFingerprint(first.map((item, i) => ({ ...item,
      fileId: i ? 'a-new' : 'z-new', id: `new-${i}` })), 'source'));
  });
});
