'use strict';
// "Common mistakes" examples carry the student's sentence (teacher report and teacher PDF only), cut at request time from the same stored
// transcript the highlights use. Nothing is stored or logged. Synthetic text only; no AI or network call.
process.env.NODE_ENV = 'test';

const mongoose = require('mongoose');
const { sentenceSpan, sentenceOf, located, SENTENCE_MAX } = require('../src/services/reportExampleSentence');
const report = require('../src/services/assignmentReport.service');
const { PAGE_SEPARATOR, sha } = require('../src/utils/sourceFidelity');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');

// Starting the in-memory database can take longer than the 5 s default under load (as in the other report tests).
jest.setTimeout(120000);

const LEGEND = { groups: [{ key: 'MECHANICS', symbols: [{ symbol: 'SP', label: 'Spelling' }] }, { key: 'GRAMMAR', symbols: [{ symbol: 'AGR', label: 'Subject-Verb Agreement' }] }] };
/** A correction at the n-th occurrence of `word` in `text`. */
const at = (text, word, { symbol = 'SP', category = 'MECHANICS', suggestion = 'fixed', message = 'Spelling.', nth = 1 } = {}) => {
  let start = -1;
  for (let i = 0; i < nth; i++) start = text.indexOf(word, start + 1);
  if (start < 0) throw new Error(`no ${word}`);
  return { symbol, category, quotedText: word, suggestedText: suggestion, message, startChar: start, endChar: start + word.length };
};
const entry = (key, corrections, submissionId = `${key}-sub`) => ({ key, submissionId, submittedAt: new Date('2026-11-10T09:00:00Z'), corrections });
const plain = parts => parts.map(p => (p.gap ? ' … ' : p.text)).join('');

describe('the sentence around a mistake', () => {
  const text = 'We went to the beach. Then I drank a cub of tea with my grandmother! It was warm.\nNext day we swam.';

  test('cut at sentence boundaries (full stop, exclamation mark, line break), surrounding spaces trimmed', () => {
    const cub = at(text, 'cub');
    expect(text.slice(...Object.values(sentenceSpan(text, cub.startChar, cub.endChar)))).toBe('Then I drank a cub of tea with my grandmother!');
    const warm = at(text, 'warm');
    expect(text.slice(...Object.values(sentenceSpan(text, warm.startChar, warm.endChar)))).toBe('It was warm.');
    const swam = at(text, 'swam');
    expect(text.slice(...Object.values(sentenceSpan(text, swam.startChar, swam.endChar)))).toBe('Next day we swam.');
    const we = at(text, 'We');
    expect(text.slice(...Object.values(sentenceSpan(text, we.startChar, we.endChar)))).toBe('We went to the beach.');
  });

  test('the mistake is a part of its own, with the correction; the rest is plain text', () => {
    expect(sentenceOf(text, [at(text, 'cub', { suggestion: 'cup' })])).toEqual({ cutStart: false, cutEnd: false, parts: [
      { text: 'Then I drank a ' }, { text: 'cub', error: true, corrected: 'cup' }, { text: ' of tea with my grandmother!' }] });
  });

  test('several mistakes in one sentence are one sentence with several marks, in reading order', () => {
    const s = 'We whent to the beach and swiming was fun.';
    expect(sentenceOf(s, [at(s, 'swiming', { suggestion: 'swimming' }), at(s, 'whent', { suggestion: 'went' })]).parts).toEqual([
      { text: 'We ' }, { text: 'whent', error: true, corrected: 'went' }, { text: ' to the beach and ' },
      { text: 'swiming', error: true, corrected: 'swimming' }, { text: ' was fun.' }]);
  });

  test('a very long sentence is shortened around the mistake with an ellipsis, cut at word edges; the mistake always shows', () => {
    const long = `${'Before the trip we packed many things into the car '.repeat(5)}and a wether report said rain ${'after which we drove along the coast road slowly '.repeat(5)}today.`;
    const out = sentenceOf(long, [at(long, 'wether', { suggestion: 'weather' })]);
    expect(out.cutStart).toBe(true); expect(out.cutEnd).toBe(true);
    expect(out.parts.find(p => p.error)).toEqual({ text: 'wether', error: true, corrected: 'weather' });
    expect(plain(out.parts).length).toBeLessThanOrEqual(SENTENCE_MAX);
    expect(out.parts[0].text.startsWith(' ')).toBe(false);
    expect(long.includes(out.parts[0].text)).toBe(true);
    expect(/^\S/u.test(out.parts[0].text) && long[long.indexOf(out.parts[0].text) - 1] === ' ').toBe(true);
  });

  test('two mistakes far apart in a long sentence keep both visible, with a gap between them', () => {
    const long = `My frend ${'walked with me along the river past the old mill and the bridge '.repeat(6)}and we sawe ducks.`;
    const out = sentenceOf(long, [at(long, 'frend', { suggestion: 'friend' }), at(long, 'sawe', { suggestion: 'saw' })]);
    expect(out.parts.filter(p => p.error).map(p => p.text)).toEqual(['frend', 'sawe']);
    expect(out.parts.some(p => p.gap)).toBe(true);
    expect(out.cutStart).toBe(false); expect(out.cutEnd).toBe(false);
    expect(plain(out.parts).length).toBeLessThanOrEqual(SENTENCE_MAX);
  });

  test('a stored position that no longer points at the words gives no sentence (the word pair stays)', () => {
    const c = { ...at(text, 'cub'), startChar: 3, endChar: 6 };
    expect(located(text, c)).toBe(false);
    expect(sentenceOf(text, [c])).toBeNull();
    expect(sentenceOf(text, [{ ...at(text, 'cub'), startChar: undefined }])).toBeNull();
    expect(sentenceOf('', [at(text, 'cub')])).toBeNull();
  });

  test('control characters and runs of spaces in the transcript are cleaned in the parts', () => {
    const s = 'Then\tI  drank a cub\u0007 of tea.';
    expect(plain(sentenceOf(s, [at(s, 'cub')]).parts)).toBe('Then I drank a cub of tea.');
  });

  test('two handwritten pages: the page break is a sentence break', () => {
    const exact = `First page ends with no full stop${PAGE_SEPARATOR}second page has a mistaek here.`;
    expect(plain(sentenceOf(exact, [at(exact, 'mistaek')]).parts)).toBe('second page has a mistaek here.');
  });
});

describe('commonMistakesOf with transcripts', () => {
  const textA = 'I drank a cub of tea. Later we whent home and swiming was fun.';
  const textB = 'My cub was hot. We sat outside.';
  const transcripts = new Map([['a-sub', textA], ['b-sub', textB]]);
  const entries = () => [
    entry('u:a', [at(textA, 'cub', { suggestion: 'cup' }), at(textA, 'whent', { suggestion: 'went' }), at(textA, 'swiming', { suggestion: 'swimming' })], 'a-sub'),
    entry('u:b', [at(textB, 'cub', { suggestion: 'cup' })], 'b-sub')];

  test('examples carry the sentence; mistakes of a type in one sentence are grouped into one example', () => {
    const sp = report.commonMistakesOf(entries(), LEGEND, { transcripts }).types[0];
    expect(sp.typeCode).toBe('SP');
    expect(sp.examples).toHaveLength(3);
    const grouped = sp.examples.find(e => e.sentence && e.sentence.parts.filter(p => p.error).length === 2);
    expect(plain(grouped.sentence.parts)).toBe('Later we whent home and swiming was fun.');
    expect(grouped).toEqual(expect.objectContaining({ original: 'whent', corrected: 'went', explanation: 'Spelling.' }));
    for (const e of sp.examples) expect(Object.keys(e).sort()).toEqual(['corrected', 'explanation', 'original', 'sentence']);
  });

  test('without a transcript (or when it cannot be read) the example is the word pair only, as before', () => {
    const sp = report.commonMistakesOf(entries(), LEGEND, {}).types[0];
    for (const e of sp.examples) expect(Object.keys(e).sort()).toEqual(['corrected', 'explanation', 'original']);
  });

  test('up to five examples per type, one per student before a second from anyone', () => {
    const many = Array.from({ length: 7 }, (_, i) => {
      const t = `Student ${'abcdefg'[i]} wrote mistak number ${i} here.`;
      transcripts.set(`m${i}-sub`, t);
      return entry(`u:m${i}`, [at(t, 'mistak', { suggestion: 'mistake' })], `m${i}-sub`);
    });
    const sp = report.commonMistakesOf(many, LEGEND, { transcripts }).types[0];
    expect(report.COMMON_EXAMPLES).toBe(5);
    expect(sp.examples).toHaveLength(5);
    expect(new Set(sp.examples.map(e => plain(e.sentence.parts))).size).toBe(5);
  });

  test('the same sentence with the same correction from two students is shown once, even with different spacing; a different correction is shown', () => {
    const one = 'We  went to the beach.  Then I drank a cub of tea.', two = 'We went to the beach. Then I  drank a cub of tea.', three = 'Then I drank a cub of tea.';
    const sentences = new Map([['p1', one], ['p2', two], ['p3', three]]);
    const list = [entry('u:p1', [at(one, 'cub', { suggestion: 'cup' })], 'p1'), entry('u:p2', [at(two, 'cub', { suggestion: 'cup' })], 'p2'),
      entry('u:p3', [at(three, 'cub', { suggestion: 'mug' })], 'p3')];
    const sp = report.commonMistakesOf(list, LEGEND, { transcripts: sentences }).types[0];
    expect(sp.examples.map(e => e.corrected).sort()).toEqual(['cup', 'mug']);
  });

  test('only sentences of the submissions chosen for examples are needed (at most five types x five examples)', () => {
    const ids = report.exampleSubmissionIds(entries(), LEGEND);
    expect(ids.sort()).toEqual(['a-sub', 'b-sub']);
    const wide = Array.from({ length: 40 }, (_, i) => entry(`u:w${i}`, [at('A mistak.', 'mistak')], `w${i}-sub`));
    expect(report.exampleSubmissionIds(wide, LEGEND).length).toBeLessThanOrEqual(25);
  });
});

describe('loading the transcripts for the examples', () => {
  beforeAll(connectInMemoryMongo);
  afterAll(disconnectInMemoryMongo);
  const Submission = () => require('../src/models/Submission');
  const id = () => new mongoose.Types.ObjectId();

  test('typed (OCR pages) and handwritten exact-source (two pages) essays give the same text the highlights use; reads transcript fields only', async () => {
    const typedFile = id(), handFile = id();
    const typedText = 'I drank a cub of tea.';
    const pageOne = 'On holiday we went to the sea', pageTwo = 'and I drank a cub of tea there.';
    const base = { student: id(), assignment: id(), class: id(), status: 'submitted', submittedAt: new Date(), isLate: false };
    const typed = await Submission().create({ ...base, files: [typedFile], ocrPages: [{ fileId: typedFile, fileOrder: 0, pageIndex: 0, pageNumber: 1, text: typedText,
      words: typedText.split(' ').map((w, i) => ({ id: `w${i}`, text: w, page: 1 })) }] });
    const exactText = pageOne + PAGE_SEPARATOR + pageTwo;
    const hand = await Submission().create({ ...base, files: [handFile], sourceFidelityMode: 'astra_verified', sourceFidelityStatus: 'MODEL_AGREED',
      sourceFidelityVersion: 'astra-fable-exact-v1', sourceTranscriptExact: exactText, sourceTranscriptSha256: sha(exactText),
      ocrPages: [{ fileId: handFile, fileOrder: 0, pageIndex: 0, pageNumber: 1, sourceFidelityMode: 'astra_verified', sourceFidelityStatus: 'MODEL_AGREED',
        sourceFidelityVersion: 'astra-fable-exact-v1', sourceTextExact: pageOne, sourceTextSha256: sha(pageOne) },
      { fileId: handFile, fileOrder: 0, pageIndex: 1, pageNumber: 2, sourceFidelityMode: 'astra_verified', sourceFidelityStatus: 'MODEL_AGREED',
        sourceFidelityVersion: 'astra-fable-exact-v1', sourceTextExact: pageTwo, sourceTextSha256: sha(pageTwo) }] });
    const spy = jest.spyOn(Submission(), 'find');
    const texts = await report.loadExampleTranscripts([String(typed._id), String(hand._id), String(id())]);
    expect(spy).toHaveBeenCalledTimes(1);
    const projection = spy.mock.results[0].value.projection();
    expect(Object.keys(projection).sort()).toEqual([...report.EXAMPLE_TRANSCRIPT_FIELDS].sort());
    for (const field of ['writingCorrections', 'teacherAnnotations', 'guest', 'guest.normalizedEmail', 'student']) expect(projection[field]).toBeUndefined();
    spy.mockRestore();
    expect(texts.get(String(typed._id))).toContain('I drank a cub of tea.');
    expect(texts.get(String(hand._id))).toBe(exactText);
    expect(plain(sentenceOf(exactText, [at(exactText, 'cub')]).parts)).toBe('and I drank a cub of tea there.');
    expect(await report.loadExampleTranscripts([])).toEqual(new Map());
  });
});

describe('the AI summary never receives the sentences', () => {
  test('the summary input is built from counts, errors, insights, rubric and scores only', () => {
    const { buildSummaryInput } = require('../src/services/assignmentReportSummary.service');
    const text = 'Unique synthetic sentence with a mistaek in it.';
    const r = { version: 'assignment-report-v1', timeZone: 'UTC', assignment: { title: 'Synthetic', className: 'C', writingType: null },
      counts: { total: 4, scored: 4, reviewed: 0, late: 0, inProgress: 0, notScored: 0 },
      scores: { average: 70, median: 70, highest: 80, lowest: 60, onTrack: 1, needsRevision: 3, needsAttention: 0, needsRevisionPct: 75, needsAttentionPct: 0, reviewedPct: 0, bands: [] },
      rubric: { kind: 'builtin', strongestKey: null, weakestKey: null, criteria: [] },
      errors: { basis: 'ai_analysis', total: 1, symbolTotal: 1, submissionsWithCorrections: 1, categories: [], symbols: [] }, insights: [],
      commonMistakes: { state: 'ok', types: [{ typeCode: 'SP', isCommon: true, studentCount: 2, examples: [{ original: 'mistaek', corrected: 'mistake', explanation: 'Spelling.',
        sentence: { cutStart: false, cutEnd: false, parts: [{ text: 'Unique synthetic sentence with a ' }, { text: 'mistaek', error: true, corrected: 'mistake' }, { text: ' in it.' }] } }] }] } };
    const input = JSON.stringify(buildSummaryInput(r));
    expect(input).not.toContain('Unique synthetic sentence');
    expect(input).not.toContain('mistaek');
    expect(input).not.toContain(text);
  });
});
