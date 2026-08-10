'use strict';

const { buildCanonicalSubmissionTranscript } = require('../src/utils/ocrTranscriptNormalizer');
const { mapOffsetsToWords } = require('../src/services/correctionCanonical.service');
const { buildCorrectionSourceHash } = require('../src/services/canonicalCorrectionsPipeline.service');
const { scopeCanonicalPages, scopeCanonicalCorrections } = require('../src/services/canonicalCorrectionResponse.service');
const { pendingAnalysisState, resetSubmissionAnalysisState } = require('../src/services/submissionAnalysisLifecycle.service');

function draft(fileId, text, ocrJobId) {
  const words = text.split(' ').map((word, index) => ({
    id: `word_${fileId}_1_${index + 1}`,
    text: word,
    page: 1,
    bbox: { x0: index * 10, y0: 10, x1: index * 10 + 8, y1: 20 }
  }));
  return {
    _id: 'same-submission-id', ocrJobId, files: [fileId], fileOrder: [{ fileId, order: 0 }],
    ocrPages: [{ fileId, fileOrder: 0, pageNumber: 1, pageIndex: 0, text, rawText: text, words }]
  };
}

describe('replacement-draft canonical correction lifecycle', () => {
  test('first submission and replacement draft begin with the same pending analysis contract', () => {
    const first = pendingAnalysisState({ ocrJobId: 'ocr-first', now: new Date('2026-08-10T00:00:00Z') });
    const replacement = {
      writingCorrections: [{ id: 'old' }], correctionStatistics: { total: 1 }, correctionSourceHash: 'old-source',
      semanticStatus: 'completed', semanticAttempt: 2, semanticSourceKey: 'old-semantic',
      evaluationStatus: 'completed', evaluationSourceHash: 'old-source', evaluationJobId: 'old-evaluation',
      evaluationProvider: 'old-provider', evaluationModel: 'old-model', evaluationAttempts: [{ status: 'success' }]
    };
    resetSubmissionAnalysisState(replacement, {
      ocrJobId: 'ocr-replacement', now: new Date('2026-08-11T00:00:00Z')
    });

    expect({ ...replacement, ocrJobId: 'same', ocrUpdatedAt: 'same' })
      .toEqual({ ...first, ocrJobId: 'same', ocrUpdatedAt: 'same' });
    expect(replacement).toMatchObject({
      writingCorrections: [], correctionStatus: 'pending', semanticStatus: 'pending', semanticAttempt: 0,
      evaluationStatus: 'pending'
    });
    for (const field of ['correctionStatistics', 'correctionSourceHash', 'semanticSourceKey',
      'evaluationSourceHash', 'evaluationJobId', 'evaluationProvider', 'evaluationModel', 'evaluationAttempts']) {
      expect(replacement[field]).toBeUndefined();
    }
  });

  test('same normalized OCR text remains byte-identical while layout source identity remains draft-specific', () => {
    const first = draft('draft-1-file', 'The exact same essay text.', 'ocr-job-1');
    const second = draft('draft-2-file', 'The exact same essay text.', 'ocr-job-2');
    const firstTranscript = buildCanonicalSubmissionTranscript(first);
    const secondTranscript = buildCanonicalSubmissionTranscript(second);

    expect(Buffer.from(firstTranscript.text)).toEqual(Buffer.from(secondTranscript.text));
    expect(buildCorrectionSourceHash({ transcript: firstTranscript.text, pages: firstTranscript.pages }))
      .not.toBe(buildCorrectionSourceHash({ transcript: secondTranscript.text, pages: secondTranscript.pages }));
  });

  test('Draft 2 creates new file, word-anchor, and source-hash identities under the same submission id', () => {
    const first = draft('draft-1-file', 'Draft one has errors', 'ocr-job-1');
    const second = draft('draft-2-file', 'Draft two has different errors', 'ocr-job-2');
    const firstTranscript = buildCanonicalSubmissionTranscript(first);
    const secondTranscript = buildCanonicalSubmissionTranscript(second);
    const firstAnchor = mapOffsetsToWords({ startChar: 0, endChar: 5 }, firstTranscript.wordSpans);
    const secondAnchor = mapOffsetsToWords({ startChar: 0, endChar: 5 }, secondTranscript.wordSpans);
    const firstHash = buildCorrectionSourceHash({ transcript: firstTranscript.text, pages: firstTranscript.pages });
    const secondHash = buildCorrectionSourceHash({ transcript: secondTranscript.text, pages: secondTranscript.pages });

    expect(first._id).toBe(second._id);
    expect(secondTranscript.pages.map((page) => page.fileId)).toEqual(['draft-2-file']);
    expect(secondAnchor.fileId).toBe('draft-2-file');
    expect(secondAnchor.wordIds).toEqual(expect.arrayContaining([expect.stringContaining('draft-2-file')]));
    expect(secondAnchor.bboxList.length).toBeGreaterThan(0);
    expect(secondAnchor.wordIds).not.toEqual(firstAnchor.wordIds);
    expect(secondHash).not.toBe(firstHash);
  });

  test('file-scoped responses retain only current Draft 2 pages and corrections', () => {
    const pages = [{ fileId: 'draft-1-file' }, { fileId: { _id: 'draft-2-file' } }];
    const corrections = [
      { id: 'old', fileId: 'draft-1-file', wordIds: ['old-word'] },
      { id: 'current', fileId: { _id: 'draft-2-file' }, wordIds: ['draft-2-word'] }
    ];
    expect(scopeCanonicalPages(pages, 'draft-2-file')).toEqual([pages[1]]);
    expect(scopeCanonicalCorrections(corrections, 'draft-2-file')).toEqual([corrections[1]]);
  });
});
