'use strict';
const { buildCanonicalSubmissionTranscript } = require('../src/utils/ocrTranscriptNormalizer');
const { buildCanonicalCorrectionRenderModels } = require('../src/services/canonicalCorrectionRender.service');
function fixture(fileId = 'current-file') {
  const page = { fileId, pageNumber: 1, coordinateSpace: 'display-image', width: 800, height: 600,
    words: ['blindely', 'when', 'blindely'].map((text, i) => ({ id: `word_${fileId}_1_${i + 1}`,
      text, paragraphIndex: 1, bbox: { x: 10 + i * 20, y: 20, w: 12, h: 4 } })) };
  const submission = { _id: 'synthetic-run', files: [fileId], ocrPages: [page], ocrJobId: 'current-run' };
  const canonical = buildCanonicalSubmissionTranscript(submission);
  const correction = { fileId, page: 1, source: 'AI', symbol: 'SP', quotedText: 'blindely',
    startChar: canonical.wordSpans[0].start, endChar: canonical.wordSpans[0].end,
    wordIds: [page.words[0].id] };
  return { page, submission, canonical, correction };
}
function render(f, correction) {
  return buildCanonicalCorrectionRenderModels([correction], f.canonical, [f.page], { submission: f.submission })[0].renderTarget;
}
test('foreign canonical IDs never fall back onto a newly uploaded file at the same offsets', () => {
  const f = fixture();
  expect(render(f, { ...f.correction, wordIds: ['word_deleted-file_1_1'] }).source).toBe('none');
});
test('a prior OCR run cannot reuse identical numeric-position IDs even when the word text matches', () => {
  const f = fixture();
  expect(render(f, { ...f.correction, ocrRunId: 'old-run' }).source).toBe('none');
});
test('a stale correction timestamp blocks geometry even when a same-file ID still exists', () => {
  const f = fixture(); f.submission.ocrUpdatedAt = new Date(2000); f.submission.correctionUpdatedAt = new Date(1000);
  expect(render(f, f.correction).source).toBe('none');
});
test('same-paragraph proximity without exact current offsets grants no marker authority', () => {
  const f = fixture(); f.page.words.pop();
  f.canonical = buildCanonicalSubmissionTranscript(f.submission);
  const correction = { ...f.correction, wordIds: [f.page.words[1].id], startChar: undefined, endChar: undefined };
  expect(render(f, correction).source).toBe('none');
});
test('valid current IDs retain both occurrences as independent markers', () => {
  const f = fixture();
  for (const i of [0, 2]) {
    const span = f.canonical.wordSpans[i];
    expect(render(f, { ...f.correction, ocrRunId: 'current-run', wordIds: [f.page.words[i].id],
      startChar: span.start, endChar: span.end }).source).toBe('wordIds');
  }
});
test('verified exact current offsets can repair a wrong current-run target without proximity guessing', () => {
  const f = fixture();
  const target = render(f, { ...f.correction, wordIds: [f.page.words[1].id] });
  expect(target.source).toBe('wordIds'); expect(target.wordIds).toEqual([f.page.words[0].id]);
});
test('repeated identical spelling tokens follow exact evidence offsets rather than the other matching occurrence', () => {
  const f = fixture();
  const target = render(f, { ...f.correction, wordIds: [f.page.words[2].id] });
  expect(target.wordIds).toEqual([f.page.words[0].id]);
});
test('explanation wording and its quoted phrases never change a verified spelling target', () => {
  const f = fixture();
  const targets = ["'blindely' should be 'blindly'", "The 'adverb' needs a spelling correction.", "Use 'blindly' here."]
    .map(message => render(f, { ...f.correction, message }));
  targets.forEach(target => expect(target).toEqual(targets[0]));
  expect(render(f, { ...f.correction, quotedText: '', message: "'blindely' should change", startChar: undefined, endChar: undefined }).source).toBe('none');
  expect(render(f, { ...f.correction, quotedText: f.canonical.text, startChar: 0, endChar: f.canonical.text.length,
    wordIds: f.page.words.map(w => w.id) }).source).toBe('none');
});
module.exports = { fixture, render };
