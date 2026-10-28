'use strict';
const c=require('../src/services/gptVisionExact/contract'),service=require('../src/services/gptVisionExact.service');
const {alignGeometry}=require('../src/services/gptVisionExact/alignment');
const sf=require('../src/utils/sourceFidelity'),gateway=require('../src/services/aiGateway.service');
const env={NODE_ENV:'test',OCR_SOURCE_MODE:'gpt_vision_exact',OPENROUTER_API_KEY:'mock-only',OCR_GPT_VISION_MODEL:'openai/gpt-5.6-sol'};
const seg=(text,classification='STUDENT_ACTIVE_TEXT')=>({text,classification,confidence:.99});
const fixture=()=>({version:c.VERSION,activeTranscript:'Social and cultural expectations\nthis shows that Louise was affected\nSociety always expect society Say powerfull , wrong wrong',physicalLines:[
  {segments:[seg('How do social and cultural expectations shape Louise Mallard choices feelings and sense of self?','PROMPT_OR_INSTRUCTION')]},
  {segments:[seg('Social and cultural expectations')]},
  {segments:[seg('this shows that '),seg('other','STUDENT_CROSSED_OUT'),seg(null,'STUDENT_CROSSED_OUT'),seg('Louise'),seg(' was affected')]},
  {segments:[seg('Society always expect society Say powerfull , wrong wrong')]},
  {segments:[seg('MAXI','WATERMARK_OR_CAMERA_BRANDING'),seg('icon','PAGE_ARTIFACT')]}],uncertainties:[]});
const simple=text=>({version:c.VERSION,activeTranscript:text,physicalLines:text.split('\n').map(t=>({segments:[seg(t)]})),uncertainties:[]});
const geometry=text=>({words:text.split('\n').flatMap((line,row)=>line.split(' ').map((text,i)=>({text,id:`g_${row}_${i}`,page:1,bbox:{x:5+i*10,y:10+row*12,w:7,h:6}})))});
const identity={submissionId:'s',runId:'run',fileId:'f',pageNumber:1,sourceSha256:c.sha('original')};
const options=()=>({bytes:Buffer.from([255,216,255]),mimeType:'image/jpeg',identity,env,
  reservation:{acquire:jest.fn(async()=>({_id:'r',cached:false})),complete:jest.fn(async()=>{})},
  read:jest.fn(async()=>({content:JSON.stringify(fixture()),returnedModel:env.OCR_GPT_VISION_MODEL})),google:jest.fn(async()=>geometry('Google never becomes source'))});
test('mixed physical lines exclude prompt/deleted/artifact content and retain replacement, literal errors, repetitions and newlines',()=>{
  const v=c.validate(JSON.stringify(fixture()));expect(v.activeTranscript).toBe(fixture().activeTranscript);
  for(const literal of ['Society','society','Say','powerfull','always expect','wrong wrong',','])expect(v.activeTranscript).toContain(literal);
  expect(v.activeTranscript.startsWith('Social and cultural expectations')).toBe(true);
  expect(v.activeTranscript).not.toMatch(/How do|other|MAXI/);expect(v.physicalLines[2].segments[2].text).toBeNull();
});
test.each([
  v=>{v.extra='not allowed';},v=>{v.physicalLines[0].segments[0].classification='UNKNOWN';},v=>{v.physicalLines[0].segments[0].confidence=1.1;},
  v=>{v.physicalLines[0].segments[0].text='bad\nline';},v=>{v.physicalLines[0].segments[0].confidence='1';},
  v=>{v.physicalLines=Array(301).fill(v.physicalLines[0]);},v=>{v.physicalLines[0].segments[0].text='x'.repeat(2001);},
  v=>{v.uncertainties=[{lineIndex:-1,segmentIndex:0,kind:'ACTIVE_TEXT_UNCERTAIN',reason:'x'}];},v=>{v.activeTranscript='Google repair';}
])('strict malformed/schema/transcript output rejected (%#)',mutate=>{const v=fixture();mutate(v);expect(()=>c.validate(JSON.stringify(v))).toThrow();});
test('malformed JSON and unresolved active segments reject, including missing uncertainty declaration',()=>{
  expect(()=>c.validate('```json {} ```')).toThrow('SCHEMA');const v=simple('known');v.physicalLines[0].segments.push(seg(null,'UNCERTAIN'));
  expect(()=>c.validate(JSON.stringify(v))).toThrow('OCR_GPT_SOURCE_UNCERTAIN');
  const u=simple('known');u.uncertainties=[{lineIndex:0,segmentIndex:0,kind:'ACTIVE_TEXT_UNCERTAIN',reason:'ambiguous active character'}];expect(()=>c.validate(JSON.stringify(u))).toThrow('UNCERTAIN');
});
test('one source request; no other reader; Google conflict never edits source, private evidence stores excluded material',async()=>{
  const o=options(),r=await service.readPage(o);expect(o.read).toHaveBeenCalledTimes(1);expect(o.google).toHaveBeenCalledTimes(1);
  expect(r.fullText).toBe(fixture().activeTranscript);expect(r.source).toMatchObject({sourceFidelityMode:'gpt_vision_exact',sourceTextSha256:c.sha(r.fullText)});
  expect(o.reservation.complete.mock.calls[0][1].payload.primary.physicalLines[0].segments[0].classification).toBe('PROMPT_OR_INSTRUCTION');
  expect(r.words.every(w=>w.id.includes('_gpt_'))).toBe(true);expect(JSON.stringify(r)).not.toContain('MAXI');
});
test('geometry case/punctuation differences map monotonically without modifying GPT text',()=>{
  const g=geometry('Society powerfull 2 remains'),r=alignGeometry('society powerfull , remains',g,identity);
  expect(r.words.map(w=>w.text).join(' ')).toBe('society powerfull , remains');expect(r.words.every(w=>w.bbox)).toBe(true);
  expect(r.words[2].geometryWordId).toBe(g.words[2].id);
});
test('bounded fuzzy with local anchors maps for display only; unknown/absent geometry remains null',()=>{
  const r=alignGeometry('the powerfull word\nunknown',geometry('the powerful word'),identity);
  expect(r.words[1].text).toBe('powerfull');expect(r.words[1].bbox).toBeTruthy();expect(r.words.at(-1).bbox).toBeNull();
  expect(alignGeometry('Say Say',null,identity).words.map(w=>w.text)).toEqual(['Say','Say']);
});
test('repeated prompt/answer phrases without unique local context withhold geometry instead of guessing',()=>{
  const r=alignGeometry('the same phrase',geometry('the same phrase\nthe same phrase'),identity);
  expect(r.words.map(w=>w.text).join(' ')).toBe('the same phrase');expect(r.words.every(w=>w.bbox===null)).toBe(true);
});
test.each([['AI_PROVIDER_PAYMENT_REQUIRED','OCR_GPT_PROVIDER_PAYMENT_REQUIRED'],['AI_PROVIDER_AUTH_ERROR','OCR_GPT_PROVIDER_AUTH'],['AI_PROVIDER_PERMISSION_DENIED','OCR_GPT_PROVIDER_ACCESS'],['AI_PROVIDER_RATE_LIMIT','OCR_GPT_PROVIDER_RATE_LIMIT'],['AI_PROVIDER_UNAVAILABLE','OCR_GPT_PROVIDER_NETWORK']])('provider failure %s is safe, terminal and never falls back',async(code,wanted)=>{
  const o=options();o.read.mockRejectedValue(Object.assign(Error('SECRET unsafe body'),{code}));await expect(service.readPage(o)).rejects.toMatchObject({code:wanted,retryable:false});
  expect(o.read).toHaveBeenCalledTimes(1);expect(o.google).not.toHaveBeenCalled();expect(o.reservation.complete).toHaveBeenCalledWith('r',expect.objectContaining({status:'GPT_SOURCE_FAILED'}));
  expect(JSON.stringify(o.reservation.complete.mock.calls)).not.toContain('SECRET');
});
test('schema and uncertainty failure never run geometry or grading; successful source survives geometry failure',async()=>{
  for(const content of ['{}',JSON.stringify({...simple('known'),uncertainties:[{lineIndex:0,segmentIndex:0,kind:'ACTIVE_TEXT_UNCERTAIN',reason:'unreadable'}]})]){
    const o=options();o.read.mockResolvedValue({content,returnedModel:env.OCR_GPT_VISION_MODEL});await expect(service.readPage(o)).rejects.toThrow();expect(o.google).not.toHaveBeenCalled();expect(o.read).toHaveBeenCalledTimes(1);
  }
  const o=options();o.google.mockRejectedValue(Error('geometry unavailable'));expect((await service.readPage(o)).fullText).toBe(fixture().activeTranscript);
});
test('cached source revalidated, no new paid request, request cancellation fails before admission',async()=>{
  const o=options();o.reservation.acquire.mockResolvedValue({_id:'r',cached:true,evidence:{payload:{primary:fixture()}}});await service.readPage(o);expect(o.read).not.toHaveBeenCalled();expect(o.reservation.complete).not.toHaveBeenCalled();
  const p=options(),abort=new AbortController();abort.abort();await expect(service.readPage({...p,signal:abort.signal})).rejects.toThrow('SUPERSEDED');expect(p.reservation.acquire).not.toHaveBeenCalled();
});
test('source profiling separates provider, validation and persistence; cache reuse retains historical profile without another read',async()=>{
  let clock=1000;const timer=jest.spyOn(Date,'now').mockImplementation(()=>clock);
  try{
    const o=options();Object.assign(o.identity,{width:1200,height:1600,sourceImagePrepareMs:22});
    o.google=undefined;o.read.mockImplementation(async()=>{clock+=57000;return {content:JSON.stringify(fixture()),returnedModel:env.OCR_GPT_VISION_MODEL};});
    o.reservation.complete.mockImplementation(async()=>{clock+=12;});
    const result=await service.readPage(o),saved=o.reservation.complete.mock.calls[0][1].payload;
    expect(saved.sourceProfile).toMatchObject({sourceImagePrepareMs:22,sourceProviderMs:57000,sourceValidationMs:0,
      imageWidth:1200,imageHeight:1600,encodedImageBytes:3,requestedOutputTokens:16000,imageDetail:'provider_default'});
    expect(result.source.sourceVerificationSummary.performance.sourcePersistMs).toBe(12);
    const reused=options();reused.google=undefined;reused.reservation.acquire.mockResolvedValue({_id:'r',cached:true,evidence:{payload:saved}});
    const cache=await service.readPage(reused);
    expect(reused.read).not.toHaveBeenCalled();expect(cache.source.sourceVerificationSummary.performance).toMatchObject({
      preflightSourceMs:57000,sourceProviderCallCount:0,sourceReused:true,preflightProfile:saved.sourceProfile});
  }finally{timer.mockRestore();}
});
test('exact canonical offsets preserve repeated words, null boxes, hash source and frontend-compatible words',async()=>{
  const r=await service.readPage(options()),p={...r.pages[0],fileId:'f',fileOrder:0,pageIndex:0},d={files:['f'],sourceFidelityMode:'gpt_vision_exact',ocrPages:[p]};Object.assign(d,sf.aggregate(d));
  const canonical=sf.canonical(d);expect(sf.eligible(d)).toBe(true);expect(canonical.text).toBe(r.fullText);expect(canonical.isComplete).toBe(true);
  expect(canonical.wordSpans.filter(s=>s.word.text==='wrong')).toHaveLength(2);for(const s of canonical.wordSpans)expect(canonical.text.slice(s.start,s.end)).toBe(s.word.text);
  expect(sf.payload(d)).toBeUndefined();expect(require('../src/utils/ocrTranscriptNormalizer').buildCanonicalSubmissionTranscript(d).text).toBe(r.fullText);
  const changed=fixture();changed.physicalLines[0].segments[0].text='another excluded prompt';changed.physicalLines[2].segments[1].text='another deleted word';expect(c.sha(c.validate(JSON.stringify(changed)).activeTranscript)).toBe(d.sourceTranscriptSha256);
  const {buildCorrectionSourceHash}=require('../src/services/canonicalCorrectionsPipeline.service');
  const sourceHash=buildCorrectionSourceHash({transcript:canonical.text,pages:canonical.pages});
  const again=sf.canonical({...d,ocrPages:[{...p,privateExcludedEvidence:'different prompt/deletion'}]});
  expect(buildCorrectionSourceHash({transcript:again.text,pages:again.pages})).toBe(sourceHash);
});

test('reconciliation preserves canonical hashes, UTF-16 word identities, bytes and accepted-source reuse',async()=>{
  const lines=['  naïve 😀 wrong wrong,','powerfull Say unfinished'],primary=simple(lines.join('\n'));
  primary.activeTranscript=lines.join(' ');const original=structuredClone(primary.physicalLines),o=options(),bytes=Buffer.from(o.bytes);
  o.google=undefined;
  o.read.mockResolvedValue({content:JSON.stringify(primary),returnedModel:env.OCR_GPT_VISION_MODEL});
  const r=await service.readPage(o),saved=o.reservation.complete.mock.calls[0][1].payload;
  expect(r.fullText).toBe(lines.join('\n'));expect(r.source.sourceTextSha256).toBe(c.sha(lines.join('\n')));
  expect(r.source.sourceInputSha256).toBe(c.sha(bytes));expect(o.bytes.equals(bytes)).toBe(true);
  expect(saved.primary.physicalLines).toEqual(original);expect(saved).toMatchObject({transcriptComparison:'SEPARATOR_ONLY',transcriptReconciled:true,transcriptReconciledBoundaries:1,transcriptSeparatorSpaceCount:1});
  expect(saved.primary.activeTranscript).toBe(r.fullText);expect(o.read).toHaveBeenCalledTimes(1);
  const expected=alignGeometry(r.fullText,null,identity).words;expect(r.words).toEqual(expected);
  for(const w of r.words){expect(r.fullText.slice(w.sourceStart,w.sourceEnd)).toBe(w.text);expect(w.id).toMatch(/^word_f_1_gpt_\d+$/);}
  const doc={files:['f'],sourceFidelityMode:'gpt_vision_exact',ocrPages:[{...r.pages[0],fileId:'f',fileOrder:0,pageIndex:0}]};Object.assign(doc,sf.aggregate(doc));
  const canonical=sf.canonical(doc);expect(canonical.text).toBe(r.fullText);
  for(const span of canonical.wordSpans)expect(canonical.text.slice(span.start,span.end)).toBe(span.word.text);
  const cached=options();cached.env=o.env;cached.google=undefined;cached.reservation.acquire.mockResolvedValue({_id:'r',cached:true,evidence:{payload:saved}});
  expect((await service.readPage(cached)).words).toEqual(r.words);expect(cached.read).not.toHaveBeenCalled();expect(cached.reservation.complete).not.toHaveBeenCalled();
});
test('configuration reuses repository reader model, rejects unknown/non-GPT and requires credentials',()=>{
  expect(c.config({...env,OCR_GPT_VISION_MODEL:undefined}).model).toBe(require('../src/services/hybridSource/contract').MODEL);
  for(const model of ['anthropic/claude-fable-5.1','openai/not-verified','google/gemini'])expect(()=>c.config({...env,OCR_GPT_VISION_MODEL:model})).toThrow();
  expect(()=>c.config({...env,OPENROUTER_API_KEY:''})).toThrow();expect(require('../src/config/ocr').validateOcrConfiguration(env)).toMatchObject({teacherConfirmationRequired:false,gptVisionModel:env.OCR_GPT_VISION_MODEL});
});
test('shared transport strict routing, single request, no sampling, full-page budget and exact model validation',async()=>{
  const o={model:env.OCR_GPT_VISION_MODEL,bytes:Buffer.from([255,216,255]),mimeType:'image/jpeg',prompt:c.PROMPT,assignmentReference:{instructions:'REFERENCE ONLY'},env};
  const fetchImpl=jest.fn(async()=>({ok:true,status:200,text:async()=>JSON.stringify({model:o.model,choices:[{finish_reason:'stop',message:{content:JSON.stringify(fixture())}}]})}));
  await service.reader({...o,fetchImpl});const body=JSON.parse(fetchImpl.mock.calls[0][1].body);expect(body.provider).toEqual({require_parameters:true,allow_fallbacks:false});
  expect(body).not.toHaveProperty('temperature');expect(body.max_completion_tokens).toBe(16000);expect(body.response_format.json_schema.strict).toBe(true);expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(body.messages[0].content).toBe(c.PROMPT);expect(body.messages[1].content[1].image_url.url).toContain('data:image/jpeg;base64,');
  fetchImpl.mockResolvedValue({ok:true,status:200,text:async()=>JSON.stringify({model:'different',choices:[]})});await expect(service.reader({...o,fetchImpl})).rejects.toMatchObject({code:'OCR_SOURCE_MODEL_IDENTITY'});
});
test.each([401,402,403,429])('real shared transport maps HTTP %i without retries or unsafe body',async status=>{
  const fetchImpl=jest.fn(async()=>({ok:false,status,text:async()=>JSON.stringify({error:{message:'PRIVATE KEY ECHO'}})}));
  await expect(service.reader({model:env.OCR_GPT_VISION_MODEL,bytes:Buffer.from([255,216,255]),mimeType:'image/jpeg',prompt:c.PROMPT,assignmentReference:{},env,fetchImpl})).rejects.toMatchObject({code:expect.stringMatching(/^AI_PROVIDER_/)});expect(fetchImpl).toHaveBeenCalledTimes(1);
});
test('safe logs exclude image/source/reference/provider error contents',async()=>{
  const spy=jest.spyOn(require('../src/utils/logger'),'info').mockImplementation(()=>{});try{
    const o=options();o.read.mockImplementation(async v=>{v.onDiagnostic({httpStatus:402,failureStage:'HTTP_ERROR_RESPONSE',rawBody:'SECRET'});throw Object.assign(Error('SECRET'),{code:'AI_PROVIDER_PAYMENT_REQUIRED'});});
    await expect(service.readPage(o)).rejects.toThrow();const log=spy.mock.calls.map(([v])=>v).find(v=>v.event==='gpt_vision_source_reader');expect(log.httpStatus).toBe(402);expect(JSON.stringify(log)).not.toMatch(/SECRET|base64|Social|Authorization/);
  }finally{spy.mockRestore();}
});
