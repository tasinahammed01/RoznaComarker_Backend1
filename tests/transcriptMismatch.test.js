'use strict';
const c = require('../src/services/gptVisionExact/contract');
const service = require('../src/services/gptVisionExact.service');
const fixture = require('./fixtures/transcriptMismatch.json');
const segment = (text, classification = 'STUDENT_ACTIVE_TEXT') => ({text, classification, confidence: 1});
const reading = lines => ({version: c.VERSION, activeTranscript: lines.join('\n'),
  physicalLines: lines.map(text => ({segments: [segment(text)]})), uncertainties: []});
const validate = value => c.validate(JSON.stringify(value));
function rejection(value) {
  try {validate(value);} catch (error) {return error;}
  throw Error('Expected rejection');
}

test('observed counts alone do not determine the mismatch: synthetic 19 lines and two unreadable deletions pass', () => {
  expect(validate(fixture).activeTranscript).toBe(fixture.activeTranscript);
  expect(c.diagnostics(fixture)).toMatchObject({activeCharacterCount: 726, activeLineCount: 19,
    nonActiveUncertainCount: 2, deletedUnreadableCount: 2, blockingUncertaintyCount: 0});
});

test('physical-lines-only projection loses a real consistency safeguard despite identical uncertainty and confidence',()=>{
  const consistent=reading(['They are here.']),conflicting=structuredClone(consistent);
  conflicting.activeTranscript='They are not here.';
  expect(validate(consistent).activeTranscript).toBe('They are here.');
  expect(rejection(conflicting).code).toBe('OCR_GPT_SOURCE_TRANSCRIPT_MISMATCH');
  expect(conflicting.physicalLines).toEqual(consistent.physicalLines);
  expect(conflicting.uncertainties).toEqual(consistent.uncertainties);
  expect(c.diagnostics(conflicting)).toEqual(c.diagnostics(consistent));
  const withoutTranscript=structuredClone(consistent);delete withoutTranscript.activeTranscript;
  expect(rejection(withoutTranscript).code).toBe('OCR_GPT_SOURCE_SCHEMA');
});
test.each([
  ['EXTRA_FINAL_NEWLINE', value => {value.activeTranscript += '\n';}],
  ['PUNCTUATION', value => {value.activeTranscript = value.activeTranscript.replace('powerfull', 'powerfull.');}],
  ['CASE', value => {value.activeTranscript = value.activeTranscript.replace('Line', 'line');}],
  ['CONTENT_OR_ORDER', value => {value.activeTranscript = value.activeTranscript.replace('powerfull', 'powerful');}]
])('same observed structure still rejects %s without logging letters', (type, mutate) => {
  const value = structuredClone(fixture); mutate(value);
  const error = rejection(value);
  expect(error.code).toBe('OCR_GPT_SOURCE_TRANSCRIPT_MISMATCH');
  expect(error.sourceDiagnostic).toMatchObject({transcriptDifferenceType: type, activeLineCount: 19, deletedUnreadableCount: 2});
  const safe = service.safeSourceDiagnostic(error.sourceDiagnostic);
  expect(safe.transcriptDifferenceType).toBe(type);
  expect(JSON.stringify(safe)).not.toMatch(/powerfull|Line 01|wrong|xxxx|base64/);
});
test('CRLF synthetic structural diff is exact and content-free', () => {
  const value = reading(['Alpha.', 'Beta.']); value.activeTranscript = 'Alpha.\r\nBeta.';
  expect(validate(value).activeTranscript).toBe('Alpha.\nBeta.');
  expect(require('../src/services/gptVisionExact/transcriptDiagnostic').compare(value,'Alpha.\nBeta.')).toMatchObject({transcriptModelLength: 13, transcriptDerivedLength: 12,
    transcriptFirstDifference: 6, transcriptModelLine: 1, transcriptDerivedLine: 1,
    transcriptPhysicalLineIndex: -1, transcriptSegmentIndex: -1,
    transcriptModelCharacterKind: 'CR', transcriptDerivedCharacterKind: 'LF', transcriptDifferenceType: 'CRLF_VS_LF',transcriptComparison:'SEPARATOR_ONLY'});
});

const forms=['\n','\r\n',' '];
test.each(forms.flatMap(a=>forms.flatMap(b=>forms.map(d=>[[a,b,d]]))))('complete active lines reconcile only permitted boundaries %j',separators=>{
  const lines=['  Alpha wrong wrong,','naïve 😀 says powerfull.','Case MUST stay!',' unfinished  '],value=reading(lines),observed=jest.fn();
  value.activeTranscript=lines.reduce((text,line,i)=>text+(i?separators[i-1]:'')+line,'');
  // Reconciliation may not mutate segment text, classifications, prompt or schema.
  const before=JSON.stringify(value.physicalLines),schema=JSON.stringify(c.schema),prompt=c.PROMPT;
  const result=c.validate(JSON.stringify(value),{onDiagnostic:observed});
  expect(result.activeTranscript).toBe(lines.join('\n'));expect(JSON.stringify(result.physicalLines)).toBe(before);
  expect(Object.keys(result).sort()).toEqual(Object.keys(value).sort());
  expect(JSON.stringify(c.schema)).toBe(schema);expect(c.PROMPT).toBe(prompt);
  const count=s=>separators.filter(v=>v===s).length,changed=count(' ')+count('\r\n');
  expect(observed).toHaveBeenCalledWith({transcriptComparison:changed?'SEPARATOR_ONLY':'EXACT',transcriptReconciled:changed>0,
    transcriptReconciledBoundaries:changed,transcriptSeparatorLFCount:count('\n'),transcriptSeparatorCRLFCount:count('\r\n'),transcriptSeparatorSpaceCount:count(' ')});
});

test.each([
  ['missing word','Alpha wrong\nBeta powerfull!\nLast.'],
  ['extra word','Alpha wrong wrong extra\nBeta powerfull!\nLast.'],
  ['spelling','Alpha wrong wrong\nBeta powerful!\nLast.'],
  ['case','alpha wrong wrong\nBeta powerfull!\nLast.'],
  ['punctuation','Alpha wrong wrong\nBeta powerfull.\nLast.'],
  ['internal double space','Alpha  wrong wrong\nBeta powerfull!\nLast.'],
  ['internal tab','Alpha\twrong wrong\nBeta powerfull!\nLast.'],
  ['collapsed words','Alphawrongwrong\nBetapowerfull!\nLast.'],
  ['double-space delimiter','Alpha wrong wrong  Beta powerfull!\nLast.'],
  ['tab delimiter','Alpha wrong wrong\tBeta powerfull!\nLast.'],
  ['nonbreaking delimiter','Alpha wrong wrong\u00a0Beta powerfull!\nLast.'],
  ['bare CR delimiter','Alpha wrong wrong\rBeta powerfull!\nLast.'],
  ['missing delimiter','Alpha wrong wrongBeta powerfull!\nLast.'],
  ['final LF','Alpha wrong wrong\nBeta powerfull!\nLast.\n'],
  ['final space','Alpha wrong wrong\nBeta powerfull!\nLast. '],
  ['reordered lines','Beta powerfull!\nAlpha wrong wrong\nLast.'],
  ['partial omission','Alpha wrong wrong\nBeta powerfull!'],
  ['separator then later changed punctuation','Alpha wrong wrong Beta powerfull?\nLast.'],
  ['separator then later changed word','Alpha wrong wrong Beta powerful!\nLast.']
])('%s remains a complete-source mismatch',(label,supplied)=>{
  const value=reading(['Alpha wrong wrong','Beta powerfull!','Last.']);value.activeTranscript=supplied;
  const error=rejection(value);expect(error.code).toBe('OCR_GPT_SOURCE_TRANSCRIPT_MISMATCH');
  expect(error.sourceDiagnostic).toMatchObject({transcriptComparison:'MISMATCH',transcriptReconciled:false,transcriptReconciledBoundaries:0});
  const ui=require('../src/services/gptVisionExact/preflight').ui(error);expect(ui).toMatchObject({canSubmit:false,sourceReadStatus:'FAILED_SERVICE'});
  if(label.startsWith('separator then'))expect(error.sourceDiagnostic).toMatchObject({transcriptModelCharacterKind:'SPACE',transcriptDerivedCharacterKind:'LF'});
});

test('reconciled boundaries never add separators inside mixed active/excluded segments',()=>{
  const value=reading(['keep bad spellng','end.']);value.physicalLines[0].segments=[segment('keep '),segment('deleted','STUDENT_CROSSED_OUT'),segment(null,'STUDENT_CROSSED_OUT'),segment('bad'),segment(' spellng'),segment('mark','TEACHER_MARK')];
  value.physicalLines.unshift({segments:[segment('Question?','PROMPT_OR_INSTRUCTION')]});
  value.activeTranscript='keep bad spellng end.';expect(validate(value).activeTranscript).toBe('keep bad spellng\nend.');
  value.activeTranscript='keep bad  spellng end.';expect(rejection(value).code).toBe('OCR_GPT_SOURCE_TRANSCRIPT_MISMATCH');
  value.activeTranscript='Question? keep bad spellng end.';expect(rejection(value).code).toBe('OCR_GPT_SOURCE_TRANSCRIPT_MISMATCH');
});

test.each(['ACTIVE_TEXT_UNCERTAIN','ACTIVE_ROLE_AMBIGUOUS','ACTIVE_REPLACEMENT_AMBIGUOUS','ACTIVE_PUNCTUATION'])('separator reconciliation cannot bypass %s',kind=>{
  const value=reading(['keep','unfinished']);value.activeTranscript='keep unfinished';
  value.uncertainties=[{lineIndex:0,segmentIndex:0,kind,reason:'synthetic ambiguity'}];
  expect(rejection(value).code).toBe('OCR_GPT_SOURCE_UNCERTAIN');
});

test('300 whitespace-bearing repeated active lines are matched deterministically with no search or trimming',()=>{
  const value=reading(Array(300).fill(' same  same '));value.activeTranscript=value.physicalLines.map(l=>l.segments[0].text).join(' ');
  expect(validate(value).activeTranscript).toBe(Array(300).fill(' same  same ').join('\n'));
  value.activeTranscript=value.activeTranscript.slice(0,-1);expect(rejection(value).code).toBe('OCR_GPT_SOURCE_TRANSCRIPT_MISMATCH');
});
test.each([
  ['Hello.'], ['Hello.', 'Goodbye.'], ['  Hello.  ', ' repeated  words '], ['“naïve” — don’t; café.'], ['First paragraph.', 'Second paragraph.']
].map(lines => [lines]))('exact line reconstruction preserves source whitespace, punctuation and Unicode: %j', lines => {
  const value = reading(lines); expect(validate(value).activeTranscript).toBe(lines.join('\n'));
});
test('excluded-only blank/deleted lines are omitted, while a meaningful whitespace-only active line is retained', () => {
  const value = reading(['First.', '  ', 'Last.']);
  value.physicalLines.splice(1, 0, {segments: [segment(null, 'PAGE_ARTIFACT')]}, {segments: [segment(null, 'STUDENT_CROSSED_OUT')]});
  expect(validate(value).activeTranscript).toBe('First.\n  \nLast.');
  value.activeTranscript = 'First.\n\n  \nLast.';
  expect(rejection(value).code).toBe('OCR_GPT_SOURCE_TRANSCRIPT_MISMATCH');
});
test.each(['Hello', 'hello.', 'Helo.', 'Other.', 'Hello. ', ' Hello.', 'Hello.\n'])('punctuation/case/spelling/words/source spaces/final newline differences remain rejected: %s', supplied => {
  const value = reading(['Hello.']); value.activeTranscript = supplied;
  expect(rejection(value).code).toBe('OCR_GPT_SOURCE_TRANSCRIPT_MISMATCH');
});
test('segment order and inserted separator differences fail; no implicit space is inserted', () => {
  const value = reading(['left right']); value.physicalLines[0].segments = [segment('left '), segment('right')];
  expect(validate(value).activeTranscript).toBe('left right');
  value.activeTranscript = 'left  right'; expect(rejection(value).sourceDiagnostic.transcriptDifferenceType).toBe('SEGMENT_SEPARATOR');
  value.activeTranscript = 'rightleft '; expect(rejection(value).code).toBe('OCR_GPT_SOURCE_TRANSCRIPT_MISMATCH');
});
test.each(['STUDENT_CROSSED_OUT', 'PROMPT_OR_INSTRUCTION', 'TEACHER_MARK'])('readable %s cannot leak through duplicate transcript', role => {
  const value = reading(['keep']); value.physicalLines[0].segments.unshift(segment('excluded ', role));
  expect(validate(value).activeTranscript).toBe('keep'); value.activeTranscript = 'excluded keep';
  expect(rejection(value).sourceDiagnostic.transcriptDifferenceType).toBe('NON_ACTIVE_TEXT_INCLUDED');
});
test('null unreadable deletions cannot introduce guessed words or blank lines in active transcript', () => {
  const value = structuredClone(fixture); value.activeTranscript = value.activeTranscript.replace('\n', '\nguessed\n');
  expect(rejection(value).code).toBe('OCR_GPT_SOURCE_TRANSCRIPT_MISMATCH');
  const good = structuredClone(fixture); good.physicalLines[0].segments.push(segment(null, 'UNCERTAIN'));
  expect(rejection(good).code).toBe('OCR_GPT_SOURCE_UNCERTAIN');
});
test('new diagnostic fields are allowlisted and cannot carry provider/student content', () => {
  expect(service.safeSourceDiagnostic({transcriptDifferenceType: 'PRIVATE essay', transcriptModelLength: 'secret',
    transcriptModelCharacterKind: 'SECRET', transcriptDerivedLength: Infinity, raw: 'PRIVATE',transcriptComparison:'SECRET',transcriptReconciled:'PRIVATE',
    transcriptReconciledBoundaries:300,transcriptSeparatorSpaceCount:-1,transcriptSeparatorLFCount:'essay',transcriptSeparatorCRLFCount:Infinity})).toEqual({});
});
test.each(['deepseek/deepseek-v4.1-flash-1017', 'openai/gpt-6-astra'])('reader %s persists mismatch metadata and never accepted evidence, geometry or source content', async model => {
  const value = structuredClone(fixture); value.activeTranscript += '\n';
  const read = jest.fn(async () => ({returnedModel: model, content: JSON.stringify(value)}));
  const reservation = {acquire: jest.fn(async () => ({_id: 'source', cached: false})), complete: jest.fn(async () => {})};
  const google = jest.fn(); const spy = jest.spyOn(require('../src/utils/logger'), 'info').mockImplementation(() => {});
  try {
    await expect(service.readPage({bytes: Buffer.from([255, 216, 255]), mimeType: 'image/jpeg', read, google, reservation,
      identity: {pageNumber: 1, fileId: 'crop', sourceSha256: c.sha('crop')},
      env: {NODE_ENV: 'test', OCR_GPT_VISION_MODEL: model, OPENROUTER_API_KEY: 'mock-only'}})).rejects.toMatchObject({code: 'OCR_GPT_SOURCE_TRANSCRIPT_MISMATCH'});
    expect(read).toHaveBeenCalledTimes(1); expect(google).not.toHaveBeenCalled();
    expect(reservation.complete.mock.calls[0][1]).toMatchObject({status: 'GPT_SOURCE_FAILED', payload: {transcriptDifferenceType: 'EXTRA_FINAL_NEWLINE'}});
    const output = JSON.stringify([...spy.mock.calls, ...reservation.complete.mock.calls]);
    expect(output).not.toMatch(/powerfull|wrong wrong|mock-only|base64/);
  } finally {spy.mockRestore();}
});
