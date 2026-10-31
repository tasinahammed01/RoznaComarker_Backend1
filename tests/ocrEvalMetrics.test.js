'use strict';
// Metric tests for the OCR evaluation harness. Pure functions: no I/O, no network, no API key.
const m = require('../scripts/ocr-eval/lib/metrics.cjs');

const list = tsv => m.parseMistakes(tsv);

describe('normalizeText / tokenize', () => {
  test('collapses all whitespace, including line breaks, and trims', () => {
    expect(m.normalizeText('  one two\r\nthree \n\n four\t')).toBe('one two three four');
  });
  test('folds typographic quotes, dashes and ellipsis to plain forms by default', () => {
    expect(m.normalizeText('“Don’t” — wait…')).toBe('"Don\'t" - wait...');
  });
  test('can keep typography when asked', () => {
    expect(m.normalizeText('Don’t', { foldTypography: false })).toBe('Don’t');
  });
  test('uses canonical Unicode composition', () => {
    expect(m.normalizeText('café')).toBe('café');
  });
  test('lowercases only when case-insensitive', () => {
    expect(m.normalizeText('Hello World')).toBe('Hello World');
    expect(m.normalizeText('Hello World', { caseSensitive: false })).toBe('hello world');
  });
  test('removes a byte-order mark and zero-width characters', () => {
    expect(m.normalizeText('﻿ab​c')).toBe('abc');
  });
  test('tokenize splits on whitespace and ignores empty input', () => {
    expect(m.tokenize('a  b\nc')).toEqual(['a', 'b', 'c']);
    expect(m.tokenize('   ')).toEqual([]);
  });
  test('only tokens containing [?] are uncertain', () => {
    expect(m.isUncertainToken('[?]')).toBe(true);
    expect(m.isUncertainToken('word[?]')).toBe(true);
    expect(m.isUncertainToken('word[?].')).toBe(true);
    expect(m.isUncertainToken('word?')).toBe(false);
    expect(m.isUncertainToken('[word]')).toBe(false);
  });
});

describe('levenshteinDistance', () => {
  test('kitten -> sitting is 3', () => expect(m.levenshteinDistance('kitten', 'sitting')).toBe(3));
  test('empty and identical inputs', () => {
    expect(m.levenshteinDistance('', 'abc')).toBe(3);
    expect(m.levenshteinDistance('abc', '')).toBe(3);
    expect(m.levenshteinDistance('same', 'same')).toBe(0);
    expect(m.levenshteinDistance('', '')).toBe(0);
  });
  test('counts Unicode code points, not UTF-16 units', () => {
    expect(m.levenshteinDistance('a\u{1F600}b', 'ab')).toBe(1);
  });
  test('works on token arrays', () => {
    expect(m.levenshteinDistance(['the', 'cat', 'sat'], ['the', 'cat', 'sit'])).toBe(1);
  });
});

describe('alignTokens', () => {
  test('returns ordered match/sub/del/ins operations', () => {
    const { distance, ops } = m.alignTokens(['a', 'b', 'c'], ['a', 'x', 'c']);
    expect(distance).toBe(1);
    expect(ops.map(o => o.type)).toEqual(['match', 'sub', 'match']);
  });
  test('reports deletions and insertions with the indices they refer to', () => {
    const del = m.alignTokens(['a', 'b', 'c'], ['a', 'c']).ops.find(o => o.type === 'del');
    expect(del.ref).toBe(1);
    const ins = m.alignTokens(['a', 'c'], ['a', 'b', 'c']).ops.find(o => o.type === 'ins');
    expect(ins.hyp).toBe(1);
  });
  test('is deterministic', () => {
    const a = m.alignTokens(['x', 'y'], ['y', 'x']);
    const b = m.alignTokens(['x', 'y'], ['y', 'x']);
    expect(a).toEqual(b);
  });
});

describe('CER / WER (scoreTexts)', () => {
  test('CER divides by REFERENCE length: kitten -> sitting is 3/6', () => {
    const s = m.scoreTexts('kitten', 'sitting');
    expect(s.cerDistance).toBe(3);
    expect(s.referenceChars).toBe(6);
    expect(s.cer).toBeCloseTo(0.5, 10);
  });
  test('WER: one wrong word of three is 1/3, with substitution counted', () => {
    const s = m.scoreTexts('the cat sat', 'the cat sit');
    expect(s.wer).toBeCloseTo(1 / 3, 10);
    expect(s.substitutions).toBe(1);
    expect(s.cer).toBeCloseTo(1 / 11, 10);
  });
  test('omitted word is a deletion', () => {
    const s = m.scoreTexts('a b c', 'a c');
    expect(s.wer).toBeCloseTo(1 / 3, 10);
    expect(s.deletions).toBe(1);
    expect(s.cer).toBeCloseTo(0.4, 10);
  });
  test('extra word is an insertion', () => {
    const s = m.scoreTexts('a c', 'a b c');
    expect(s.wer).toBeCloseTo(0.5, 10);
    expect(s.insertions).toBe(1);
    expect(s.cer).toBeCloseTo(2 / 3, 10);
  });
  test('empty model output is a 100% error', () => {
    const s = m.scoreTexts('the cat', '');
    expect(s.cer).toBe(1);
    expect(s.wer).toBe(1);
    expect(s.deletions).toBe(2);
  });
  test('empty reference has no defined rate (null), never 0 or Infinity', () => {
    const s = m.scoreTexts('', 'abc');
    expect(s.cer).toBeNull();
    expect(s.wer).toBeNull();
  });
  test('identical texts score exactly 0', () => {
    const s = m.scoreTexts('Same words here.', 'Same words here.');
    expect(s.cer).toBe(0);
    expect(s.wer).toBe(0);
  });
  test('line breaks and extra spaces do not count as errors', () => {
    const s = m.scoreTexts('one two\nthree', 'one  two three');
    expect(s.cer).toBe(0);
    expect(s.wer).toBe(0);
  });
  test('punctuation is part of the word (strict): "ended." vs "ended" is a word error', () => {
    const s = m.scoreTexts('It ended.', 'It ended');
    expect(s.wer).toBeCloseTo(0.5, 10);
    expect(s.cer).toBeCloseTo(1 / 9, 10);
  });
  test('typographic quote variants are not errors, unless folding is disabled', () => {
    expect(m.scoreTexts("don't", 'don’t').cer).toBe(0);
    expect(m.scoreTexts("don't", 'don’t', { foldTypography: false }).cer).toBeGreaterThan(0);
  });
  test('canonically equivalent Unicode is not an error', () => {
    expect(m.scoreTexts('café', 'café').cer).toBe(0);
  });
});

describe('evaluatePair: case-sensitive and case-insensitive', () => {
  test('capitalisation differences count only in the case-sensitive result', () => {
    const r = m.evaluatePair('Hello World', 'hello world');
    expect(r.caseSensitive.wer).toBe(1);
    expect(r.caseSensitive.cer).toBeCloseTo(2 / 11, 10);
    expect(r.caseInsensitive.wer).toBe(0);
    expect(r.caseInsensitive.cer).toBe(0);
  });
  test('real spelling errors count in both', () => {
    const r = m.evaluatePair('powerfull', 'powerful');
    expect(r.caseSensitive.cer).toBeCloseTo(1 / 9, 10);
    expect(r.caseInsensitive.cer).toBeCloseTo(1 / 9, 10);
  });
});

describe('[?] uncertain ground-truth segments are ignored', () => {
  test('standalone [?] matches a model word of any value', () => {
    const s = m.scoreTexts('I saw the [?] cat', 'I saw the big cat');
    expect(s.wer).toBe(0);
    expect(s.cer).toBe(0);
    expect(s.uncertain.referenceTokensMasked).toBe(1);
    expect(s.uncertain.hypothesisTokensDropped).toBe(1);
  });
  test('the model may also omit the word entirely', () => {
    expect(m.scoreTexts('I saw the [?] cat', 'I saw the cat').wer).toBe(0);
  });
  test('the model may split an unreadable word into two', () => {
    expect(m.scoreTexts('I saw the [?] cat', 'I saw the very big cat').wer).toBe(0);
  });
  test('but cannot swallow more than the allowed span: a third extra word is an insertion', () => {
    const s = m.scoreTexts('I saw the [?] cat', 'I saw the very big old cat');
    expect(s.wer).toBeCloseTo(0.25, 10);
    expect(s.insertions).toBe(1);
  });
  test('suffix form word[?] ignores that word, whatever the model wrote', () => {
    expect(m.scoreTexts('I like powerfull[?] things', 'I like powerful things').wer).toBe(0);
    expect(m.scoreTexts('I like powerfull[?] things', 'I like XYZ things').wer).toBe(0);
  });
  test('masking does not hide other errors in the same text', () => {
    const s = m.scoreTexts('a [?] c d', 'a b c x');
    expect(s.wer).toBeCloseTo(1 / 3, 10);
  });
  test('model words next to a masked region still count as insertions', () => {
    const s = m.scoreTexts('a [?] d', 'a b c x y d');
    expect(s.wer).toBe(1);
  });
  test('an all-uncertain reference has no defined rate', () => {
    const s = m.scoreTexts('[?] [?]', 'anything');
    expect(s.wer).toBeNull();
    expect(s.cer).toBeNull();
  });
  test('[?] written by the model is ordinary text, not a wildcard', () => {
    expect(m.scoreTexts('a b', 'a [?]').wer).toBeCloseTo(0.5, 10);
  });
  test('masking also applies to the case-insensitive result', () => {
    const r = m.evaluatePair('Hello [?] World', 'hello big world');
    expect(r.caseInsensitive.wer).toBe(0);
    expect(r.caseSensitive.wer).toBeCloseTo(1, 10);
  });
});

describe('parseMistakes', () => {
  test('reads tab-separated pairs, ignoring blanks, # comments, BOM and CRLF', () => {
    const r = list('﻿# header\r\npowerfull\tpowerful\r\n\r\n  She go \t She goes \r\n');
    expect(r.errors).toEqual([]);
    expect(r.entries.map(e => [e.student, e.correct])).toEqual([['powerfull', 'powerful'], ['She go', 'She goes']]);
    expect(r.entries[1].studentTokens).toEqual(['She', 'go']);
    expect(r.entries[1].correctTokens).toEqual(['She', 'goes']);
  });
  test('reports malformed lines with their line numbers instead of silently skipping them', () => {
    const r = list('ok\tfine\nnodelimiter\na\tb\tc\n\tmissing\nsame\tsame\n');
    expect(r.errors.map(e => e.line)).toEqual([2, 3, 4, 5]);
    expect(r.entries.map(e => e.student)).toEqual(['ok']);
  });
  test('rejects a student form listed twice (ambiguous)', () => {
    const r = list('a\tb\na\tc\n');
    expect(r.errors.map(e => e.line)).toEqual([2]);
  });
  test('folds typography the same way as the texts', () => {
    expect(list('don’t\tdo not\n').entries[0].student).toBe("don't");
  });
});

describe('overCorrection', () => {
  const oc = (gt, model, tsv, options) => m.overCorrection(gt, model, list(tsv), options);
  const P = 'powerfull\tpowerful\n';

  test('model keeps the student mistake -> preserved', () => {
    const r = oc('It is powerfull and strong.', 'It is powerfull and strong.', P);
    expect(r).toMatchObject({ available: true, listed: 1, preserved: 1, overcorrected: 0, misread: 0, dropped: 0, overcorrectionRate: 0, preservedRate: 1 });
  });
  test('model silently fixes the mistake -> over-corrected', () => {
    const r = oc('It is powerfull and strong.', 'It is powerful and strong.', P);
    expect(r).toMatchObject({ listed: 1, overcorrected: 1, preserved: 0, overcorrectionRate: 1 });
    expect(r.occurrences[0]).toMatchObject({ student: 'powerfull', correct: 'powerful', modelText: 'powerful', outcome: 'overcorrected' });
  });
  test('a MISREAD is not an over-correction (guards against counting every difference)', () => {
    const r = oc('It is powerfull and strong.', 'It is powerfoll and strong.', P);
    expect(r).toMatchObject({ listed: 1, misread: 1, overcorrected: 0, overcorrectionRate: 0 });
  });
  test('a dropped word is its own outcome', () => {
    const r = oc('It is powerfull and strong.', 'It is and strong.', P);
    expect(r).toMatchObject({ listed: 1, dropped: 1, overcorrected: 0, overcorrectionRate: 0 });
  });
  test('grammar slip across two words: corrected phrase is an over-correction', () => {
    const t = 'She go\tShe goes\n';
    expect(oc('She go to school.', 'She goes to school.', t)).toMatchObject({ listed: 1, overcorrected: 1 });
    expect(oc('She go to school.', 'She go to school.', t)).toMatchObject({ listed: 1, preserved: 1 });
    expect(oc('She go to school.', 'He goes to school.', t)).toMatchObject({ listed: 1, misread: 1, overcorrected: 0 });
  });
  test('capitalisation slips are mistakes: matching is case-sensitive', () => {
    const t = 'i\tI\n';
    expect(oc('I think i know', 'I think I know', t)).toMatchObject({ listed: 1, overcorrected: 1 });
    expect(oc('I think i know', 'I think i know', t)).toMatchObject({ listed: 1, preserved: 1 });
    expect(oc('society matters', 'Society matters', 'society\tSociety\n')).toMatchObject({ overcorrected: 1 });
  });
  test('punctuation differences around the word are ignored', () => {
    expect(oc('He is powerfull, truly.', 'He is powerfull truly.', P)).toMatchObject({ listed: 1, preserved: 1 });
  });
  test('rate is per occurrence', () => {
    const gt = 'powerfull men and powerfull women and powerfull kids and powerfull dogs';
    const r = oc(gt, 'powerful men and powerfull women and powerfull kids and powerfull dogs', P);
    expect(r).toMatchObject({ listed: 4, overcorrected: 1, preserved: 3 });
    expect(r.overcorrectionRate).toBeCloseTo(0.25, 10);
  });
  test('the corrected spelling elsewhere in the ground truth is not counted as a mistake', () => {
    const r = oc('powerful but powerfull', 'powerful but powerful', P);
    expect(r).toMatchObject({ listed: 1, overcorrected: 1 });
  });
  test('an inserted model word does not break alignment', () => {
    expect(oc('it is powerfull', 'it really is powerfull', P)).toMatchObject({ listed: 1, preserved: 1 });
  });
  test('occurrences inside [?] regions are excluded, not scored', () => {
    const r = oc('a powerfull[?] man', 'a powerful man', P);
    expect(r).toMatchObject({ listed: 0, excludedUncertain: 1, overcorrectionRate: null });
  });
  test('list entries that never occur in the ground truth are reported', () => {
    const r = oc('It is powerfull', 'It is powerfull', P + 'recieve\treceive\n');
    expect(r.unmatchedEntries).toEqual(['recieve']);
  });
  test('without a mistake list the metric is unavailable (null), never a fake 0', () => {
    expect(m.overCorrection('a b', 'a b', null)).toMatchObject({ available: false, overcorrectionRate: null });
    expect(m.overCorrection('a b', 'a b', list('# nothing\n'))).toMatchObject({ available: false, overcorrectionRate: null });
  });
  test('substitutions that are not on the list are counted separately', () => {
    const r = oc('the cat sat on powerfull mat', 'the cut sat on powerfull mat', P);
    expect(r).toMatchObject({ listed: 1, preserved: 1 });
    expect(r.unlistedSubstitutions.count).toBe(1);
    expect(r.unlistedSubstitutions.examples).toEqual([{ gt: 'cat', model: 'cut' }]);
  });
  test('the longest listed phrase wins and a word is never counted twice', () => {
    const r = oc('she go home', 'she goes home', 'go\twent\nshe go\tshe goes\n');
    expect(r).toMatchObject({ listed: 1, overcorrected: 1 });
  });
  test('empty model output: every listed mistake is dropped', () => {
    expect(oc('powerfull and powerfull', '', P)).toMatchObject({ listed: 2, dropped: 2, overcorrected: 0 });
  });
});

describe('suggestMistakes / formatMistakesDraft', () => {
  const gt = 'It is powerfull and strong';
  const outputs = [
    { label: 'A', text: 'It is powerful and strong' },
    { label: 'B', text: 'It is powerful and strong' },
    { label: 'C', text: 'It is powerfull and strang' },
    { label: 'D', text: 'It is powerfull and xyzzy' },
  ];
  test('lists ground-truth words that models changed slightly, most-changed first', () => {
    const c = m.suggestMistakes(gt, outputs);
    expect(c.map(x => x.student)).toEqual(['powerfull', 'strong']);
    expect(c[0].suggestions).toEqual([{ correct: 'powerful', models: ['A', 'B'] }]);
    expect(c[0].modelCount).toBe(2);
    expect(c[1].suggestions).toEqual([{ correct: 'strang', models: ['C'] }]);
  });
  test('ignores changes that are too large to be a spelling fix', () => {
    const c = m.suggestMistakes(gt, outputs);
    expect(JSON.stringify(c)).not.toContain('xyzzy');
  });
  test('does not suggest words inside [?] regions', () => {
    expect(m.suggestMistakes('a powerfull[?] b', [{ label: 'A', text: 'a powerful b' }])).toEqual([]);
  });
  test('draft text is a valid mistakes file, with one line per distinct pair', () => {
    const c = m.suggestMistakes('powerfull and powerfull', [{ label: 'A', text: 'powerful and powerful' }]);
    const draft = m.formatMistakesDraft(c, { name: 'image3' });
    expect(draft.split('\n')[0].startsWith('#')).toBe(true);
    const parsed = list(draft);
    expect(parsed.errors).toEqual([]);
    expect(parsed.entries.map(e => [e.student, e.correct])).toEqual([['powerfull', 'powerful']]);
  });
});
