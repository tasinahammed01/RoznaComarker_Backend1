'use strict';
// "[?]" is what the Gemini reader writes for a word it cannot read at all. It is the reader's mark, not the student's writing, so it can never count as an error.
const semantic = require('../src/services/semanticWritingCorrections.service');
const verbatim = require('../src/services/gptVisionExact/verbatimReader');
const { alignGeometry } = require('../src/services/gptVisionExact/alignment');
const { buildSubmissionFeedbackReportViewModel } = require('../src/pdf/sample/submissionFeedbackReportViewModel');
const { renderSubmissionFeedbackReportHtml } = require('../src/pdf/submissionFeedbackReportTemplate');
const { defaultLegend } = require('../src/services/writingCorrections.service');

const transcript = 'She go to the [?] every day. It was a very long day and she was tired from the [?] but happy.';
const spans = [...transcript.matchAll(/\S+/gu)].map((m, i) => ({ wordId: `w${i}`, start: m.index, end: m.index + m[0].length, text: m[0], fileId: 'f', page: 1 }));
const legend = semantic.compactSemanticLegend(defaultLegend());
const finding = (symbol, category, quotedText, extra = {}) => ({ symbol, category, quotedText, occurrence: 0, confidence: 0.99, message: 'A message.', suggestedText: 'better', correctionKind: 'localized', ...extra });
const validate = list => semantic.validateCorrections(list, { transcript, legend, spans, env: {}, transcriptComplete: true });

describe('the placeholder in error detection', () => {
  test('a finding on the placeholder alone is not a student error', () => {
    const result = validate([finding('SP', 'MECHANICS', '[?]'), finding('AGR', 'GRAMMAR', 'She go')]);
    expect(result.corrections.map(c => c.quotedText)).toEqual(['She go']);
    expect(result.diagnostics.unreadableWordFindingCount).toBe(1);
  });
  test('neither is a short finding that includes it, with or without punctuation around it', () => {
    const result = validate([finding('PREP', 'GRAMMAR', 'to the [?]'), finding('WC', 'VOCABULARY', 'the [?] every'), finding('AGR', 'GRAMMAR', 'She go')]);
    expect(result.corrections.map(c => c.quotedText)).toEqual(['She go']);
  });
  test('a reply with only such findings is an empty result, not a failed analysis', () => {
    const result = validate([finding('SP', 'MECHANICS', '[?]')]);
    expect(result.corrections).toEqual([]);
    expect(result.diagnostics.unreadableWordFindingCount).toBe(1);
  });
  test('a sentence-level finding stays: it is about the sentence, not about that word', () => {
    const quote = 'She go to the [?] every day.';
    const byLength = validate([finding('AGR', 'GRAMMAR', quote)]);
    expect(byLength.corrections.map(c => c.quotedText)).toEqual([quote]);
    const byCode = validate([finding('FRAG', 'GRAMMAR', 'the [?] every day.')]);
    expect(byCode.corrections.map(c => c.symbol)).toEqual(['FRAG']);
    const organization = validate([finding('COH', 'ORGANIZATION', 'the [?] every day.')]);
    expect(organization.corrections.map(c => c.symbol)).toEqual(['COH']);
  });
  test('without a placeholder nothing changes, and the failure for wholly invalid replies stays', () => {
    const result = validate([finding('AGR', 'GRAMMAR', 'She go')]);
    expect(result.corrections).toHaveLength(1);
    expect(result.diagnostics.unreadableWordFindingCount).toBe(0);
    expect(() => validate([finding('AGR', 'GRAMMAR', 'Not in this text')])).toThrow();
  });
});

describe('the placeholder on its way through', () => {
  const page = { words: ['She', 'went', 'to', 'tho', 'smudge', 'every', 'day'].map((text, x) => ({ id: `g${x}`, text, page: 1, bbox: { x0: 50 + x * 110, y0: 100, x1: 150 + x * 110, y1: 150 } })) };
  test('the reader keeps it as text, and uncertain may name it', () => {
    const { wire, review } = verbatim.convert(JSON.stringify({ version: verbatim.SCHEMA_VERSION, name_present: false, question_lines: [], struck_through: [],
      answer_lines: ['She went to [?] every day'], uncertain: [{ line: 0, word: '[?]' }] }));
    expect(JSON.parse(wire).physicalLines[0].segments[0].text).toBe('She went to [?] every day');
    expect(review.uncertain).toEqual([{ line: 0, word: '[?]' }]);
  });
  test('box alignment keeps the text, and never makes two placeholders a pair with one word', () => {
    const text = 'She went to [?] [?] every day';
    const result = alignGeometry(text, page, { fileId: 'f', pageNumber: 1 });
    expect(result.words.map(w => w.text).join(' ')).toBe(text);
    expect(result.words.filter(w => w.text === '[?]').map(w => w.geometryWordId).filter(Boolean).length).toBeLessThanOrEqual(2);
    const ids = result.words.map(w => w.geometryWordId).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
  });
  test('the PDF shows it as plain text, with no correction on it', () => {
    const text = 'She went to [?] every day';
    const html = renderSubmissionFeedbackReportHtml(buildSubmissionFeedbackReportViewModel({ generatedAt: 'x', identity: {}, legend: [], evaluation: {}, feedback: {},
      submission: { _id: 's', files: ['f'], canonicalText: text, correctionStatus: 'completed', correctionSourceHash: 'h', writingCorrections: [],
        transcriptPages: [{ fileId: 'f', pageNumber: 1, startChar: 0, endChar: text.length, text, imageWidth: 1000, imageHeight: 1000, words: [] }] } }));
    expect(html).toContain(text);
    expect(html).not.toContain('data-correction-id');
  });
});
