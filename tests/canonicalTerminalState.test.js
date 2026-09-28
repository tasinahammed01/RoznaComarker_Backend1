'use strict';

jest.mock('../src/services/canonicalDetailedFeedback.service', () => ({
  isStructuredDetailedFeedback: jest.fn(() => false)
}));

const { buildCanonicalResultState } = require('../src/services/canonicalResultState.service');

describe('canonical terminal state reliability', () => {
  test('OCR failure is terminal and cannot advertise active processing forever', () => {
    const state = buildCanonicalResultState({ submission: {
      ocrStatus: 'failed', ocrErrorCode: 'OCR_PROVIDER_AUTH', correctionStatus: 'pending',
      semanticStatus: 'pending', evaluationStatus: 'pending'
    } });
    expect(state).toMatchObject({ ocrStatus: 'failed', ocrErrorCode: 'OCR_PROVIDER_AUTH',
      correctionStatus: 'failed', semanticStatus: 'failed', evaluationStatus: 'blocked',
      processingActive: false, automaticPollingAllowed: false, terminal: true });
  });

  test('partial OCR is terminal when no correction job remains active', () => {
    const state = buildCanonicalResultState({ submission: {
      ocrStatus: 'completed', correctionStatus: 'partial', correctionError: 'OCR_PARTIAL',
      semanticStatus: 'failed', semanticErrorCode: 'OCR_PARTIAL', evaluationStatus: 'blocked'
    } });
    expect(state).toMatchObject({ correctionStatus: 'partial', semanticStatus: 'failed',
      evaluationStatus: 'blocked', processingActive: false, automaticPollingAllowed: false, terminal: true });
  });
});
