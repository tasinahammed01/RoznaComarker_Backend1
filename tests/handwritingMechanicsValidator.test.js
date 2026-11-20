'use strict';
// The no-op exception and the check's own confidence floor belong ONLY to findings of the handwriting mechanics check, passed through
// the trusted path. An AI reply that copies the "detector" field gets nothing. Offline, synthetic text.
const semantic = require('../src/services/semanticWritingCorrections.service');
const canonical = require('../src/services/correctionCanonical.service');
const DETECTOR = require('../src/services/handwritingMechanics/engine').DETECTOR;

const legend = semantic.compactSemanticLegend();
const transcript = 'Kids these days, they win and we hap py.';
const base = { transcript, legend, spans: [], sourceKind: 'exact_source', env: {} };
const finding = over => ({ category: 'MECHANICS', symbol: 'SPC', quotedText: 'days,', suggestedText: 'days,', occurrence: 0, confidence: 0.95,
  message: 'You wrote "days ,". Write "days," (no space before the comma).', correctionKind: 'localized', severity: 'low', ...over });
const trusted = { ...base, trustedDetector: DETECTOR };
const reasons = run => { try { return run().diagnostics.rejectionReasons; } catch (error) { return error.rejectionReasons; } };

test('a check finding whose quote equals its fix (the reader tidied the text) is accepted on the trusted path and keeps its tag', () => {
  const result = semantic.validateCorrections([finding({ detector: DETECTOR })], trusted);
  expect(result.corrections).toHaveLength(1);
  expect(result.corrections[0]).toMatchObject({ symbol: 'SPC', quotedText: 'days,', suggestedText: 'days,', detector: DETECTOR, startChar: 11, endChar: 16 });
  const cap = semantic.validateCorrections([finding({ symbol: 'CAP', quotedText: 'they', suggestedText: 'they', detector: DETECTOR,
    message: 'You wrote "They" in the middle of a sentence. Use a small letter: "they".' })], trusted);
  expect(cap.corrections[0]).toMatchObject({ symbol: 'CAP', detector: DETECTOR });
});

test('an AI reply that copies the detector field gets no exception and loses the field', () => {
  expect(reasons(() => semantic.validateCorrections([finding({ detector: DETECTOR })], base))).toEqual({ NO_OP_CORRECTION: 1 });
  const real = semantic.validateCorrections([finding({ quotedText: 'hap py', suggestedText: 'happy', symbol: 'SP', detector: DETECTOR,
    message: 'Spelling.' })], { ...base, sourceKind: undefined });
  expect(real.corrections[0]).not.toHaveProperty('detector');
});

test('the exception covers only SPC and CAP, and only items carrying the trusted tag', () => {
  expect(reasons(() => semantic.validateCorrections([finding({ symbol: 'P', detector: DETECTOR })], trusted))).toEqual({ NO_OP_CORRECTION: 1 });
  expect(reasons(() => semantic.validateCorrections([finding({})], trusted))).toEqual({ DETECTOR_MISMATCH: 1 });
  expect(reasons(() => semantic.validateCorrections([finding({ detector: 'something-else' })], trusted))).toEqual({ DETECTOR_MISMATCH: 1 });
});

test('the check uses its own floor (already applied); the 0.90 Mechanics bar is unchanged for AI findings', () => {
  const low = { quotedText: 'days,', suggestedText: 'days ,', confidence: 0.85 };
  expect(semantic.validateCorrections([finding({ ...low, detector: DETECTOR })], trusted).corrections).toHaveLength(1);
  expect(reasons(() => semantic.validateCorrections([finding(low)], base))).toEqual({ LOW_CONFIDENCE: 1 });
});

test('the letter-gap rule still applies to check findings on exact-source essays', () => {
  expect(reasons(() => semantic.validateCorrections([finding({ quotedText: 'hap py', suggestedText: 'happy', detector: DETECTOR })], trusted)))
    .toEqual({ HANDWRITING_LETTER_GAP: 1 });
});

test('normalizeCorrection on a raw item that only claims the tag: no exception, no tag', () => {
  const raw = { ...finding({ detector: DETECTOR }), category: 'MECHANICS' };
  const range = canonical.locateQuote(transcript, raw.quotedText, 0);
  const groups = { groups: legend.map(g => ({ key: g.category, label: g.label, color: g.color, symbols: g.symbols })) };
  expect(canonical.normalizeCorrection({ ...raw, startChar: range.start, endChar: range.end }, transcript, [], groups, 'AI')).toBeNull();
  const changed = canonical.normalizeCorrection({ ...raw, suggestedText: 'days ,', startChar: range.start, endChar: range.end }, transcript, [], groups, 'AI');
  expect(changed).not.toHaveProperty('detector');
});
