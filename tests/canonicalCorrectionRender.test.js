'use strict';
const { buildCanonicalCorrectionRenderModels } = require('../src/services/canonicalCorrectionRender.service');
const { bindCorrections } = require('../src/services/correctionEvidenceIdentity.service');
const { normalizeCorrection } = require('../src/services/correctionCanonical.service');
const { defaultLegend } = require('../src/services/writingCorrections.service');
function fixture() {
  const text = 'She chose freedom.\nShe felt lost.';
  const spans = [...text.matchAll(/\S+/g)].map((match, index) => ({ wordId: 'w' + index, fileId: 'f', page: 1,
    start: match.index, end: match.index + match[0].length, word: { text: match[0] },
    bbox: { x0: 5 + index * 10, y0: 10, x1: 12 + index * 10, y1: 14 } }));
  const page = { fileId: 'f', pageNumber: 1, startChar: 0, endChar: text.length, text,
    words: spans.map(span => ({ id: span.wordId, text: span.word.text, bbox: span.bbox })) };
  const canonical = { text, pages: [page], wordSpans: spans };
  const submission = { _id: 'submission', ocrJobId: 'ocr-current', ocrPages: [page] };
  const correction = normalizeCorrection({ symbol: 'TA', category: 'CONTENT', quotedText: text, suggestedText: '',
    correctionKind: 'global', startChar: 0, endChar: text.length }, text, spans, defaultLegend(), 'AI');
  return { canonical, submission, correction };
}
test('accepted TA final exact offsets/IDs outrank stale originalText and joined OCR word text', () => {
  const { canonical, submission, correction } = fixture();
  const bound = bindCorrections([{ ...correction, originalText: 'A stale model-proposed quote', wordIds: ['w5'] }], canonical, submission);
  const [result] = buildCanonicalCorrectionRenderModels(bound, canonical, [], { submission });
  expect(result.renderTarget.source).toBe('wordIds');
  expect(result.renderTarget.wordIds).toEqual(canonical.wordSpans.map(span => span.wordId));
  expect(result.renderTarget.boxes).toHaveLength(canonical.wordSpans.length);
  expect(bound[0].originalText).toBe('A stale model-proposed quote');
  expect(bound[0].wordIds).toEqual(['w5']); // Response-only repair; persisted evidence is immutable.
});
test.each(['foreign', 'stale-run', 'nonliteral-quote'])('final-target mapping still rejects %s evidence', kind => {
  const { canonical, submission, correction } = fixture();
  const [bound] = bindCorrections([correction], canonical, submission);
  if (kind === 'foreign') bound.wordIds = ['another-file-word'];
  if (kind === 'stale-run') bound.ocrRunId = 'ocr-old';
  if (kind === 'nonliteral-quote') bound.quotedText = 'She chooses freedom.';
  const [result] = buildCanonicalCorrectionRenderModels([bound], canonical, [], { submission });
  expect(result.renderTarget.source).toBe('none'); expect(result.renderTarget.boxes).toEqual([]);
});
