'use strict';

const prototype = require('./helpers/sourceSpanPrototype.cjs');
const semantic = require('../src/services/semanticWritingCorrections.service');
const client = require('../src/services/semanticAIClient.service');
const canonical = require('../src/services/correctionCanonical.service');
const fidelity = require('../src/utils/sourceFidelity');
const { buildCanonicalSubmissionTranscript } = require('../src/utils/ocrTranscriptNormalizer');
const { defaultLegend } = require('../src/services/writingCorrections.service');
const { reviewPayload } = require('./helpers/astraAssessmentFixtures.cjs');

const legend = semantic.compactSemanticLegend(defaultLegend());
const catalog = semantic.categorySymbolCatalog(legend);
const env = { OPENROUTER_API_KEY: 'offline-only', CORRECTION_DETECTION_MODEL: 'openai/gpt-4.1-mini' };
function source(texts, pdf = false) {
  const pages = texts.map((text, pageIndex) => {
    const fileId = 'a'.repeat(23) + (pdf ? '0' : String(pageIndex));
    return { fileId, fileOrder: pdf ? 0 : pageIndex, pageNumber: pdf ? pageIndex + 1 : 1, pageIndex,
      sourceFidelityMode: 'gpt_vision_exact', sourceFidelityStatus: 'GPT_SOURCE_ACCEPTED',
      sourceFidelityVersion: require('../src/services/gptVisionExact/contract').VERSION,
      sourceTextExact: text, sourceTextSha256: fidelity.sha(text),
      words: [...text.matchAll(/\S+/gu)].map((m, index) => ({ id: `word_${fileId}_${pageIndex + 1}_gpt_${index}`,
        text: m[0], sourceStart: m.index, sourceEnd: m.index + m[0].length })) };
  });
  const doc = { files: [...new Set(pages.map(p => p.fileId))], ocrPages: pages, ...fidelity.aggregate({ ocrPages: pages }) };
  const result = buildCanonicalSubmissionTranscript(doc);
  expect(result.isComplete).toBe(true);
  return { transcript: result.text, transcriptHash: fidelity.sha(result.text), spans: result.wordSpans,
    pageManifest: result.pages, transcriptComplete: true, disableCategoryAudit: true };
}
function ref(context, start = 0, end = context.words[0].end) {
  const words = context.words.filter(w => start < w.end && end > w.start);
  return { fileId: words[0].fileId, page: words[0].page, firstWordId: words[0].id,
    lastWordId: words.at(-1).id, startChar: start, endChar: end };
}
const finding = (context, symbol = 'SP', reference = ref(context), suggestedText = 'misspell') => ({
  symbol, correctionKind: 'localized', sourceSpan: reference, suggestedText, confidence: .99, severity: 'high'
});
function envelope(input, corrections = []) {
  const reviews = reviewPayload(input.transcriptHash).categories;
  return { reviewContract: prototype.VERSION, transcriptHash: input.transcriptHash,
    categories: Object.fromEntries(Object.entries(reviews).map(([category, review]) => [category, {
      reviewed: true, reviewedSymbols: Object.fromEntries(review.reviewedSymbols.map(symbol => [symbol, true])),
      corrections: corrections.filter(item => catalog[category].includes(item.symbol))
    }])) };
}
function validate(input, payload) {
  const expanded = prototype.expand(payload, prototype.prepare(input), legend);
  const parsed = semantic.parseJson(JSON.stringify(expanded), input.transcriptHash);
  return semantic.validateCorrections(parsed.corrections, { ...input, env, legend });
}

test('exact word and multiword resolution derive source quote, offsets and occurrence', () => {
  const input = source(['she go mispell']), context = prototype.prepare(input);
  expect(prototype.resolve(context, ref(context, 0, 6))).toMatchObject({ quotedText: 'she go', startChar: 0,
    endChar: 6, occurrence: 0, wordIds: context.words.slice(0, 2).map(w => w.id), semanticCorrectness: 'UNPROVEN' });
  const result = validate(input, envelope(input, [finding(context, 'AGR', ref(context, 0, 6), 'she goes'),
    finding(context, 'SP', ref(context, 7, 14))]));
  expect(result.corrections.map(c => c.symbol)).toEqual(['AGR', 'SP']);
});

test('punctuation, repeated spaces, CRLF and Unicode are sliced without normalization', () => {
  const input = source(['“word,”  \r\nword 😀']), context = prototype.prepare(input);
  expect(prototype.resolve(context, ref(context, 0, input.transcript.length)).quotedText).toBe(input.transcript);
  expect(prototype.resolve(context, ref(context, 5, 6)).quotedText).toBe(',');
  expect(() => prototype.resolve(context, ref(context, 0, 17))).toThrow('SPLIT_SURROGATE');
});

test('repeated identical and overlapping literal text select the referenced occurrence, never first match', () => {
  const input = source(['go go go']), context = prototype.prepare(input);
  expect(prototype.resolve(context, ref(context, 3, 8))).toMatchObject({ quotedText: 'go go', occurrence: 1, startChar: 3 });
  expect(prototype.resolve(context, ref(context, 6, 8))).toMatchObject({ quotedText: 'go', occurrence: 2, startChar: 6 });
});

test.each([
  ['fileId', 'invented'], ['page', 7], ['firstWordId', 'invented'], ['lastWordId', 'invented'],
  ['startChar', -1], ['startChar', .5], ['startChar', '0'], ['endChar', 5000], ['endChar', 0],
  ['endChar', null], ['page', '1']
])('invalid reference %s=%j fails closed', (key, value) => {
  const context = prototype.prepare(source(['mispell']));
  expect(() => prototype.resolve(context, { ...ref(context), [key]: value })).toThrow();
});

test.each(['duplicate-id', 'overlap', 'wrong-text', 'wrong-page', 'duplicate-page'])(
  'ambiguous or corrupt mapping %s fails before any output can be expanded', mode => {
    const input = source(['mispell words']);
    if (mode === 'duplicate-id') input.spans[1].wordId = input.spans[0].wordId;
    if (mode === 'overlap') input.spans.push({ ...input.spans[0], wordId: 'other-id' });
    if (mode === 'wrong-text') input.spans[0].word = { text: 'different' };
    if (mode === 'wrong-page') input.spans[0].page = 99;
    if (mode === 'duplicate-page') input.pageManifest.push({ ...input.pageManifest[0] });
    expect(() => prototype.prepare(input)).toThrow();
  });

test('word IDs and offsets must agree; reversed, unmapped and whitespace-only spans are rejected', () => {
  const input = source(['one  hidden two']), context = prototype.prepare(input);
  expect(() => prototype.resolve(context, { ...ref(context), firstWordId: context.words[2].id })).toThrow();
  expect(() => prototype.resolve(context, { ...ref(context), startChar: 3, endChar: 5 })).toThrow();
  const unmapped = prototype.prepare({ ...input, spans: [input.spans[0], input.spans[2]] });
  expect(() => prototype.resolve(unmapped, ref(unmapped, 0, input.transcript.length))).toThrow('INCOMPLETE_SOURCE_MAPPING');
  expect(() => prototype.prepare({ ...input, transcriptComplete: false })).toThrow('COMPLETE_MAPPED_SOURCE_REQUIRED');
});

test.each([1, 2, 5])('%i images retain complete source and distinct file identities', count => {
  const input = source(Array(count).fill('mispell')), context = prototype.prepare(input);
  expect(context.pages).toHaveLength(count);
  expect(new Set(context.pages.map(p => p.fileId)).size).toBe(count);
  const corrections = context.words.map(w => finding(context, 'SP', ref(context, w.start, w.end)));
  const accepted = validate(input, envelope(input, corrections)).corrections;
  expect(accepted).toHaveLength(count);
  expect(accepted.map(c => c.fileId)).toEqual(context.pages.map(p => p.fileId));
  expect(accepted.every(c => c.page === 1)).toBe(true);
});

test.each([false, true])('cross-page reference fails for PDF=%j; same-file PDF page identity stays distinct', pdf => {
  const input = source(['mispell', 'mispell'], pdf), context = prototype.prepare(input);
  expect(() => prototype.resolve(context, ref(context, 0, input.transcript.length))).toThrow('INVALID_PAGE_OR_BOUNDARIES');
  const second = context.words[1], good = ref(context, second.start, second.end);
  const accepted = validate(input, envelope(input, [finding(context, 'SP', good)])).corrections[0];
  expect(accepted.page).toBe(pdf ? 2 : 1);
  expect(accepted.fileId).toBe(context.pages[1].fileId);
  expect(() => prototype.resolve(context, { ...good, lastWordId: context.words[0].id })).toThrow();
});

test('distinct overlapping errors survive unchanged production overlap handling', () => {
  const input = source(['she go mispell']), context = prototype.prepare(input);
  const result = validate(input, envelope(input, [finding(context, 'AGR', ref(context, 0, 6), 'she goes'),
    finding(context, 'T', ref(context, 0, 6), 'she went'), finding(context, 'SP', ref(context, 7, 14))]));
  expect(canonical.mergeCanonicalCorrections({ aiCorrections: result.corrections }).corrections).toHaveLength(3);
  expect(canonical.mergeCanonicalCorrections({ aiCorrections: [result.corrections[0], result.corrections[0]] })
    .corrections).toHaveLength(1);
});

test('wrong target is still wrong despite exact grounding; suggestion is never source evidence', () => {
  const input = source(['correct mispell']), context = prototype.prepare(input);
  const actualDefectStart = 8, candidate = finding(context, 'SP', ref(context), 'misspell');
  const accepted = validate(input, envelope(input, [candidate])).corrections[0];
  expect(accepted.quotedText).toBe('correct');
  expect(accepted.startChar === actualDefectStart).toBe(false);
  expect(prototype.resolve(context, candidate.sourceSpan).semanticCorrectness).toBe('UNPROVEN');
  const claimedQuote = envelope(input, [{ ...candidate, quotedText: 'mispell' }]);
  expect(() => prototype.expand(claimedQuote, context, legend)).toThrow('PROTOTYPE_CONTRACT_INVALID');
  expect(() => prototype.expand({ ...envelope(input), transcriptHash: 'stale' }, context, legend)).toThrow();
});

test.each(['friendly', 'balanced', 'strict'])('%s keeps 28 attestations, confidence and correction-kind validation', strictness => {
  const input = { ...source(['mispell word']), policy: { strictness } }, context = prototype.prepare(input);
  const low = { ...finding(context, 'AGR', ref(context, 8, 12), 'words'), confidence: .01 };
  const kind = { ...finding(context, 'T', ref(context, 8, 12), 'words'), correctionKind: 'global' };
  const result = validate(input, envelope(input, [finding(context), low, kind]));
  expect(result.corrections).toHaveLength(1);
  expect(result.diagnostics.rejectionReasons).toMatchObject({ LOW_CONFIDENCE: 1, UNSUPPORTED_CORRECTION_KIND: 1 });
  const schema = prototype.schema(input.transcriptHash, Object.keys(catalog), catalog);
  expect(Object.values(catalog).flat()).toHaveLength(28);
  expect(schema.$defs.finding.required).toContain('sourceSpan');
  expect(schema.$defs.finding.properties).not.toHaveProperty('quotedText');
  expect(schema.$defs.finding.properties.sourceSpan.additionalProperties).toBe(false);
});

test('prototype adapter fits the existing one-request direct analyzer with strict schema and no fallback', async () => {
  const input = source(['mispell']), context = prototype.prepare(input), request = semantic.buildSemanticRequest(input);
  const fetchImpl = jest.fn(async (_url, options) => {
    const body = JSON.parse(options.body);
    expect(body.model).toBe('openai/gpt-4.1-mini');
    expect(body.provider).toEqual({ require_parameters: true, allow_fallbacks: false });
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema.properties.reviewContract.const).toBe(prototype.VERSION);
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ model: body.model,
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(envelope(input, [finding(context)])) } }] }) };
  });
  const config = { ...client.getCorrectionAIConfig(env), primaryRetries: 0, fallbackRetries: 0, retriesPerModel: 0, maxRetries: 0 };
  const runCompletion = options => client.runSemanticCompletion({ ...options, fetchImpl,
    messages: request.messages.map(m => m.role === 'user' ? { ...m, content: m.content + '\n' + prototype.supplement(context) } : m),
    responseSchema: prototype.schema(input.transcriptHash, Object.keys(catalog), catalog),
    validate: content => options.validate(JSON.stringify(prototype.expand(JSON.parse(content), context, legend))) });
  const result = await semantic.analyze(input, { env, config, runCompletion });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(result.corrections).toHaveLength(1);
  expect(result.diagnostics.totalReceivedUniqueSymbols).toBe(28);
  expect(require('../src/services/correctionAdmission.service').shared.snapshot())
    .toMatchObject({ limit: 4, queueLimit: 64, active: 0, queued: 0 });
});

test('measure synthetic one/two/five-page overhead without truncating the source catalog', () => {
  const page = Array.from({ length: 127 }, (_, i) => i % 9 === 0 ? 'mispell' : 'word').join(' ');
  const measurements = [1, 2, 5].map(count => {
    const input = source(Array(count).fill(page)), context = prototype.prepare(input), candidate = finding(context);
    const { sourceSpan, ...rest } = candidate;
    const literal = { ...rest, quotedText: 'mispell', occurrence: 0 };
    const measure = prototype.overhead(input, { anchored: candidate, literal });
    expect(context.words).toHaveLength(127 * count);
    const prompt = prototype.supplement(context);
    expect(prompt.includes(context.words.at(-1).id)).toBe(true);
    expect(prototype.prepare(input).sourceSha256).toBe(fidelity.sha(input.transcript));
    return measure;
  });
  console.log(JSON.stringify({ offlineSourceSpanOverhead: measurements }));
});
