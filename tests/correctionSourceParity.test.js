'use strict';

const crypto = require('crypto');
const semantic = require('../src/services/semanticWritingCorrections.service');
const client = require('../src/services/semanticAIClient.service');
const wire = require('../src/services/compactCorrectionWire.service');
const canonical = require('../src/services/correctionCanonical.service');
const fidelity = require('../src/utils/sourceFidelity');
const { buildCanonicalSubmissionTranscript } = require('../src/utils/ocrTranscriptNormalizer');
const { defaultLegend } = require('../src/services/writingCorrections.service');
const { reviewPayload, finding } = require('./helpers/astraAssessmentFixtures.cjs');

const env = { OPENROUTER_API_KEY: 'offline-only', CORRECTION_DETECTION_MODEL: 'openai/gpt-4.1-mini' };
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const legend = semantic.compactSemanticLegend(defaultLegend());
function source(texts) {
  const pages = texts.map((text, index) => ({ fileId: 'synthetic-pdf', fileOrder: 0,
    pageIndex: index, pageNumber: index + 1, sourceFidelityMode: 'gpt_vision_exact',
    sourceFidelityVersion: require('../src/services/gptVisionExact/contract').VERSION,
    sourceFidelityStatus: 'GPT_SOURCE_ACCEPTED', sourceTextExact: text, sourceTextSha256: hash(text),
    words: [...text.matchAll(/\S+/gu)].map((m, wordIndex) => ({ id: `p${index}w${wordIndex}`,
      text: m[0], sourceStart: m.index, sourceEnd: m.index + m[0].length,
      bbox: { x: wordIndex * 20, y: 0, width: 18, height: 10 } })) }));
  const doc = { files: ['synthetic-pdf'], ocrPages: pages, ...fidelity.aggregate({ ocrPages: pages }) };
  const result = buildCanonicalSubmissionTranscript(doc);
  expect(result.isComplete).toBe(true);
  return { transcript: result.text, transcriptHash: hash(result.text), spans: result.wordSpans,
    pageManifest: result.pages, transcriptComplete: true, disableCategoryAudit: true };
}
function validate(input, findings) {
  return semantic.validateCorrections(findings, { ...input, legend, env });
}
function payload(input, findings) {
  const verbose = reviewPayload(input.transcriptHash, undefined, findings);
  return { reviewContract: wire.VERSION, transcriptHash: input.transcriptHash,
    categories: Object.fromEntries(Object.entries(verbose.categories).map(([category, review]) => [category, {
      reviewed: true, reviewedSymbols: Object.fromEntries(review.reviewedSymbols.map(symbol => [symbol, true])),
      corrections: review.corrections.map(({ message, stylePreference, ...item }) => item)
    }])) };
}

test.each([['zero', []], ['genuine', [finding('MECHANICS', 'SP', 'mispell', { suggestedText: 'misspell' })]]])(
  'canonical source, actual serialized request and grounding preserve identical UTF-16 and UTF-8 with %s findings', async (_label, findings) => {
    const input = source(['  “Exact”\r\nword  word\t😀 mispell\n\nCase.\n', 'Second page: cafe\u0301.']);
    const request = semantic.buildSemanticRequest(input);
    const fetchImpl = jest.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      // The transcript is the unmodified final field; earlier context alone is compacted.
      const prompt = body.messages[1].content;
      const transmitted = prompt.slice(prompt.indexOf('\ntranscript=') + '\ntranscript='.length);
      expect(transmitted === input.transcript).toBe(true);
      expect(hash(transmitted)).toBe(input.transcriptHash);
      expect(Buffer.from(transmitted).equals(Buffer.from(input.transcript))).toBe(true);
      expect(body.messages).toEqual(request.messages);
      expect(body.model).toBe('openai/gpt-4.1-mini');
      expect(body.provider).toEqual({ require_parameters: true, allow_fallbacks: false });
      expect(body.response_format.json_schema.strict).toBe(true);
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({
        model: body.model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(payload(input, findings)) } }]
      }) };
    });
    const config = { ...client.getCorrectionAIConfig(env), primaryRetries: 0, fallbackRetries: 0,
      retriesPerModel: 0, maxRetries: 0 };
    const result = await semantic.analyze(input, { env, config, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.corrections).toHaveLength(findings.length);
    expect(result.diagnostics.totalExpectedSymbols).toBe(28);
    expect(result.diagnostics.totalReceivedUniqueSymbols).toBe(28);
    for (const item of result.corrections) {
      expect(input.transcript.slice(item.startChar, item.endChar)).toBe(item.quotedText);
      expect(item.fileId).toBe('synthetic-pdf');
      expect(item.page).toBe(1);
      expect(item.wordIds).toHaveLength(1);
    }
  });

test('literal repeated quote uses valid occurrence; unique quote keeps the existing production fallback', () => {
  const input = source(['she go. she go. mispell']);
  const result = validate(input, [finding('GRAMMAR', 'AGR', 'she go', { occurrence: 1, suggestedText: 'she goes' }),
    finding('MECHANICS', 'SP', 'mispell', { occurrence: 99, suggestedText: 'misspell' })]);
  expect(result.corrections.map(c => [c.startChar, c.endChar])).toEqual([[8, 14], [16, 23]]);
  expect(result.corrections[0].wordIds).toEqual(['p0w2', 'p0w3']);
});

test.each([
  ['paraphrase', 'she goes'], ['line break', 'she go'], ['repeated whitespace', 'she\n go'],
  ['Unicode quotation marks', '"Exact"'], ['capitalization', 'She\n  go'], ['Unicode normalization', 'café'],
  ['missing quote', ''], ['ambiguous occurrence', 'word', 9]
])('%s cannot create an invented highlight', (_label, quote, occurrence = 0) => {
  const input = source(['she\n  go “Exact” cafe\u0301 word word mispell']);
  const result = validate(input, [finding('MECHANICS', 'SP', 'mispell', { suggestedText: 'misspell' }),
    finding('GRAMMAR', 'AGR', quote, { occurrence, suggestedText: 'a replacement' })]);
  expect(result.corrections).toHaveLength(1);
  expect(result.corrections[0].symbol).toBe('SP');
  const reason = !quote ? 'INVALID_SCHEMA' : occurrence ? 'OCCURRENCE_NOT_FOUND' : 'QUOTE_NOT_FOUND';
  expect(result.diagnostics.rejectionReasons[reason]).toBe(1);
});

test('multiple independent errors, including coincident evidence, remain representable', () => {
  const input = source(['she go mispell']);
  const result = validate(input, [finding('GRAMMAR', 'AGR', 'she go', { suggestedText: 'she goes' }),
    finding('GRAMMAR', 'T', 'she go', { suggestedText: 'she went' }),
    finding('MECHANICS', 'SP', 'mispell', { suggestedText: 'misspell' })]);
  const merged = canonical.mergeCanonicalCorrections({ aiCorrections: result.corrections });
  expect(merged.corrections.map(c => c.symbol).sort()).toEqual(['AGR', 'SP', 'T']);
});

test('cross-page evidence cannot bind a PDF highlight to the first page', () => {
  const input = source(['she go', 'mispell']);
  const result = validate(input, [finding('GRAMMAR', 'AGR', input.transcript, { suggestedText: 'replacement' }),
    finding('MECHANICS', 'SP', 'mispell', { suggestedText: 'misspell' })]);
  expect(result.corrections).toHaveLength(1);
  expect(result.corrections[0]).toMatchObject({ symbol: 'SP', page: 2, wordIds: ['p1w0'] });
  expect(result.diagnostics.rejectionReasons.INVALID_LOCATION).toBe(1);
});

test('all rejected findings fail canonical validation rather than reporting zero errors', () => {
  const input = source(['she go']);
  expect(() => validate(input, [finding('GRAMMAR', 'AGR', 'she goes')]))
    .toThrow('Semantic analysis returned no acceptable grounded corrections');
});
