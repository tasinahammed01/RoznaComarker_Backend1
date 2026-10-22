'use strict';
const fs=require('fs'),path=require('path'),sharp=require('sharp');
const resume=require('../scripts/ocr-benchmark-003-fable-resume.cjs'),base=require('../scripts/ocr-benchmark-003-live.cjs'),source=require('../src/services/sourceFidelityOcr.service');
const env={NODE_ENV:'test',OPENROUTER_API_KEY:'synthetic-private-key'};
const segment=(type,text)=>({type,text,confidence:.7,notes:''});
const reading=text=>({activeTranscript:text,segments:text.split('\n').map(t=>segment('ACTIVE_STUDENT_TEXT',t)),uncertainSpans:[]});
const historicalText='SYNTHETIC_STORED_EVIDENCE_ONLY\n  miSpel,\t ';
const newText='  new miSpel,\nLiNe  ';
const response=(body,status=200)=>({ok:status>=200&&status<300,status,text:async()=>typeof body==='string'?body:JSON.stringify(body)});
const successful=(value=reading(newText))=>jest.fn(async(_u,o)=>response({model:JSON.parse(o.body).model,choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}],usage:{prompt_tokens:12,completion_tokens:30,total_tokens:42,cost:.025}}));
let image,imageManifest,parentTemplate;
beforeAll(async()=>{
  const original=await sharp({create:{width:48,height:64,channels:3,background:'white'}}).jpeg().toBuffer(),normalized=await sharp(original).rotate().toBuffer();
  imageManifest={...base.MANIFEST,originalSha256:source.sha(original),normalizedSha256:source.sha(normalized),dimensions:{width:48,height:64}};image=await base.normalize(original,imageManifest);
  const value=reading(historicalText),astra={requestedModel:resume.ASTRA,returnedModel:resume.ASTRA,outcome:'SUCCESS',httpStatus:200,transportOutcome:'HTTP_SUCCESS',validationStage:'SOURCE_CONTRACT_VALIDATED',safeFailureCode:null,schemaValid:true,durationMs:12345,usage:{cost:.2029675},reportedCost:.2029675,...value,...base.deletionAudit(value)};
  parentTemplate={benchmarkId:'003',status:'EVIDENCE_COLLECTION_COMPLETE',providerCalls:2,sourceMutation:false,humanGoldUsed:false,googleCalls:0,imagePathRelative:image.imagePathRelative,originalSha256:image.originalSha256,normalizedSha256:image.normalizedSha256,dimensions:image.dimensions,mimeType:image.mimeType,promptSha256:resume.PIN.promptSha256,
    readers:[astra,{requestedModel:resume.FABLE,returnedModel:null,outcome:'HTTP_FAILED',httpStatus:402,safeFailureCode:'AI_PROVIDER_PAYMENT_REQUIRED',schemaValid:false,activeTranscript:null,segments:null,uncertainSpans:null}]};
});
function fixture(change){const parent=JSON.parse(JSON.stringify(parentTemplate));change?.(parent);const parentBytes=Buffer.from(JSON.stringify(parent)),pin={...resume.PIN,parentArtifactSha256:source.sha(parentBytes)};return {prepared:{parentBytes,parentArtifact:pin.parentArtifact,image:{...image,dimensions:{...image.dimensions}}},pin,parent};}
const run=(f,options={})=>resume.runResume(f.prepared,{pin:f.pin,imageManifest,env,...options});

test('CLI accepts only no flag or one live flag, never arbitrary paths/models',()=>{
  expect(resume.args([])).toEqual({allowLive:false});expect(resume.args(['--allow-live'])).toEqual({allowLive:true});
  for(const args of [['--allow-live','--allow-live'],['--parent','file.json'],['--image','other.jpeg'],['--model','other/model']])expect(()=>resume.args(args)).toThrow('FABLE_RESUME_USAGE');
});
test('without flag there are zero reader/fetch calls and no combined transcript/comparison',async()=>{
  const f=fixture(),fetchImpl=successful(),spy=jest.spyOn(source,'reader');try{const r=await run(f,{env:{NODE_ENV:'test'},fetchImpl});expect(r.status).toBe('PREFLIGHT_ONLY');expect(r.providerCalls).toBe(0);expect(r.astraProviderCallsThisRun).toBe(0);expect(r.fableProviderCallsThisRun).toBe(0);expect(r.combinedDiagnostic).toBeNull();expect(fetchImpl).not.toHaveBeenCalled();expect(spy).not.toHaveBeenCalled();}finally{spy.mockRestore();}
});
test('one real shared full-page reader request is Fable only, matching image/prompt/schema/profile with no Astra evidence',async()=>{
  const f=fixture(),fetchImpl=successful(),spy=jest.spyOn(source,'reader'),before=Buffer.from(f.prepared.parentBytes);try{const r=await run(f,{allowLive:true,fetchImpl});
    expect(r.status).toBe('FABLE_RESUME_COMPLETE');expect(r.providerCalls).toBe(1);expect(r.fableProviderCallsThisRun).toBe(1);expect(r.astraProviderCallsThisRun).toBe(0);expect(fetchImpl).toHaveBeenCalledTimes(1);expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({model:resume.FABLE,targeted:false});expect(spy.mock.calls[0][0].images).toBeUndefined();
    const body=JSON.parse(fetchImpl.mock.calls[0][1].body);expect(Object.keys(body).sort()).toEqual(['model','messages','max_completion_tokens','response_format','provider'].sort());expect(body.model).toBe(resume.FABLE);expect(body.max_completion_tokens).toBe(12000);expect(body.provider).toEqual({require_parameters:true,allow_fallbacks:false});expect(body.response_format.json_schema.schema).toEqual(source.schema);
    expect(body.messages).toEqual(source.readerMessages({bytes:image.bytes,mimeType:image.mimeType,prompt:source.PROMPT,targeted:false}));expect(body.messages[1].content[1].image_url.url).toBe('data:image/jpeg;base64,'+image.bytes.toString('base64'));expect(JSON.stringify(body)).not.toContain(historicalText.split('\n')[0]);
    const [a,b]=r.combinedDiagnostic.readers;expect(a.evidenceOrigin).toBe('ORIGINAL_BENCHMARK_003_LIVE_ARTIFACT');expect(a.reader).toEqual(f.parent.readers[0]);expect(JSON.stringify(a.reader)).toBe(JSON.stringify(f.parent.readers[0]));expect(b.evidenceOrigin).toBe('FABLE_RESUME_LIVE_CALL');expect(b.reader.activeTranscript).toBe(newText);expect(b.reader.reportedCost).toBe(.025);expect(b.reader.durationMs).toEqual(expect.any(Number));expect(f.prepared.parentBytes.equals(before)).toBe(true);
    expect(r.combinedDiagnostic.pair).toMatchObject({activeTextExactEqual:false,segmentSignatureEqual:false,hasUncertainty:false,lineCountAstra:2,lineCountFable:2,characterLengthAstra:historicalText.length,characterLengthFable:newText.length});
  }finally{spy.mockRestore();}
});
test.each(['benchmarkId','status','providerCalls','sourceMutation','humanGoldUsed','googleCalls','promptSha256','originalSha256','normalizedSha256','mimeType'])('parent requires exact %s even with an otherwise matching content hash',async field=>{
  const f=fixture(p=>{p[field]=typeof p[field]==='boolean'?!p[field]:'wrong';}),fetchImpl=successful();await expect(run(f,{allowLive:true,fetchImpl})).rejects.toThrow('FABLE_RESUME_PARENT_INVALID');expect(fetchImpl).not.toHaveBeenCalled();
});
test('parent exact file hash and pinned path are required',async()=>{
  const f=fixture(),fetchImpl=successful();f.prepared.parentBytes=Buffer.from('changed');await expect(run(f,{allowLive:true,fetchImpl})).rejects.toThrow('FABLE_RESUME_PARENT_HASH');
  const other=fixture();other.prepared.parentArtifact='other.json';await expect(run(other,{allowLive:true,fetchImpl})).rejects.toThrow('FABLE_RESUME_PARENT_PATH');expect(fetchImpl).not.toHaveBeenCalled();
});
test.each(['outcome','returnedModel','httpStatus','schemaValid','validationStage','contract'])('original valid Astra %s is required',async field=>{
  const f=fixture(p=>{const a=p.readers[0];if(field==='contract')a.activeTranscript='not its segments';else a[field]=field==='schemaValid'?false:'wrong';}),fetchImpl=successful();
  await expect(run(f,{allowLive:true,fetchImpl})).rejects.toThrow('FABLE_RESUME_ASTRA_INVALID');expect(fetchImpl).not.toHaveBeenCalled();
});
test.each(['requestedModel','outcome','httpStatus','safeFailureCode','schemaValid','activeTranscript'])('historical Fable 402 %s is required',async field=>{
  const f=fixture(p=>{p.readers[1][field]=field==='schemaValid'?true:'wrong';}),fetchImpl=successful();await expect(run(f,{allowLive:true,fetchImpl})).rejects.toThrow(/^FABLE_RESUME_/);expect(fetchImpl).not.toHaveBeenCalled();
});
test.each(['originalSha256','bytes','dimensions','mimeType'])('normalized image %s fails before transport',async field=>{
  const f=fixture(),fetchImpl=successful();f.prepared.image[field]=field==='bytes'?Buffer.from('substituted'):field==='dimensions'?{width:1,height:1}:'wrong';await expect(run(f,{allowLive:true,fetchImpl})).rejects.toThrow('BENCHMARK_NORMALIZED_IDENTITY');expect(fetchImpl).not.toHaveBeenCalled();
});
test('current prompt and schema must match pinned identities',async()=>{
  const f=fixture(),fetchImpl=successful(),real=source.sha,spy=jest.spyOn(source,'sha').mockImplementation(v=>v===source.PROMPT?'f'.repeat(64):real(v));
  try{await expect(run(f,{allowLive:true,fetchImpl})).rejects.toThrow('FABLE_RESUME_PROMPT_CHANGED');}finally{spy.mockRestore();}
  const schema=jest.spyOn(source,'sha').mockImplementation(v=>v===JSON.stringify(source.schema)?'f'.repeat(64):real(v));
  try{await expect(run(f,{allowLive:true,fetchImpl})).rejects.toThrow('FABLE_RESUME_SCHEMA_CHANGED');expect(fetchImpl).not.toHaveBeenCalled();}finally{schema.mockRestore();}
});
test.each([402,429,500,503])('HTTP %s is recorded once and stops without Astra, retry or fabricated success',async status=>{
  const f=fixture(),fetchImpl=jest.fn(async()=>response({error:{code:status,message:'private raw body'}},status)),r=await run(f,{allowLive:true,fetchImpl});expect(fetchImpl).toHaveBeenCalledTimes(1);expect(r.status).toBe('FABLE_RESUME_FAILED');expect(r.providerCalls).toBe(1);expect(r.astraProviderCallsThisRun).toBe(0);expect(r.combinedDiagnostic.pair).toBeNull();
  const reader=r.combinedDiagnostic.readers[1].reader;expect(reader.outcome).toBe('HTTP_FAILED');expect(reader.httpStatus).toBe(status);expect(reader.schemaValid).toBe(false);expect(reader.activeTranscript).toBeNull();expect(reader.reportedCost).toBeNull();if(status===402)expect(reader.safeFailureCode).toBe('AI_PROVIDER_PAYMENT_REQUIRED');expect(JSON.stringify(r)).not.toContain('private raw body');
});
test('timeout is one attempt and unknown cost remains unknown',async()=>{
  jest.useFakeTimers();const f=fixture(),fetchImpl=jest.fn((_u,o)=>new Promise((_resolve,reject)=>o.signal.addEventListener('abort',()=>reject(Object.assign(Error('private timeout'),{name:'AbortError'})),{once:true})));
  try{const pending=run(f,{allowLive:true,fetchImpl});await jest.advanceTimersByTimeAsync(180005);const r=await pending;expect(fetchImpl).toHaveBeenCalledTimes(1);expect(r.status).toBe('FABLE_RESUME_FAILED');expect(r.combinedDiagnostic.readers[1].reader).toMatchObject({outcome:'TIMEOUT',reportedCost:null,schemaValid:false});}finally{jest.useRealTimers();}
});
test.each(['transport','model','schema','contract'])('%s failure is not retried and known usage survives validation rejection',async kind=>{
  const f=fixture(),fetchImpl=jest.fn(async(_u,o)=>{if(kind==='transport')throw Error('secret private key');const value=reading(newText);if(kind==='schema')value.extra='invalid';if(kind==='contract')value.activeTranscript='different';return response({model:kind==='model'?resume.ASTRA:JSON.parse(o.body).model,choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}],usage:{cost:.04,total_tokens:50}});});
  const r=await run(f,{allowLive:true,fetchImpl}),reader=r.combinedDiagnostic.readers[1].reader;expect(fetchImpl).toHaveBeenCalledTimes(1);expect(r.status).toBe('FABLE_RESUME_FAILED');expect(r.combinedDiagnostic.pair).toBeNull();expect(reader.reportedCost).toBe(kind==='transport'?null:.04);expect(JSON.stringify(r)).not.toContain('secret private key');
  expect(reader.outcome).toBe({transport:'TRANSPORT_FAILED',model:'MODEL_ID_MISMATCH',schema:'SCHEMA_VALIDATION_FAILED',contract:'SOURCE_CONTRACT_VALIDATION_FAILED'}[kind]);
});
test('exact original deletion diagnostics are reused without normalizing Fable strings',async()=>{
  const f=fixture(),value=reading(newText);value.segments.push(segment('CROSSED_OUT_OR_DELETED',null),segment('CROSSED_OUT_OR_DELETED','new'),segment('NON_STUDENT_ARTIFACT','camera'),segment('UNCERTAIN',null));value.uncertainSpans.push({visibleContext:'strokes',candidateReading:null,reason:'overwritten'});
  const r=await run(f,{allowLive:true,fetchImpl:successful(value)}),reader=r.combinedDiagnostic.readers[1].reader;expect(reader.activeTranscript).toBe(newText);expect(reader.segments).toEqual(value.segments);expect(reader.deletedTextPresentInActiveTranscriptCheck).toEqual(base.deletionAudit(value).deletedTextPresentInActiveTranscriptCheck);expect(reader).toMatchObject({activeSegmentCount:2,deletedSegmentCount:2,artifactSegmentCount:1,uncertainSegmentCount:1});expect(r.combinedDiagnostic.pair.hasUncertainty).toBe(true);
});
test('independent admission cap blocks an internal extra fetch without admitting Astra or another Fable call',async()=>{
  const f=fixture(),fetchImpl=successful(),original=source.reader,spy=jest.spyOn(source,'reader').mockImplementation(async args=>{await original(args);return original(args);});
  try{const r=await run(f,{allowLive:true,fetchImpl});expect(fetchImpl).toHaveBeenCalledTimes(1);expect(r.providerCalls).toBe(1);expect(r.status).toBe('FABLE_RESUME_FAILED');expect(r.combinedDiagnostic.readers[1].reader.safeFailureCode).toBe('FABLE_RESUME_CALL_LIMIT');}finally{spy.mockRestore();}
});
test('wrong model request is blocked locally by the wire guard before any network admission',async()=>{
  const f=fixture(),fetchImpl=successful(),original=source.reader,spy=jest.spyOn(source,'reader').mockImplementation(args=>original({...args,model:resume.ASTRA}));
  try{const r=await run(f,{allowLive:true,fetchImpl});expect(fetchImpl).not.toHaveBeenCalled();expect(r.providerCalls).toBe(0);expect(r.status).toBe('FABLE_RESUME_FAILED');}finally{spy.mockRestore();}
});
test('missing credentials and wrong endpoint fail without balance probe or network admission',async()=>{
  const f=fixture(),fetchImpl=successful();await expect(run(f,{env:{NODE_ENV:'test'},allowLive:true,fetchImpl})).rejects.toThrow('OCR_SOURCE_CONFIGURATION_INVALID');await expect(run(f,{env:{...env,OPENROUTER_BASE_URL:'https://other.invalid'},allowLive:true,fetchImpl})).rejects.toThrow('FABLE_RESUME_CONFIGURATION_INVALID');expect(fetchImpl).not.toHaveBeenCalled();
});
test('new exclusive resume result never overwrites the pinned original; privacy-sensitive data stays out of console',async()=>{
  const parentPath=path.resolve(__dirname,'../..',resume.PIN.parentArtifact),before=fs.existsSync(parentPath)?source.sha(fs.readFileSync(parentPath)):null;
  const output=await resume.reserveResult(),log=jest.spyOn(console,'log').mockImplementation(()=>{}),error=jest.spyOn(console,'error').mockImplementation(()=>{});
  try{const r=await run(fixture(),{allowLive:true,fetchImpl:successful()});await output.write(r);expect(output.filename).not.toBe(parentPath);expect(path.basename(output.filename)).toMatch(/^benchmark-003-fable-resume-/);expect(JSON.parse(fs.readFileSync(output.filename)).combinedDiagnostic.readers[0].reader).toEqual(parentTemplate.readers[0]);
    const logs=JSON.stringify([log.mock.calls,error.mock.calls]);for(const secret of [historicalText,newText,env.OPENROUTER_API_KEY,'Authorization'])expect(logs).not.toContain(secret);if(before)expect(source.sha(fs.readFileSync(parentPath))).toBe(before);
  }finally{await output.handle.close();fs.unlinkSync(output.filename);log.mockRestore();error.mockRestore();}
});
test('no human gold, expected lines, Google, application persistence or pair-runner entrypoints exist',()=>{
  const code=fs.readFileSync(path.join(__dirname,'../scripts/ocr-benchmark-003-fable-resume.cjs'),'utf8');for(const banned of ['fixtures/','golden-002','mongoose','readPage(','runPair(','updateOne(','findOneAndUpdate(','scheduleSubmissionAnalysis','targetedVerification','google()'])expect(code).not.toContain(banned);expect(code).not.toContain(historicalText);expect(code).toContain('await source.reader(');
});
