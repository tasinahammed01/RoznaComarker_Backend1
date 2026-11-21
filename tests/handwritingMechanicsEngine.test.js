'use strict';

// Offline only: synthetic text, mocked model replies, no network, no database.
const engine = require('../src/services/handwritingMechanics/engine');
const semantic = require('../src/services/semanticWritingCorrections.service');

const PAGE_SEPARATOR = '\n\n\f\n\n';
/** Stored-geometry tokens (split on whitespace, like alignGeometry) with a percent box per token. */
function storedWords(text, boxFor = (i, lineNo) => ({ x: 5 + 10 * i, y: 10 + 10 * lineNo, w: 8, h: 4 })) {
  const words = []; let lineNo = 0, lineStart = 0, i = 0;
  for (const m of text.matchAll(/\S+/gu)) {
    const before = text.slice(lineStart, m.index), breaks = (before.match(/\n/gu) || []).length;
    if (breaks) { lineNo += breaks; lineStart = text.lastIndexOf('\n', m.index) + 1; i = 0; }
    words.push({ text: m[0], sourceStart: m.index, sourceEnd: m.index + m[0].length, bbox: boxFor(i, lineNo, m[0]) }); i += 1;
  }
  return words;
}
const page = (text, extra = {}) => ({ text, startChar: 0, words: storedWords(text), width: 1000, height: 2000, ...extra });
const reply = (items, { marks = {}, cases = {} } = {}) => ({
  marks: items.marks.map((m, i) => ({ space_before: false, space_after: true, confidence: 0.95, ...(marks[i] || {}) })),
  cases: items.words.map((w, i) => ({ case_as_written: /^\p{Lu}/u.test(w.text) ? 'capital' : 'small', is_proper_noun: 'false', confidence: 0.95,
    ...(cases[i] || {}) }))
});
const single = text => { const lines = engine.pageLines(page(text)); return { lines, items: engine.groupItems([lines[0]]) }; };
const run = (transcript, items, r, minConfidence = 0.8) => engine.candidates(items, r, { ...engine.textContext(transcript), minConfidence })
  .map(c => engine.buildFinding(c, transcript));

describe('lines and geometry', () => {
  test('page text -> lines with absolute offsets, a pixel box from percent geometry, blank lines skipped', () => {
    const text = 'One two.\n\nThree four';
    const lines = engine.pageLines(page(text, { startChar: 100 }));
    expect(lines.map(l => [l.text, l.startChar, l.endChar])).toEqual([['One two.', 100, 108], ['Three four', 110, 120]]);
    // line 0: tokens at x 5..13 and 15..23 percent of 1000 px, y 10..14 percent of 2000 px.
    expect(lines[0].box).toEqual({ x0: 50, x1: 230, y0: 200, y1: 280, wordHeight: 80 });
    expect(lines[1].box.y0).toBe(600);
  });

  test('a line with no boxed token is skipped; a line with one unboxed word keeps the full page width', () => {
    const text = 'aa bb\ncc dd';
    const words = storedWords(text).map((w, i) => (i >= 2 ? { ...w, bbox: null } : w));
    expect(engine.pageLines(page(text, { words })).map(l => l.reason)).toEqual([null, 'NO_GEOMETRY']);
    const partial = storedWords(text).map((w, i) => (i === 1 ? { ...w, bbox: null } : w));
    expect(engine.pageLines(page(text, { words: partial }))[0].box).toMatchObject({ x0: 0, x1: 1000 });
    const missing = storedWords(text).filter((_, i) => i !== 1);
    expect(engine.pageLines(page(text, { words: missing }))[0].box).toMatchObject({ x0: 0, x1: 1000 });
    expect(engine.pageLines(page(text))[0].box).toMatchObject({ x0: 50, x1: 230 });
  });

  test('stored exact-source boxes are corners {x0, y0, x1, y1} (as the OCR pipeline saves them): same lines and boxes', () => {
    const text = 'One two.\n\nThree four';
    const corners = storedWords(text).map(w => ({ ...w, bbox: { x0: w.bbox.x, y0: w.bbox.y, x1: w.bbox.x + w.bbox.w, y1: w.bbox.y + w.bbox.h } }));
    const stored = engine.pageLines(page(text, { startChar: 100, words: corners }));
    expect(stored.map(l => l.reason)).toEqual([null, null]);
    expect(stored).toEqual(engine.pageLines(page(text, { startChar: 100 })));
    expect(stored[0].box).toEqual({ x0: 50, x1: 230, y0: 200, y1: 280, wordHeight: 80 });
    // An empty or broken corner box counts as no box, like the highlights (normalizeOcrWordsFromStored).
    for (const bad of [{ x0: 5, y0: 10, x1: 5, y1: 14 }, { x0: 5, y0: 10, x1: 13, y1: 9 }, { x0: 'a', y0: 10, x1: 13, y1: 14 }]) {
      const words = corners.map(w => ({ ...w, bbox: bad }));
      expect(engine.pageLines(page(text, { words })).map(l => l.reason)).toEqual(['NO_GEOMETRY', 'NO_GEOMETRY']);
    }
  });

  test('stored words whose text does not match the transcript are ignored; a page without a size is skipped', () => {
    const text = 'aa bb';
    const words = storedWords(text).map(w => ({ ...w, text: 'zz' }));
    expect(engine.pageLines(page(text, { words }))[0].reason).toBe('NO_GEOMETRY');
    expect(engine.pageLines(page(text, { width: 0 }))[0].reason).toBe('PAGE_SIZE_MISSING');
  });

  test('lines are grouped one per crop by default, or N per crop; skipped lines are reported', () => {
    const text = 'a1 b\nc d\ne f\ng h\ni j';
    const lines = engine.pageLines(page(text, { words: storedWords(text).filter(w => w.text !== 'e' && w.text !== 'f') }));
    const one = engine.groupLines(lines);
    expect(one.groups.map(g => g.map(l => l.text))).toEqual([['a1 b'], ['c d'], ['g h'], ['i j']]);
    expect(one.skipped.map(l => l.text)).toEqual(['e f']);
    expect(engine.groupLines(lines, 3).groups.map(g => g.length)).toEqual([3, 1]);
    expect(engine.groupLines(lines, 'x').groups).toHaveLength(4);
  });

  test('crop = union of the group, 35% of the word height above and below, 2% of the width at the sides, inside the image', () => {
    const lines = engine.pageLines(page('aa bb\ncc'));
    expect(engine.cropBox([lines[0]], 1000, 2000)).toEqual({ left: 30, top: 172, width: 220, height: 136 });
    expect(engine.cropBox(lines, 1000, 2000)).toEqual({ left: 30, top: 172, width: 220, height: 336 });
    const edge = [{ box: { x0: 0, x1: 1000, y0: 1950, y1: 2000, wordHeight: 50 } }];
    expect(engine.cropBox(edge, 1000, 2000)).toEqual({ left: 0, top: 1932, width: 1000, height: 68 });
  });
});

describe('prompt, schema and reply', () => {
  test('words and marks are numbered in reading order across the lines of a group', () => {
    const lines = engine.pageLines(page('they have .We know\nso it is,'));
    const items = engine.groupItems(lines);
    expect(items.words.map(w => w.text)).toEqual(['they', 'have', 'We', 'know', 'so', 'it', 'is']);
    expect(items.marks.map(m => [m.text, m.before.text, m.after?.text ?? null, m.line])).toEqual([['.', 'have', 'We', 0], [',', 'is', null, 1]]);
    const message = engine.userMessage(lines, items);
    expect(message).toContain('1: "they have .We know"');
    expect(message).toContain('1. "." after "have" (line 1)');
    expect(message).toContain('7. is (line 2)');
    expect(engine.PROMPT).not.toMatch(/they|have/u);
  });

  test('the schema sends no item-count limits (v3: counts are checked by the parser) and asks a confidence per word', () => {
    const { items } = single('Kids these days , ok');
    const schema = engine.responseSchema(items);
    expect(JSON.stringify(schema)).not.toMatch(/minItems|maxItems/u);
    expect(schema.properties.marks.type).toBe('array');
    expect(schema.properties.cases.items.required).toEqual(['case_as_written', 'is_proper_noun', 'confidence']);
    expect(schema.properties.cases.items.properties.is_proper_noun).toEqual({ type: 'string', enum: ['true', 'false', 'unsure'] });
    expect(schema.additionalProperties).toBe(false);
    expect(engine.SCHEMA_VERSION).toBe('handwriting-mechanics-schema-v3');
    expect(engine.PROMPT_VERSION).toBe('handwriting-mechanics-prompt-v2');
    expect(engine.PROMPT).toMatch(/is_proper_noun/u);
    expect(engine.PROMPT).toMatch(/nationality, language, month or day/u);
  });

  test('a reply with a wrong count, a bad value or broken JSON is rejected as a whole', () => {
    const { items } = single('Kids these days , ok');
    const good = reply(items);
    expect(engine.parseReply(JSON.stringify(good), items)).toMatchObject({ ok: true });
    expect(engine.parseReply('{', items)).toEqual({ ok: false, reason: 'REPLY_NOT_JSON' });
    expect(engine.parseReply({ ...good, cases: good.cases.slice(1) }, items)).toEqual({ ok: false, reason: 'REPLY_COUNT_MISMATCH' });
    expect(engine.parseReply({ ...good, marks: [] }, items)).toEqual({ ok: false, reason: 'REPLY_COUNT_MISMATCH' });
    expect(engine.parseReply({ marks: good.marks }, items)).toEqual({ ok: false, reason: 'REPLY_SHAPE' });
    expect(engine.parseReply({ ...good, marks: [{ ...good.marks[0], confidence: 1.2 }] }, items)).toEqual({ ok: false, reason: 'REPLY_SHAPE' });
    expect(engine.parseReply({ ...good, marks: [{ ...good.marks[0], space_before: 'yes' }] }, items)).toEqual({ ok: false, reason: 'REPLY_SHAPE' });
    expect(engine.parseReply({ ...good, cases: good.cases.map(c => ({ ...c, case_as_written: 'upper' })) }, items))
      .toEqual({ ok: false, reason: 'REPLY_SHAPE' });
    expect(engine.parseReply({ ...good, cases: good.cases.map(c => ({ ...c, is_proper_noun: true })) }, items))
      .toEqual({ ok: false, reason: 'REPLY_SHAPE' });
    expect(engine.parseReply({ ...good, cases: good.cases.map(({ is_proper_noun, ...c }) => c) }, items))
      .toEqual({ ok: false, reason: 'REPLY_SHAPE' });
  });
});

describe('proper nouns: "written capital, transcript lowercase, mid-sentence" only for a word that is not a name', () => {
  const transcript = 'We went to india on monday with an omani friend.';
  const capitals = (proper) => Object.fromEntries([3, 5, 8].map(i => [i, { case_as_written: 'capital', is_proper_noun: proper }]));
  test('a name, nationality or day written with a capital gives no finding when the model says proper noun or unsure', () => {
    const { items } = single(transcript);
    expect(run(transcript, items, reply(items, { cases: capitals('true') }))).toEqual([]);
    expect(run(transcript, items, reply(items, { cases: capitals('unsure') }))).toEqual([]);
    // Only an explicit "false" lets the rule fire (proves the gate, not the words, decides).
    expect(run(transcript, items, reply(items, { cases: capitals('false') })).map(f => f.quotedText)).toEqual(['india', 'monday', 'omani']);
  });
  test('"Kids" and "Out" with is_proper_noun false still give findings', () => {
    const text = 'We see kids today and feel left out of it.';
    const { items } = single(text);
    const found = run(text, items, reply(items, { cases: { 2: { case_as_written: 'capital' }, 7: { case_as_written: 'capital' } } }));
    expect(found.map(f => f.message)).toEqual(['You wrote "Kids" in the middle of a sentence. Use a small letter: "kids".',
      'You wrote "Out" in the middle of a sentence. Use a small letter: "out".']);
  });
  test('never when the same word is written with a capital mid-sentence elsewhere in the essay (any page)', () => {
    const text = `We met Sam at school.\nLater sam came home.${PAGE_SEPARATOR}Then we saw sam again.`;
    const items = engine.groupItems(engine.pageLines(page(text)));
    const samIndexes = items.words.map((w, i) => (w.text === 'sam' ? i : -1)).filter(i => i >= 0);
    const cases = Object.fromEntries(samIndexes.map(i => [i, { case_as_written: 'capital' }]));
    expect(run(text, items, reply(items, { cases }))).toEqual([]);
    expect(engine.textContext(text).capitalised.has('sam')).toBe(true);
  });
  test('a capital only at a sentence start elsewhere does not count as a name ("For example" vs "for")', () => {
    const text = 'For example, it works. It is good for kids.';
    expect(engine.textContext(text).capitalised.has('for')).toBe(false);
    const { items } = single(text);
    const found = run(text, items, reply(items, { cases: { 7: { case_as_written: 'capital' } } }));
    expect(found.map(f => f.quotedText)).toEqual(['for']);
  });
  test('the other direction is not affected: small letter at a sentence start and the lone "i" ignore is_proper_noun', () => {
    const text = 'then i left.';
    const { items } = single(text);
    const found = run(text, items, reply(items, { cases: { 0: { is_proper_noun: 'true' }, 1: { is_proper_noun: 'unsure' } } }));
    expect(found.map(f => f.quotedText)).toEqual(['then', 'i']);
  });
});

describe('candidate rules and findings', () => {
  test('space before a mark: quote is the transcript span; the message shows the written form and the fix', () => {
    const transcript = 'Kids these days , they win.';
    const { items } = single(transcript);
    const [finding] = run(transcript, items, reply(items, { marks: { 0: { space_before: true } } }));
    expect(finding).toEqual({ category: 'MECHANICS', symbol: 'SPC', quotedText: 'days ,', suggestedText: 'days,', occurrence: 0,
      message: 'You wrote "days ,". Write "days," (no space before the comma).', confidence: 0.95, severity: 'low',
      correctionKind: 'localized', detector: 'handwriting-mechanics-v1', startChar: 11, endChar: 17 });
  });

  test('the reader tidied the text: quote and fix are identical, the message still shows what was written', () => {
    const transcript = 'Kids these days, they win.';
    const { items } = single(transcript);
    const [finding] = run(transcript, items, reply(items, { marks: { 0: { space_before: true } } }));
    expect(finding).toMatchObject({ quotedText: 'days,', suggestedText: 'days,', message: 'You wrote "days ,". Write "days," (no space before the comma).' });
  });

  test('missing space after (with a space before): one finding up to the next word', () => {
    for (const transcript of ['They have .We know it.', 'They have. We know it.', 'They have.We know it.']) {
      const { items } = single(transcript);
      const found = run(transcript, items, reply(items, { marks: { 0: { space_before: true, space_after: false } } }));
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ symbol: 'SPC', quotedText: transcript.slice(5, transcript.indexOf('We') + 2), suggestedText: 'have. We',
        message: 'You wrote "have .We". Write "have. We".' });
    }
    const transcript = 'They have.We know it.';
    const { items } = single(transcript);
    expect(run(transcript, items, reply(items, { marks: { 0: { space_after: false } } }))[0].message).toBe('You wrote "have.We". Write "have. We".');
  });

  test('no spacing finding when the gaps are normal, when the mark ends the line, for numbers and one-letter abbreviations', () => {
    const transcript = 'It is happiness. For example, we pay 3.5 or 1,000 at 10:30 i.e. now.';
    const { items } = single(transcript);
    const r = reply(items);
    expect(run(transcript, items, r)).toEqual([]);
    // the model says "no space after" for every mark: only marks followed by an ordinary word on the same line can count.
    const tight = reply(items, { marks: Object.fromEntries(items.marks.map((_, i) => [i, { space_after: false }])) });
    expect(run(transcript, items, tight).map(f => f.quotedText)).toEqual(['happiness. For', 'example, we']);
    const endOfLine = 'They won.';
    const one = single(endOfLine);
    expect(run(endOfLine, one.items, reply(one.items, { marks: { 0: { space_after: false } } }))).toEqual([]);
  });

  test('a mark after a non-word (quote, bracket) is not judged', () => {
    const transcript = 'He said "no" , then left.';
    const { items } = single(transcript);
    expect(run(transcript, items, reply(items, { marks: { 0: { space_before: true } } }))).toEqual([]);
  });

  test('capital written in the middle of a sentence where the transcript is lowercase', () => {
    const transcript = 'We see kids these days. Out of it.';
    const { items } = single(transcript);
    const found = run(transcript, items, reply(items, { cases: { 2: { case_as_written: 'capital' } } }));
    expect(found).toEqual([expect.objectContaining({ symbol: 'CAP', quotedText: 'kids', suggestedText: 'kids', startChar: 7, endChar: 11,
      message: 'You wrote "Kids" in the middle of a sentence. Use a small letter: "kids".' })]);
  });

  test('no CAP finding for capitals at a sentence start, capitals already in the transcript, digits or unclear letters', () => {
    const transcript = 'we met. then In 2026 we left';
    const { items } = single(transcript);
    const cases = { 2: { case_as_written: 'capital' }, 3: { case_as_written: 'capital' }, 4: { case_as_written: 'capital' }, 5: { case_as_written: 'capital' } };
    // Only "we" at 0 (a sentence start written small) and "we" at 21 (written capital mid-sentence) are findings.
    expect(run(transcript, items, reply(items, { cases })).map(f => [f.quotedText, f.startChar])).toEqual([['we', 0], ['we', 21]]);
    const unclear = { 0: { case_as_written: 'unclear' }, 5: { case_as_written: 'unclear' } };
    expect(run(transcript, items, reply(items, { cases: { ...cases, ...unclear } }))).toEqual([]);
  });

  test('small letter at a sentence start, including across lines and pages, and the lone "I" written small', () => {
    const transcript = `It rained.\nthen i'm ok and i left.${PAGE_SEPARATOR}so we went.`;
    const starts = engine.sentenceStarts(transcript);
    expect([...starts].map(at => transcript.slice(at, at + 4))).toEqual(['It r', 'then', 'so w']);
    const lines = engine.pageLines(page(transcript));
    const items = engine.groupItems(lines);
    const found = run(transcript, items, reply(items));
    expect(found.map(f => [f.quotedText, f.suggestedText, f.occurrence])).toEqual([['then', 'Then', 0], ["i'm", "I'm", 0], ['i', 'I', 1], ['so', 'So', 0]]);
    expect(found.map(f => f.message)).toEqual(['You wrote "then" at the start of a sentence. Use a capital letter: "Then".',
      'You wrote "i\'m". Use a capital letter: "I\'m".', 'You wrote "i". Use a capital letter: "I".',
      'You wrote "so" at the start of a sentence. Use a capital letter: "So".']);
  });

  test('the confidence floor is applied per mark and per word (0.80 kept, below dropped) and is configurable', () => {
    const transcript = 'Kids these days , they win.';
    const { items } = single(transcript);
    const r = reply(items, { marks: { 0: { space_before: true, confidence: 0.8 } }, cases: { 4: { case_as_written: 'capital', confidence: 0.79 } } });
    expect(run(transcript, items, r).map(f => f.symbol)).toEqual(['SPC']);
    expect(run(transcript, items, r, 0.9)).toEqual([]);
    expect(run(transcript, items, r, 0.7).map(f => f.symbol)).toEqual(['SPC', 'CAP']);
  });

  test('occurrence is the whole-word occurrence of the exact span; an ungroundable quote is dropped', () => {
    const transcript = 'i think in it, i know it , i do.';
    const { items } = single(transcript);
    const found = run(transcript, items, reply(items, { marks: { 1: { space_before: true } },
      cases: { 4: { case_as_written: 'capital' }, 7: { case_as_written: 'capital' } } }));
    // "i" written as a capital mid-sentence (words 4 and 7) is correct writing: never "use a small letter".
    expect(found.filter(f => f.symbol === 'CAP').map(f => [f.quotedText, f.occurrence, f.startChar])).toEqual([['i', 0, 0]]);
    const loneI = found.filter(f => f.quotedText === 'i');
    expect(loneI).toHaveLength(1);
    expect(found.find(f => f.symbol === 'SPC')).toMatchObject({ quotedText: 'it ,', occurrence: 0, startChar: 22 });
    const later = run(transcript, items, reply(items))
      .find(f => f.startChar === 15);
    expect(later).toMatchObject({ quotedText: 'i', occurrence: 1 });
    const candidate = engine.candidates(items, reply(items), engine.textContext(transcript))[0];
    expect(engine.buildFinding(candidate, transcript, { locateQuote: () => null })).toEqual({ dropped: 'QUOTE_NOT_GROUNDED' });
    expect(engine.buildFinding(candidate, transcript, { locateQuote: () => ({ start: 5, end: 6 }) })).toEqual({ dropped: 'QUOTE_NOT_GROUNDED' });
  });

  test('a message over the validator limit is dropped, not truncated', () => {
    const long = `${'x'.repeat(130)} ,`;
    const { items } = single(long);
    const [candidate] = engine.candidates(items, reply(items, { marks: { 0: { space_before: true } } }), { starts: new Set() });
    expect(engine.buildFinding(candidate, long)).toEqual({ dropped: 'MESSAGE_TOO_LONG' });
  });

  test('a finding that changes the text passes the real correction validator unchanged (exact-source)', () => {
    const transcript = 'Kids these days , they won.';
    const { items } = single(transcript);
    const found = run(transcript, items, reply(items, { marks: { 0: { space_before: true } } }));
    const legend = semantic.compactSemanticLegend();
    const result = semantic.validateCorrections(found, { transcript, legend, spans: [], sourceKind: 'exact_source', env: {} });
    expect(result.corrections).toHaveLength(1);
    expect(result.corrections[0]).toMatchObject({ symbol: 'SPC', quotedText: 'days ,', suggestedText: 'days,', startChar: 11, endChar: 17 });
  });
});

describe('synthetic essay shaped like the social-media photo', () => {
  // Same mark/case situations as the real photo, different words. As in the real transcript, "kids", "out" and "for" are lowercase
  // mid-sentence in the text but written with a capital; the image observations are given as the mocked reply.
  const transcript = ['Many persone . Social media is fun to use', 'they have .We think so and it is', 'part of social media .Nowadays all of us',
    'see children these days , and happieness. For example, kids feel left', 'out of it as well. Moreover, for them it is new'].join('\n');
  test.each([1, 3])('expected spacing and capitals are found; normal marks are not (%i line(s) per crop)', perCrop => {
    const { groups } = engine.groupLines(engine.pageLines(page(transcript)), perCrop);
    const findings = [];
    for (const group of groups) {
      const items = engine.groupItems(group);
      const marks = Object.fromEntries(items.marks.map((m, i) => [i, { space_before: m.spaceBefore, space_after: !(m.after && !m.after.spaceBefore) }]));
      const cases = Object.fromEntries(items.words.map((w, i) => [i, { case_as_written:
        /^\p{Lu}/u.test(w.text) || ['kids', 'out', 'for'].includes(w.text) ? 'capital' : 'small' }]));
      const parsed = engine.parseReply(JSON.stringify(reply(items, { marks, cases })), items);
      findings.push(...run(transcript, items, parsed));
    }
    expect(findings.map(f => `${f.symbol}:${f.quotedText}`).sort()).toEqual(['CAP:for', 'CAP:kids', 'CAP:out', 'SPC:days ,', 'SPC:have .We',
      'SPC:media .Nowadays', 'SPC:persone .']);
    expect(findings.find(f => f.quotedText === 'out').message).toBe('You wrote "Out" in the middle of a sentence. Use a small letter: "out".');
    expect(findings.some(f => /happieness|example|Moreover/u.test(f.quotedText))).toBe(false);
  });
  test('a page without any finding (like the necklace photo) gives nothing', () => {
    const clean = 'My grandmother gave me a necklace. It is old, and I wear it.\nWe keep it safe.';
    const items = engine.groupItems(engine.pageLines(page(clean)));
    expect(run(clean, items, reply(items))).toEqual([]);
  });
  test('abbreviation context: "i.e." letters are neither sentence starts nor findings', () => {
    const text = 'Use it, i.e. now. e.g. this';
    const { starts, abbreviations } = engine.textContext(text);
    expect([...abbreviations].map(at => text[at])).toEqual(['i', 'e', 'e', 'g']);
    expect([...starts].map(at => text.slice(at, at + 3))).toEqual(['Use', 'e.g']);
  });
});
