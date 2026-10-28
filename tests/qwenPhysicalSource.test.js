'use strict';
const c=require('../src/services/gptVisionExact/contract');
const {alignGeometry}=require('../src/services/gptVisionExact/alignment');
const seg=(text,classification='STUDENT_ACTIVE_TEXT')=>({text,classification,confidence:1});
const wire=()=>({version:c.QWEN_WIRE_VERSION,physicalLines:[
  {segments:[seg('Question?','PROMPT_OR_INSTRUCTION'),seg(null,'HEADER_OR_TEMPLATE')]},
  {segments:[seg('Society always expect  '),seg(null,'STUDENT_CROSSED_OUT'),seg('powerfull wrong wrong ,')]},
  {segments:[seg('Say naïve 😀 unfinished'),seg('✓','TEACHER_MARK'),seg('camera','WATERMARK_OR_CAMERA_BRANDING'),seg(null,'PAGE_ARTIFACT')]}
],uncertainties:[{lineIndex:1,segmentIndex:1,kind:'NON_ACTIVE_DELETED_UNCERTAIN',reason:'Deleted strokes unreadable.'}]});
const parse=v=>c.validateWire(JSON.stringify(v));
test('Qwen wire omits duplicate transcription; canonical output preserves exact segments, LF, UTF-16 and hash',()=>{
  const profile=c.wireContract(c.QWEN_MODEL),v=wire(),d=jest.fn();
  expect(profile.schema.required).toEqual(['version','physicalLines','uncertainties']);
  expect(profile.schema.properties).not.toHaveProperty('activeTranscript');
  const result=c.validateWire(JSON.stringify(v),{onDiagnostic:d});
  expect(result.activeTranscript).toBe('Society always expect  powerfull wrong wrong ,\nSay naïve 😀 unfinished');
  expect(result.version).toBe(c.VERSION);expect(result.physicalLines).toEqual(v.physicalLines);
  expect(c.validateCanonical(JSON.stringify(result))).toEqual(result);
  expect(d).toHaveBeenCalledWith(expect.objectContaining({transcriptComparison:'SERVER_DERIVED',transcriptReconciled:false}));
  const aligned=alignGeometry(result.activeTranscript,null,{fileId:'synthetic-file',pageNumber:2});
  for(const w of aligned.words){expect(result.activeTranscript.slice(w.sourceStart,w.sourceEnd)).toBe(w.text);expect(w.page).toBe(2);expect(w.fileId).toBe('synthetic-file');}
  expect(new Set(aligned.words.map(w=>w.id)).size).toBe(aligned.words.length);
  expect(aligned.words.find(w=>w.text==='😀').sourceEnd-aligned.words.find(w=>w.text==='😀').sourceStart).toBe(2);
  expect(aligned.textSha256).toBe(require('crypto').createHash('sha256').update(result.activeTranscript).digest('hex'));
});
test.each([
  ['duplicate transcript',v=>{v.activeTranscript='invented';}],
  ['wrong version',v=>{v.version=c.VERSION;}],
  ['active null',v=>{v.physicalLines[1].segments[0].text=null;}],
  ['active empty',v=>{v.physicalLines[1].segments[0].text='';}],
  ['embedded LF',v=>{v.physicalLines[1].segments[0].text='a\nb';}],
  ['embedded CR',v=>{v.physicalLines[1].segments[0].text='a\rb';}],
  ['unknown role',v=>{v.physicalLines[1].segments[0].classification='STUDENT_FIXED_TEXT';}],
  ['invalid confidence',v=>{v.physicalLines[1].segments[0].confidence=2;}],
  ['missing segments',v=>{delete v.physicalLines[1].segments;}],
  ['missing referenced line',v=>{v.uncertainties[0].lineIndex=8;}],
  ['missing referenced segment',v=>{v.uncertainties[0].segmentIndex=99;}],
  ['excluded-kind attached to active text',v=>{v.uncertainties[0].segmentIndex=0;}],
  ['omitted line leaves dangling uncertainty',v=>{v.physicalLines.splice(1,2);}]
])('rejects malformed or detectably inconsistent evidence: %s',(_,mutate)=>{
  const v=wire();mutate(v);expect(()=>parse(v)).toThrow('OCR_GPT_SOURCE_SCHEMA');
});
test.each(['ACTIVE_TEXT_UNCERTAIN','ACTIVE_ROLE_AMBIGUOUS','ACTIVE_REPLACEMENT_AMBIGUOUS','ACTIVE_PUNCTUATION'])('blocks %s even when model labels the region excluded',kind=>{
  const v=wire();v.uncertainties=[{lineIndex:0,segmentIndex:0,kind,reason:'Ambiguous role/strokes.'}];
  expect(()=>parse(v)).toThrow('OCR_GPT_SOURCE_UNCERTAIN');
});
test('unlisted uncertain segment blocks; no active writing blocks; no invented intersegment spaces',()=>{
  const v=wire();v.physicalLines[1].segments.push(seg(null,'UNCERTAIN'));expect(()=>parse(v)).toThrow('UNCERTAIN');
  expect(()=>parse({version:c.QWEN_WIRE_VERSION,physicalLines:[{segments:[seg(null,'STUDENT_CROSSED_OUT')]}],uncertainties:[]})).toThrow('EMPTY');
  expect(parse({version:c.QWEN_WIRE_VERSION,physicalLines:[{segments:[seg('wrong'),seg('wrong')]}],uncertainties:[]}).activeTranscript).toBe('wrongwrong');
});
test('canonical cache cannot hide substantive or separator mutation; legacy accepted canonical evidence remains valid',()=>{
  const v=parse(wire());expect(c.validateCanonical(JSON.stringify(v))).toEqual(v);
  for(const text of [v.activeTranscript.replace('\n',' '),'invented words'])
    expect(()=>c.validateCanonical(JSON.stringify({...v,activeTranscript:text}))).toThrow('TRANSCRIPT_MISMATCH');
  expect(c.wireContract(c.DEEPSEEK_MODEL).schema).toBe(c.schema);
  expect(c.wireContract('openai/gpt-6-astra').prompt).toBe(c.PROMPT);
});
test('unobservable omissions are not detectable: a self-consistent subset is no proof of full visual coverage',()=>{
  const v=wire();v.physicalLines.pop();const result=parse(v);
  expect(result.activeTranscript).not.toContain('unfinished');
  // No independent region inventory exists. This limitation must not be called
  // an omission detector or repaired by inventing the absent text.
  expect(result.activeTranscript).toBe('Society always expect  powerfull wrong wrong ,');
});

test.each(['STUDENT_ACTIVE_TEXT','STUDENT_CROSSED_OUT','PROMPT_OR_INSTRUCTION'])('active uncertainty referencing %s stays blocking with precise content-free metadata',classification=>{
  const v=wire();v.physicalLines[1].segments[0]={...seg('PRIVATE literal text',classification),confidence:.99};
  v.uncertainties=[{lineIndex:1,segmentIndex:0,kind:'ACTIVE_TEXT_UNCERTAIN',reason:'PRIVATE visual ambiguity'}];
  try{parse(v);throw Error('accepted');}catch(error){
    expect(error.code).toBe('OCR_GPT_SOURCE_UNCERTAIN');
    expect(error.sourceDiagnostic).toMatchObject({uncertaintyCount:1,uncertainSegmentCount:0,activeUncertainCount:1,blockingUncertaintyCount:1,
      blockingUncertaintyDetails:[{uncertaintyKind:'ACTIVE_TEXT_UNCERTAIN',physicalLineIndex:1,segmentIndex:0,
        referencedSegmentClassification:classification,referencedTextPresent:true,referencedTextLength:20,confidenceBand:'HIGH'}],blockingUncertaintyDetailsOmitted:0});
    const safe=require('../src/services/gptVisionExact.service').safeSourceDiagnostic(error.sourceDiagnostic);
    expect(safe.blockingUncertaintyDetails).toEqual(error.sourceDiagnostic.blockingUncertaintyDetails);
    expect(JSON.stringify(safe)).not.toMatch(/PRIVATE|literal text|visual ambiguity/);
  }
});
test('precise unreadable region retains surrounding literal text but blocks and diagnoses unlisted uncertainty',()=>{
  const v={version:c.QWEN_WIRE_VERSION,physicalLines:[{segments:[seg('powerfull '),{...seg(null,'UNCERTAIN'),confidence:.2},seg(' Say')]}],uncertainties:[]};
  try{parse(v);throw Error('accepted');}catch(error){
    expect(error.code).toBe('OCR_GPT_SOURCE_UNCERTAIN');expect(error.sourceDiagnostic).toMatchObject({activeCharacterCount:14,
      blockingUncertaintyDetails:[{uncertaintyKind:'UNCERTAIN_SEGMENT_UNLISTED',physicalLineIndex:0,segmentIndex:1,
        referencedSegmentClassification:'UNCERTAIN',referencedTextPresent:false,referencedTextLength:0,confidenceBand:'LOW'}]});
  }
  expect(v.physicalLines[0].segments[0].text).toBe('powerfull ');expect(v.physicalLines[0].segments[2].text).toBe(' Say');
});
test('blocking details are bounded, report omitted count, redact unknown fields and reject unsafe values',()=>{
  const v={version:c.QWEN_WIRE_VERSION,physicalLines:[{segments:Array.from({length:25},()=>seg(null,'UNCERTAIN'))}],uncertainties:[]};
  let diagnostic;try{parse(v);}catch(error){diagnostic=error.sourceDiagnostic;}
  expect(diagnostic.blockingUncertaintyDetails).toHaveLength(20);expect(diagnostic.blockingUncertaintyDetailsOmitted).toBe(5);
  const detail=diagnostic.blockingUncertaintyDetails[0],safe=require('../src/services/gptVisionExact.service').safeSourceDiagnostic;
  expect(JSON.stringify(safe({blockingUncertaintyDetails:[{...detail,reason:'SECRET',text:'SECRET'}]}))).not.toContain('SECRET');
  for(const bad of [{uncertaintyKind:'SECRET'},{physicalLineIndex:-1},{segmentIndex:100},{referencedSegmentClassification:'SECRET'},
    {referencedTextLength:2001},{referencedTextPresent:'SECRET'},{confidenceBand:'SECRET'}])
    expect(safe({blockingUncertaintyDetails:[{...detail,...bad}]}).blockingUncertaintyDetails).toEqual([]);
});
test('Qwen-only prompt clarification keeps prior profile reusable and never permits undefined or unknown prompt identity',()=>{
  const profile=c.wireContract(c.QWEN_MODEL);expect(profile.prompt).toContain('Never emit an empty STUDENT_ACTIVE_TEXT string');
  expect(profile.prompt).toContain('retain the surrounding readable segments and physical line');
  expect(profile.prompt.startsWith(c.PREVIOUS_QWEN_PROMPT)).toBe(true);
  expect(profile.promptVersion).toBe(c.QWEN_PROMPT_VERSION);
  expect(c.sameSourcePrompt({model:c.QWEN_MODEL,wireVersion:c.QWEN_WIRE_VERSION},{model:c.QWEN_MODEL})).toBe(false);
  expect(c.sameSourcePrompt({model:c.QWEN_MODEL,promptSha256:'unknown',wireVersion:c.QWEN_WIRE_VERSION},
    {model:c.QWEN_MODEL,promptSha256:'current',previousPromptSha256:'approved'})).toBe(false);
  expect(c.wireContract(c.DEEPSEEK_MODEL).prompt).toBe(c.PROMPT);
});
