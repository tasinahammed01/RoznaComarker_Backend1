const { deriveVisualTarget, validateVisualTarget } = require('../src/services/correctionVisualTarget.service');
const { normalizeCorrection, mapOffsetsToWords, statistics } = require('../src/services/correctionCanonical.service');
const { defaultLegend } = require('../src/services/writingCorrections.service');
const { normalizeCorrectionWordIds } = require('../src/services/canonicalCorrectionResponse.service');
const spansFor = (text, offset = 0) => [...text.matchAll(/[\p{L}\p{M}\p{N}]+|[^\s\p{L}\p{M}\p{N}]/gu)].map((m, i) => ({
  wordId: `w${offset}_${i}`, fileId: 'f', page: 1, start: offset + m.index, end: offset + m.index + m[0].length,
  word: { text: m[0], confidence: 0.9 }, bbox: { x0: i * 3, y0: 1, x1: i * 3 + 2, y1: 3 }
}));
const raw = (symbol, quotedText, suggestedText, offset = 0) => ({ symbol, category: 'GRAMMAR', quotedText,
  suggestedText, startChar: offset, endChar: offset + quotedText.length });
const run = (code, text, suggestion, offset = 0) => {
  const spans = spansFor(text, offset); return { spans, target: deriveVisualTarget(raw(code, text, suggestion, offset), spans) };
};
describe('additive visual target contract', () => {
  test.each([
    ['SP', 'spel', 'spell', 'spel'], ['CAP', 'she went', 'She went', 'she'],
    ['AGR', 'students was ready', 'students were ready', 'was'],
    ['PREP', 'went at school', 'went to school', 'at'],
    ['VF', 'they walk', 'they walked', 'walk'], ['AGR', 'he learn', 'he learns', 'learn']
  ])('%s targets only the changed token', (code, text, suggestion, expected) => {
    const { spans, target } = run(code, text, suggestion);
    // SP insertion inside a token still targets that existing token.
    expect(target.wordIds.map(id => spans.find(s => s.wordId === id).word.text)).toEqual([expected]);
  });
  test('article insertion anchors a word boundary', () => {
    const { target, spans } = run('ART', 'saw cat', 'saw a cat');
    expect(target.anchors).toEqual([expect.objectContaining({ wordId: spans[0].wordId, side: 'after', operation: 'INSERT' })]);
  });
  test('sentence evidence can have two punctuation insertion anchors in one correction', () => {
    const { target, spans } = run('P', 'I went home however I was tired', 'I went home; however, I was tired');
    expect(target.wordIds).toEqual([]);
    expect(target.anchors.map(a => spans.find(s => s.wordId === a.wordId).word.text)).toEqual(['home', 'however']);
    expect(target.anchors.map(a => a.punctuation)).toEqual([';', ',']);
  });
  test('comma insertion from multiline evidence remains one boundary', () => {
    const { target } = run('P', 'After school\nwe played.', 'After school,\nwe played.');
    expect(target.anchors).toHaveLength(1); expect(target.wordIds).toHaveLength(0);
  });
  test('unchanged contractions do not prevent a separate punctuation boundary', () => {
    expect(run('P', "don't go home however", "don't go home, however").target.anchors).toHaveLength(1);
  });
  test('identical historical source and suggestion stays legacy instead of inventing an anchor', () => {
    expect(run('P','she understands her feelings.','she understands her feelings.').target).toBeUndefined();
  });
  test('punctuation deletion marks the existing punctuation token', () => {
    const { target, spans } = run('P', 'went, home', 'went home');
    expect(target.wordIds.map(id => spans.find(s => s.wordId === id).word.text)).toEqual([',']);
  });
  test.each([['go go', 'go'], ['home is nice', 'nice home'], ['a & b', 'a, b']])('ambiguous/non-punctuation rewrite falls back: %s', (a,b) => {
    expect(run('P',a,b).target).toBeUndefined();
  });
  test('repeated lexical deletion is ambiguous and falls back', () => expect(run('AGR','go go','go').target).toBeUndefined());
  test('an apostrophe suffix is not misrepresented as an inter-word insertion', () =>
    expect(run('WC','John','John\'s').target).toBeUndefined());
  test('second occurrence uses absolute canonical span offsets', () => {
    const text='he was', spans=[...spansFor(text), ...spansFor(text,20)];
    expect(deriveVisualTarget(raw('AGR',text,'he were',20),spans).wordIds).toEqual(['w20_1']);
  });
  test('unknown, cross-evidence and malformed target IDs cannot escape validation', () => {
    expect(validateVisualTarget({version:1,wordIds:['other'],anchors:[]},['w'])).toBeUndefined();
    expect(validateVisualTarget({version:1,wordIds:[],anchors:[{wordId:'w',side:'middle'}]},['w'])).toBeUndefined();
  });
  test('new location metadata does not alter identity, evidence, statistics or deductions', () => {
    const text='He went home',spans=spansFor(text),c=normalizeCorrection(raw('P',text,'He went home.'),text,spans,defaultLegend(),'AI');
    expect(c.wordIds).toEqual(spans.map(s=>s.wordId));expect(c.evidenceWordIds).toEqual(c.wordIds);
    expect(c.quotedText).toBe(text);expect(c.visualTarget.anchors).toHaveLength(1);
    expect(statistics([c]).total).toBe(1);expect(c.appliedDeduction).toBe(c.defaultDeduction);
  });
  test('authoritative word confidence uses minimum evidence value, null stays unknown', () => {
    const spans=spansFor('Hello world');spans[0].word.confidence=null;spans[1].word.confidence=0.42;
    expect(mapOffsetsToWords({startChar:0,endChar:11},spans).ocrConfidence).toBe(0.42);
    spans[1].word.confidence=undefined;
    expect(mapOffsetsToWords({startChar:0,endChar:11},spans).ocrConfidence).toBeNull();
  });
  test('low confidence marks suspect at existing threshold without removing correction', () => {
    const text='hello',spans=spansFor(text);spans[0].word.confidence=0.42;
    const c=normalizeCorrection(raw('CAP',text,'Hello'),text,spans,defaultLegend(),'AI');
    expect(c).toMatchObject({ocrConfidence:0.42,ocrSuspect:true,quotedText:text});
    const { partitionCategoryCorrections } = require('../src/services/rubricLanguageScoring.service');
    expect(partitionCategoryCorrections([c],'MECHANICS').counted).toHaveLength(1);
    const legacy={...c};delete legacy.ocrSuspectForScoring;
    expect(partitionCategoryCorrections([legacy],'MECHANICS').ignored).toHaveLength(1);
    spans[0].word.confidence=0.7;
    expect(normalizeCorrection(raw('CAP',text,'Hello'),text,spans,defaultLegend(),'AI').ocrSuspect).toBe(false);
  });
  test('API preserves legacy metadata and rejects an invalid optional target only', () => {
    const spans=spansFor('one two');const page={fileId:'f',pageNumber:1,words:spans.map(s=>({id:s.wordId}))};
    const old={...raw('AGR','one two','one three'),fileId:'f',page:1,wordIds:spans.map(s=>s.wordId),correctionVersion:'canonical-7-code-authoritative'};
    const [legacy,bad]=normalizeCorrectionWordIds([old,{...old,visualTarget:{version:1,wordIds:['foreign'],anchors:[]}}],{pages:[page],wordSpans:spans},[]);
    expect(legacy).not.toHaveProperty('visualTarget');expect(bad.visualTarget).toBeUndefined();expect(bad.wordIds).toEqual(old.wordIds);
  });
});
