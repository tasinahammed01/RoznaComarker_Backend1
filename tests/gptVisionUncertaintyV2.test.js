'use strict';
const c=require('../src/services/gptVisionExact/contract');
const service=require('../src/services/gptVisionExact.service');
const sf=require('../src/utils/sourceFidelity');
const seg=(text,classification='STUDENT_ACTIVE_TEXT',confidence=.99)=>({text,classification,confidence});
const reading=()=>({version:c.VERSION,activeTranscript:'Society always expect\nself-nigleacting powerfull Say society ,',physicalLines:[
  {segments:[seg('Society always expect')]},{segments:[seg('self-nigleacting powerfull Say society ,')]}],uncertainties:[]});
const validate=v=>c.validate(JSON.stringify(v));
const append=(v,s,kind)=>{const lineIndex=v.physicalLines.length;v.physicalLines.push({segments:[s]});if(kind)v.uncertainties.push({lineIndex,segmentIndex:0,kind,reason:'PRIVATE unreadable detail'});return v;};
test.each([1,3])('readable answer with %i clearly deleted unreadable regions passes without guessing underlying letters',count=>{
  const v=reading();for(let i=0;i<count;i++)append(v,seg(null,'STUDENT_CROSSED_OUT'),'NON_ACTIVE_DELETED_UNCERTAIN');
  expect(validate(v).activeTranscript).toBe(v.activeTranscript);expect(c.diagnostics(v)).toMatchObject({deletedUnreadableCount:count,nonActiveUncertainCount:count,blockingUncertaintyCount:0,sourceAmbiguityReason:null});
});
test('null deleted text is sufficient evidence of unreadable excluded content even without an uncertainty entry',()=>{
  const v=append(reading(),seg(null,'STUDENT_CROSSED_OUT'));expect(validate(v).activeTranscript).toBe(reading().activeTranscript);
  expect(c.diagnostics(v)).toMatchObject({deletedUnreadableCount:1,nonActiveUncertainCount:1,blockingUncertaintyCount:0});
});
test('faint but legible active writing is literal; misspelling/grammar/case/punctuation do not trigger heuristics',()=>{
  const v=reading();v.physicalLines.forEach(l=>l.segments.forEach(s=>{s.confidence=.35;}));
  expect(validate(v).activeTranscript).toBe('Society always expect\nself-nigleacting powerfull Say society ,');
  expect(c.diagnostics(v)).toMatchObject({blockingUncertaintyCount:0,activeUncertainCount:0});
});
test('mixed-line unreadable deletion and active replacement preserve exact inter-word spaces and spelling',()=>{
  const text='  this shows that interupt Louise';const v={version:c.VERSION,activeTranscript:text,physicalLines:[{segments:[seg('  this shows that '),seg(null,'STUDENT_CROSSED_OUT'),seg('interupt Louise')]}],
    uncertainties:[{lineIndex:0,segmentIndex:1,kind:'NON_ACTIVE_DELETED_UNCERTAIN',reason:'PRIVATE deleted letters'}]};
  expect(validate(v).activeTranscript).toBe(text);expect(validate(v).activeTranscript).not.toContain('other');
});
test.each([null,'How do social and cultural expectations shape sense of self?'])('clearly identified prompt with uncertain excluded text %s does not affect active answer',text=>{
  const v=reading();v.physicalLines.unshift({segments:[seg(text,'PROMPT_OR_INSTRUCTION')]});v.uncertainties.push({lineIndex:0,segmentIndex:0,kind:'NON_ACTIVE_PROMPT_UNCERTAIN',reason:'PRIVATE prompt punctuation'});
  expect(validate(v).activeTranscript).toBe(reading().activeTranscript);expect(c.diagnostics(v)).toMatchObject({promptUnreadableCount:1,nonActiveUncertainCount:1,blockingUncertaintyCount:0});
});
test.each(['TEACHER_MARK','PAGE_ARTIFACT','HEADER_OR_TEMPLATE','WATERMARK_OR_CAMERA_BRANDING'])('%s unreadable content is excluded and non-blocking',role=>{
  const v=append(reading(),seg(null,role),'NON_ACTIVE_MARK_UNCERTAIN');expect(validate(v).activeTranscript).toBe(reading().activeTranscript);expect(c.diagnostics(v).blockingUncertaintyCount).toBe(0);
});
test.each([
  ['ACTIVE_TEXT_UNCERTAIN','ACTIVE_TEXT_UNREADABLE'],['ACTIVE_ROLE_AMBIGUOUS','ACTIVE_ROLE_AMBIGUOUS'],
  ['ACTIVE_REPLACEMENT_AMBIGUOUS','ACTIVE_REPLACEMENT_AMBIGUOUS'],['ACTIVE_PUNCTUATION','ACTIVE_PUNCTUATION_UNREADABLE']
])('%s blocks active source without guessing or restoring deleted text', (kind,reason)=>{
  const v=append(reading(),seg(null,'UNCERTAIN'),kind);
  try{validate(v);throw Error('accepted ambiguous source');}catch(error){expect(error.code).toBe('OCR_GPT_SOURCE_UNCERTAIN');expect(error.sourceDiagnostic).toMatchObject({activeUncertainCount:1,blockingUncertaintyCount:1,sourceAmbiguityReason:reason});}
});
test('explicit active-role/replacement ambiguity cannot be overridden by a non-active segment label',()=>{
  for(const kind of ['ACTIVE_ROLE_AMBIGUOUS','ACTIVE_REPLACEMENT_AMBIGUOUS'])expect(()=>validate(append(reading(),seg(null,'STUDENT_CROSSED_OUT'),kind))).toThrow('OCR_GPT_SOURCE_UNCERTAIN');
});
test('UNCERTAIN role remains blocking without an uncertainty list; non-active kinds cannot relabel active roles',()=>{
  expect(()=>validate(append(reading(),seg(null,'UNCERTAIN')))).toThrow('OCR_GPT_SOURCE_UNCERTAIN');
  for(const role of ['STUDENT_ACTIVE_TEXT','UNCERTAIN'])expect(()=>validate(append(reading(),seg('visible',role),'NON_ACTIVE_DELETED_UNCERTAIN'))).toThrow('SCHEMA');
});
test('strict uncertainty-kind schema rejects unknown, missing, extra boolean and wrong non-active role',()=>{
  const good=append(reading(),seg(null,'STUDENT_CROSSED_OUT'),'NON_ACTIVE_DELETED_UNCERTAIN');
  for(const mutate of [u=>{delete u.kind;},u=>{u.kind='UNKNOWN';},u=>{u.affectsActiveTranscript=false;},u=>{u.kind='NON_ACTIVE_PROMPT_UNCERTAIN';}]){
    const v=structuredClone(good);mutate(v.uncertainties[0]);expect(()=>validate(v)).toThrow('SCHEMA');
  }
});
test('byte-for-byte source verification remains mandatory even with only non-active uncertainty',()=>{
  const v=append(reading(),seg(null,'STUDENT_CROSSED_OUT'),'NON_ACTIVE_DELETED_UNCERTAIN');v.activeTranscript=v.activeTranscript.replace('powerfull','powerful');
  try{validate(v);throw Error('accepted repaired source');}catch(error){expect(error.code).toBe('OCR_GPT_SOURCE_TRANSCRIPT_MISMATCH');expect(error.sourceDiagnostic.sourceAmbiguityReason).toBe('TRANSCRIPT_RECONSTRUCTION_MISMATCH');}
});
test('safe accepted diagnostics record non-active uncertainty without source text, while one reader call is retained',async()=>{
  const v=append(reading(),seg(null,'STUDENT_CROSSED_OUT'),'NON_ACTIVE_DELETED_UNCERTAIN');
  const read=jest.fn(async()=>({returnedModel:'openai/gpt-6-astra',content:JSON.stringify(v)})),reservation={acquire:jest.fn(async()=>({_id:'r',cached:false})),complete:jest.fn(async()=>{})};
  const spy=jest.spyOn(require('../src/utils/logger'),'info').mockImplementation(()=>{});
  try{const result=await service.readPage({bytes:Buffer.from([255,216,255]),mimeType:'image/jpeg',identity:{pageNumber:1,fileId:'f',sourceSha256:c.sha('original')},read,reservation,
    env:{NODE_ENV:'test',OCR_GPT_VISION_MODEL:'openai/gpt-6-astra',OPENROUTER_API_KEY:'mock-only'}});
    expect(result.fullText).toBe(v.activeTranscript);expect(result.source.sourceFidelityVersion).toBe('gpt-vision-exact-v2');expect(read).toHaveBeenCalledTimes(1);
    const log=spy.mock.calls.map(([v])=>v).find(v=>v.event==='gpt_vision_source_reader');expect(log).toMatchObject({nonActiveUncertainCount:1,deletedUnreadableCount:1,blockingUncertaintyCount:0,validationStage:'ACCEPTED'});
    expect(JSON.stringify(log)).not.toMatch(/PRIVATE|Society|self-nigleacting|mock-only|base64/);expect(reservation.complete.mock.calls[0][1].payload).toMatchObject({nonActiveUncertainCount:1,blockingUncertaintyCount:0});
  }finally{spy.mockRestore();}
});
test.each(['gpt-vision-exact-v1','gpt-vision-exact-v2'])('historical/current %s canonical authority and complete null-box tokens remain eligible',version=>{
  const text='Society powerfull ,',words=[...text.matchAll(/\S+/gu)].map((m,i)=>({id:`word_f_1_gpt_${i+1}`,text:m[0],bbox:null,sourceStart:m.index,sourceEnd:m.index+m[0].length}));
  const doc={sourceFidelityMode:'gpt_vision_exact',files:['f'],ocrPages:[{fileId:'f',fileOrder:0,pageNumber:1,pageIndex:0,words,sourceTextExact:text,sourceTextSha256:c.sha(text),
    sourceFidelityMode:'gpt_vision_exact',sourceFidelityVersion:version,sourceFidelityStatus:'GPT_SOURCE_ACCEPTED',sourceInputSha256:c.sha('pixels')}]};Object.assign(doc,sf.aggregate(doc));
  expect(sf.eligible(doc)).toBe(true);expect(doc.sourceFidelityVersion).toBe(version);expect(sf.canonical(doc).wordSpans).toHaveLength(3);expect(sf.canonical(doc).text).toBe(text);
});
test('calibrated prompt performs its self-check within the same request and prioritizes visible writing',()=>{
  for(const phrase of ['Low contrast is NOT by itself uncertainty','Do NOT classify it as UNCERTAIN merely because','self-nigleacting','interupt','PASS 1','PASS 2','Do not output internal reasoning','ACTIVE_PUNCTUATION'])expect(c.PROMPT).toContain(phrase);
  expect(c.schema.properties.version.enum).toEqual(['gpt-vision-exact-v2']);
});
