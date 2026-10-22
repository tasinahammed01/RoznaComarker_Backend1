const { validateEntry, validateCorrectionGold, compatibleCapture, evaluateCorrectionSet, ocrInducedRate, occurrences } = require('../src/services/hybridSource/correctionGold');
const { fallbackLegend, contentHash } = require('../src/services/correctionLegendResolver.service');
const { digest, evidenceKey } = require('../src/services/hybridSource/reconcile');
const { reconcileLocal } = require('../src/services/hybridSource/localReconciliation');
const { correctionDependency } = require('../src/services/hybridSource/verificationPolicy');
const { correctionControl } = require('../src/services/hybridSource/benchmark');
const { VERSION } = require('../src/services/hybridSource/contract');
const identity = { submissionId: 's', fileId: 'f', pageNumber: 1, runId: 'r', sourceSha256: 'a'.repeat(64), inputSha256: 'b'.repeat(64), width: 1600, height: 1000, orientation: 1 };
const transcript = 'relize relizing relizing we got rid off Social preception Society';
const words = transcript.split(' ').map((text, i) => ({ text, id: `word_f_1_${i + 1}`, confidence: 1,
  polygon: [{ x: 30 + i * 100, y: 100 }, { x: 100 + i * 100, y: 100 }, { x: 100 + i * 100, y: 130 }, { x: 30 + i * 100, y: 130 }] }));
const reader = { version: VERSION, activeTranscript: transcript, lines: [{ text: transcript, classification: 'STUDENT_ACTIVE_TEXT', confidence: 1 }] };
const options = { googleIdentity: identity, coordinateSpace: 'display-image' };
const raw = reconcileLocal(reader, words, identity, options);
const attestations = raw.bindings.filter(b => b.geometryUnique).map(b => ({ kind: 'HUMAN_REVIEWED', reviewer: 'synthetic unit reference', reviewId: b.regionId,
  identity, evidenceKey: evidenceKey(identity), wordIds: b.mappedWordIds, classification: b.classification, text: b.sourceText }));
const bindings = reconcileLocal(reader, words, identity, { ...options, trustedAttestations: attestations }).bindings;
function entry(quote = 'relize', occurrence = 1, suggestion = 'realize', category = 'MECHANICS', symbol = 'SP') {
  const start = occurrences(transcript, quote)[occurrence - 1], end = start + quote.length;
  const c = { id: `${quote}:${occurrence}`, quotedText: quote, start, end, occurrence, occurrenceId: `${digest(transcript)}:${start}:${end}`,
    suggestedText: suggestion, category, symbol, reason: 'Explicit synthetic reference error.', kind: 'OBJECTIVE_LITERAL' };
  const mapping = correctionDependency(c, bindings, identity, attestations, { transcript });
  return { ...c, mappingStatus: mapping.decision === 'ALLOW_OFFLINE_BINDING' ? 'EXACT_MAPPING_OFFLINE' : 'MAPPING_WITHHELD',
    expectedNativeWordIds: mapping.wordIds, expectedPolygons: mapping.polygons };
}
const makeGold = corrections => ({ version: 'human-corrections-v1', identity, sourceTranscriptSha256: digest(transcript),
  legend: { version: fallbackLegend().version, contentHash: contentHash(fallbackLegend()) },
  review: { humanReviewed: true, exhaustive: true }, corrections, reviewCandidates: [], negativeCases: [] });
const geometry = { words, bindings, attestations };
test('real source spelling fixture retains source and maps its correction exactly', () => {
  const c = entry();
  expect(validateCorrectionGold(makeGold([c]), transcript, identity, geometry).valid).toBe(true);
  expect(c.expectedNativeWordIds).toEqual(['word_f_1_1']);
  expect(c.expectedPolygons).toEqual([words[0].polygon]);
  expect(evaluateCorrectionSet(makeGold([c]), transcript, [c])).toMatchObject({ truePositives: 1, falsePositives: 0, falseNegatives: 0, precision: 1, recall: 1 });
});
test('repeated spelling occurrences cannot fall back to the first word', () => {
  const first = entry('relizing', 1, 'realizing'), second = entry('relizing', 2, 'realizing');
  expect(first.expectedNativeWordIds).toEqual(['word_f_1_2']);
  expect(second.expectedNativeWordIds).toEqual(['word_f_1_3']);
  expect(first.occurrenceId).not.toBe(second.occurrenceId);
  const result = evaluateCorrectionSet(makeGold([first, second]), transcript, [first, first]);
  expect(result).toMatchObject({ truePositives: 1, falsePositives: 1, falseNegatives: 1, precision: 0.5, recall: 0.5 });
});
test.each([['we', 'We', 'word_f_1_4'], ['Social', 'social', 'word_f_1_8'], ['Society', 'society', 'word_f_1_10']])(
  'CAP marker for %s preserves exact case/occurrence', (quote, replacement, id) => {
    const c = entry(quote, 1, replacement, 'MECHANICS', 'CAP');
    expect(c.expectedNativeWordIds).toEqual([id]);
    expect(validateCorrectionGold(makeGold([c]), transcript, identity, geometry).valid).toBe(true);
  });
test('PREP phrase binds exact native sequence, not a spelling/word-choice alias', () => {
  const c = entry('got rid off', 1, 'got rid of', 'GRAMMAR', 'PREP');
  expect(c.expectedNativeWordIds).toEqual(['word_f_1_5', 'word_f_1_6', 'word_f_1_7']);
  expect(c.expectedPolygons).toEqual(words.slice(4, 7).map(w => w.polygon));
});
test('semantic correction can remain valid while its marker is withheld', () => {
  const c = entry('got rid off', 1, 'got rid of', 'GRAMMAR', 'PREP');
  const uncertain = bindings.map(b => b.mappedWordIds.includes('word_f_1_6') ? { ...b, geometryUnique: false, state: 'OCR_UNCERTAIN' } : b);
  const draft = { ...c, mappingStatus: 'MAPPING_WITHHELD', expectedNativeWordIds: [], expectedPolygons: [] };
  expect(validateCorrectionGold(makeGold([draft]), transcript, identity, { ...geometry, bindings: uncertain }).valid).toBe(true);
  expect(evaluateCorrectionSet(makeGold([draft]), transcript, [draft]).truePositives).toBe(1);
});
test('unchanged suggestions are rejected in gold and flagged in actual outputs', () => {
  const c = entry();
  expect(() => validateEntry({ ...c, suggestedText: c.quotedText }, transcript)).toThrow('UNCHANGED_SUGGESTION');
  expect(evaluateCorrectionSet(makeGold([c]), transcript, [{ ...c, suggestedText: c.quotedText }])).toMatchObject({
    truePositives: 0, falsePositives: 1, unchangedSuggestions: 1 });
});
test('SP versus WC taxonomy mismatch is not credited as a true correction', () => {
  const c = entry(), actual = { ...c, category: 'VOCABULARY', symbol: 'WC' };
  expect(evaluateCorrectionSet(makeGold([c]), transcript, [actual])).toMatchObject({ truePositives: 0, falsePositives: 1, falseNegatives: 1, spWcMistakes: 1, codeCategoryAccuracy: 0 });
  expect(() => validateEntry({ ...c, symbol: 'UNKNOWN' }, transcript)).toThrow('UNSUPPORTED_TAXONOMY');
});
test.each(['Read the question', 'deleted writing', 'DEVICE'])('non-active %s cannot become a source correction target', quote => {
  expect(() => validateEntry({ ...entry(), quotedText: quote, end: quote.length }, transcript)).toThrow('EXACT_QUOTE_REQUIRED');
});
test.each(['runId', 'fileId', 'sourceSha256', 'inputSha256', 'pageNumber'])(
  'stale/foreign %s invalidates correction gold', key => {
    const gold = makeGold([entry()]); gold.identity = { ...identity, [key]: 'foreign' };
    expect(() => validateCorrectionGold(gold, transcript, identity, geometry)).toThrow('IDENTITY_OR_SCHEMA');
  });
test('changed transcript hash, occurrence or polygon is rejected', () => {
  const gold = makeGold([entry()]);
  expect(() => validateCorrectionGold({ ...gold, sourceTranscriptSha256: 'c'.repeat(64) }, transcript, identity, geometry)).toThrow();
  expect(() => validateEntry({ ...entry(), occurrence: 2 }, transcript)).toThrow('OCCURRENCE_MISMATCH');
  const changed = JSON.parse(JSON.stringify(gold)); changed.corrections[0].expectedPolygons[0][0].x++;
  expect(() => validateCorrectionGold(changed, transcript, identity, geometry)).toThrow('POLYGON_MISMATCH');
});
test('pending/non-exhaustive human review cannot produce model precision or recall', () => {
    const gold = makeGold([entry()]); gold.review = { humanReviewed: true, exhaustive: false };
  expect(evaluateCorrectionSet(gold, transcript, [entry()])).toMatchObject({ status: 'HUMAN_CORRECTION_REVIEW_REQUIRED', precision: null, recall: null });
});
test('missing actual model output is not treated as an empty correction set', () => {
  expect(evaluateCorrectionSet(makeGold([entry()]), transcript, null)).toMatchObject({ status: 'CONTROL_COMPLETION_UNAVAILABLE', falseNegatives: null });
  expect(evaluateCorrectionSet(makeGold([entry()]), transcript, [])).toMatchObject({ falseNegatives: 1, recall: 0 });
});
test('completed contextual negatives retain exact source evidence and count speculative findings as false positives', () => {
  const gold = makeGold([entry()]);
  const start = transcript.indexOf('Social');
  const negative = { id: 'NC', kind: 'CONTEXTUAL_NEGATIVE', humanReviewed: true, reviewer: 'USER',
    status: 'HUMAN_REVIEW_COMPLETE', decision: 'EXCLUDE_NO_COUNTED_CORRECTION', quotedText: 'Social',
    start, end: start + 6, occurrence: 1, occurrenceId: `${digest(transcript)}:${start}:${start + 6}`,
    suggestedText: null, symbol: null, category: null, reason: 'Synthetic human decision: no counted correction.' };
  gold.contextualReview = { status: 'HUMAN_REVIEW_COMPLETE', candidates: [negative] };
  expect(validateCorrectionGold(gold, transcript, identity, geometry).exhaustive).toBe(true);
  const actual = entry('Social', 1, 'other wording', 'CONTENT', 'CL');
  expect(evaluateCorrectionSet(gold, transcript, [actual])).toMatchObject({ falsePositives: 1, unsupportedContextual: 1 });
  for (const change of [{ symbol: 'WC' }, { suggestedText: 'rewrite' }, { start: start + 1 }, { humanReviewed: false }]) {
    expect(() => validateCorrectionGold({ ...gold, contextualReview: { ...gold.contextualReview, candidates: [{ ...negative, ...change }] } }, transcript, identity, geometry))
      .toThrow('CONTEXTUAL_NEGATIVE_SCHEMA');
  }
});
const negative = { kind: 'OCR_LITERAL_NEGATIVE', humanReviewed: true, sourceQuote: 'shaped', legacyQuote: 'sshaped', expectedNativeWordIds: ['word_f_1_2'] };
test('an actually observed OCR-created spelling correction counts as OCR-induced', () => {
  const legacy = 'alpha sshaped omega';
  const actual = { identity, transcriptSha256: digest(legacy), corrections: [{ start: 6, end: 13, quotedText: 'sshaped', suggestedText: 'shaped', wordIds: ['word_f_1_2'] }] };
  expect(ocrInducedRate(actual, legacy, identity, [negative])).toMatchObject({ status: 'EVALUATED', confirmedOcrInduced: 1, rate: 1 });
});
test('hypothetical errors without actual correction evidence have no false-correction rate', () => {
  expect(ocrInducedRate(null, 'sshaped', identity, [negative])).toMatchObject({ rate: null, confirmedOcrInduced: null });
});
test.each([['norms', 'world'], ['body', 'heart']])('correlated wrong agreement %s / %s does not make the source a student error', (truth, wrong) => {
  const n = { ...negative, sourceQuote: truth, legacyQuote: wrong };
  const observed = { identity, transcriptSha256: digest(wrong), corrections: [{ start: 0, end: wrong.length, quotedText: wrong, suggestedText: truth, wordIds: ['word_f_1_2'] }] };
  expect(ocrInducedRate(observed, wrong, identity, [n]).confirmedOcrInduced).toBe(1);
  expect(ocrInducedRate(null, wrong, identity, [n]).rate).toBeNull();
});
test('same text with foreign occurrence IDs cannot be automatically adjudicated', () => {
  const record = { identity, transcriptSha256: digest('sshaped'), corrections: [{ start: 0, end: 7, quotedText: 'sshaped', suggestedText: 'shaped', wordIds: ['word_foreign_1_2'] }] };
  expect(ocrInducedRate(record, 'sshaped', identity, [negative])).toMatchObject({ status: 'PARTIAL_ADJUDICATION', unknown: 1, rate: null });
  expect(ocrInducedRate({ ...record, identity: { ...identity, runId: 'old' } }, 'sshaped', identity, [negative]).status).toBe('LEGACY_CORRECTION_IDENTITY_MISMATCH');
});
test('compatible completion replay requires exact identity, prompt/schema/legend/config provenance', () => {
  const snapshot = { identity, transcriptSha256: digest(transcript), legendContentHash: contentHash(fallbackLegend()),
    modelConfigHash: 'c'.repeat(64), assignmentHash: 'd'.repeat(64), engineVersions: { prompt: 'p', schema: 's', categoryReview: 'c' } };
  const record = { ...snapshot, version: 'semantic-correction-capture-v1', content: '{}' };
  expect(compatibleCapture(record, snapshot)).toBe(true);
  expect(compatibleCapture({ ...record, engineVersions: { ...snapshot.engineVersions, prompt: 'old' } }, snapshot)).toBe(false);
  expect(compatibleCapture({ ...record, modelConfigHash: undefined }, snapshot)).toBe(false);
  expect(compatibleCapture(record, { ...snapshot, modelConfigHash: undefined })).toBe(false);
});
test('current control harness stops before a provider call when no offline completion adapter exists', async () => {
  const gold = { version: 'human-gold-v1', humanReviewed: true, reviewer: 'synthetic source review', imageSha256: identity.sourceSha256,
    transcript, excludedSpans: [], expectedCorrections: [] };
  await expect(correctionControl(gold)).rejects.toMatchObject({ code: 'OCR_CONTROL_OFFLINE_ADAPTER_REQUIRED' });
});
