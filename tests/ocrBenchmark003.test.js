'use strict';
const fs=require('fs'),path=require('path'),sharp=require('sharp');
const benchmark=require('../scripts/ocr-benchmark-003-live.cjs'),source=require('../src/services/sourceFidelityOcr.service');
const env={NODE_ENV:'test',OPENROUTER_API_KEY:'mock-private-key'};
const segment=(type,text)=>({type,text,confidence:.7,notes:''});
const reading=(text='  miSpel,\nwee  ')=>( {activeTranscript:text,segments:text.split('\n').map(t=>segment('ACTIVE_STUDENT_TEXT',t)),uncertainSpans:[]} );
const response=(payload,status=200)=>({ok:status>=200&&status<300,status,text:async()=>typeof payload==='string'?payload:JSON.stringify(payload)});
const fetchOK=(get=()=>reading())=>jest.fn(async(_url,options)=>{const body=JSON.parse(options.body);return response({model:body.model,
  choices:[{finish_reason:'stop',message:{content:JSON.stringify(get(body.model))}}],usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30,cost:.015}});});
let original,prepared,manifest;
beforeAll(async()=>{
  original=await sharp({create:{width:40,height:80,channels:3,background:'#d5d7d9'}}).jpeg().withMetadata({orientation:6}).toBuffer();
  const normalized=await sharp(original).rotate().toBuffer(),meta=await sharp(normalized).metadata();
  manifest={...benchmark.MANIFEST,originalSha256:source.sha(original),normalizedSha256:source.sha(normalized),dimensions:{width:meta.width,height:meta.height}};
  prepared=await benchmark.normalize(original,manifest);
});
const run=(options={})=>benchmark.runPair(prepared,{env,manifest,...options});

test('CLI accepts only the pinned new image and optional exact flag; no path or model overrides',()=>{
  const p=benchmark.MANIFEST.imagePathRelative;
  expect(benchmark.args(['--image',p])).toEqual({imagePathRelative:p,allowLive:false});expect(benchmark.args(['--image',p,'--allow-live']).allowLive).toBe(true);
  for(const args of [[],['--image','other.jpeg'],['--image','../'+p],['--image',p,'--allow-live','--allow-live'],['--image',p,'--model','other/model']])expect(()=>benchmark.args(args)).toThrow('BENCHMARK_USAGE');
});
test('normalization uses only existing EXIF rotation and records exact original/normalized identity and dimensions',async()=>{
  expect(prepared.dimensions).toEqual({width:80,height:40});expect(prepared.originalSha256).toBe(source.sha(original));
  const reference=await sharp(original).rotate().toBuffer();expect(prepared.bytes.equals(reference)).toBe(true);expect(prepared.normalizedSha256).toBe(source.sha(reference));expect(prepared.mimeType).toBe('image/jpeg');
});
test.each(['original','normalized','dimensions','mime'])('bad %s identity fails before any provider call',async kind=>{
  const fetchImpl=fetchOK();if(kind==='original')await expect(benchmark.normalize(Buffer.from('other'),manifest)).rejects.toThrow('BENCHMARK_ORIGINAL_IDENTITY');
  else{const bad={...prepared};if(kind==='normalized')bad.bytes=Buffer.from('changed');if(kind==='dimensions')bad.dimensions={width:1,height:1};if(kind==='mime')bad.mimeType='image/png';
    await expect(benchmark.runPair(bad,{env,manifest,fetchImpl,allowLive:true})).rejects.toThrow('BENCHMARK_NORMALIZED_IDENTITY');}expect(fetchImpl).not.toHaveBeenCalled();
});
test('no --allow-live requires no credentials and invokes neither reader nor transport',async()=>{
  const fetchImpl=fetchOK(),spy=jest.spyOn(source,'reader');try{const r=await run({env:{NODE_ENV:'test'},fetchImpl});expect(r.providerCalls).toBe(0);expect(r.status).toBe('PREFLIGHT_ONLY');expect(r.readers).toEqual([]);expect(fetchImpl).not.toHaveBeenCalled();expect(spy).not.toHaveBeenCalled();expect(r.humanGoldUsed).toBe(false);}finally{spy.mockRestore();}
});
test('actual full-page reader emits identical image/prompt/schema/profile and strict keys for the two exact models',async()=>{
  const fetchImpl=fetchOK(),spy=jest.spyOn(source,'reader'),before=Buffer.from(prepared.bytes);try{const r=await run({fetchImpl,allowLive:true});
    expect(r.providerCalls).toBe(2);expect(fetchImpl).toHaveBeenCalledTimes(2);expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls.every(([args])=>args.targeted===false&&args.images===undefined)).toBe(true);
    const bodies=fetchImpl.mock.calls.map(c=>JSON.parse(c[1].body));expect(bodies.map(b=>b.model)).toEqual(['openai/gpt-6-astra','anthropic/claude-fable-5.1']);
    expect(bodies[0].messages).toEqual(bodies[1].messages);expect(bodies[0].response_format).toEqual(bodies[1].response_format);
    for(const body of bodies){expect(Object.keys(body).sort()).toEqual(['model','messages','max_completion_tokens','response_format','provider'].sort());
      expect(body.max_completion_tokens).toBe(12000);expect(body.provider).toEqual({require_parameters:true,allow_fallbacks:false});expect(body.response_format.json_schema.schema).toEqual(source.schema);
      expect(body.messages).toEqual(source.readerMessages({bytes:prepared.bytes,mimeType:'image/jpeg',prompt:source.PROMPT,targeted:false}));
      expect(body.messages[1].content).toHaveLength(2);expect(body.messages[1].content[1].image_url.url).toBe('data:image/jpeg;base64,'+prepared.bytes.toString('base64'));
      expect(JSON.stringify(body.messages)).not.toContain(reading().activeTranscript);}
    expect(r.readers[0]).toMatchObject({schemaValid:true,outcome:'SUCCESS',validationStage:'SOURCE_CONTRACT_VALIDATED',reportedCost:.015,usage:{prompt_tokens:10,total_tokens:30}});
    expect(r.readers[0].activeTranscript).toBe(reading().activeTranscript);expect(prepared.bytes.equals(before)).toBe(true);
    expect(r.pair).toEqual({activeTextExactEqual:true,segmentSignatureEqual:true,hasUncertainty:false});expect(r.sourceMutation).toBe(false);expect(r).not.toHaveProperty('reconciliation');expect(r).not.toHaveProperty('winner');
  }finally{spy.mockRestore();}
});
test('deleted, overwritten/uncertain and artifact material remain separate; active literal text is never normalized',async()=>{
  const value=reading();value.segments.push(segment('CROSSED_OUT_OR_DELETED','removed phrase'),segment('CROSSED_OUT_OR_DELETED',null),segment('NON_STUDENT_ARTIFACT','branding'),segment('UNCERTAIN',null));
  value.uncertainSpans.push({visibleContext:'visible strokes',candidateReading:null,reason:'overlapping revisions'});
  const r=await run({allowLive:true,fetchImpl:fetchOK(()=>value)}),reader=r.readers[0];
  expect(reader.activeTranscript).toBe(value.activeTranscript);expect(reader.segments).toEqual(value.segments);expect(reader.uncertainSpans).toEqual(value.uncertainSpans);
  expect(reader).toMatchObject({activeSegmentCount:2,deletedSegmentCount:2,artifactSegmentCount:1,uncertainSegmentCount:1});
  expect(reader.deletedTextPresentInActiveTranscriptCheck.status).toBe('NOT_EVALUABLE');expect(reader.deletedTextPresentInActiveTranscriptCheck.segments.map(s=>s.status)).toEqual(['NO_LITERAL_OVERLAP_FOUND','NOT_EVALUABLE']);expect(r.pair.hasUncertainty).toBe(true);
});
test.each([['known absent','removed','NO_LITERAL_OVERLAP_FOUND'],['known overlap','aa','LITERAL_OVERLAP_FLAGGED'],['unknown',null,'NOT_EVALUABLE'],['empty','','NOT_EVALUABLE'],['case mismatch','AA','NO_LITERAL_OVERLAP_FOUND']])('deletion check %s uses only exact returned literals',(_label,deleted,status)=>{
  const value=reading('aa bb');value.segments.push(segment('CROSSED_OUT_OR_DELETED',deleted));expect(benchmark.deletionAudit(value).deletedTextPresentInActiveTranscriptCheck.status).toBe(status);
});
test('pair compares exact active text and ordered role signature independently, with no merge or winner',async()=>{
  const r=await run({allowLive:true,fetchImpl:fetchOK(model=>{const value=reading(model===benchmark.MODELS[0]?'X':'x');if(model===benchmark.MODELS[1])value.segments.push(segment('CROSSED_OUT_OR_DELETED','deleted'));return value;})});
  expect(r.pair).toEqual({activeTextExactEqual:false,segmentSignatureEqual:false,hasUncertainty:false});expect(r.readers.map(r=>r.activeTranscript)).toEqual(['X','x']);expect(r.status).toBe('EVIDENCE_COLLECTION_COMPLETE');
});
test('transport errors are not retried and never retained as raw messages',async()=>{
  const fetchImpl=jest.fn(async()=>{throw Object.assign(Error('private key secret and provider body'),{code:'ECONNRESET'});}),r=await run({allowLive:true,fetchImpl});
  expect(fetchImpl).toHaveBeenCalledTimes(2);expect(r.providerCalls).toBe(2);expect(r.readers.every(r=>r.outcome==='TRANSPORT_FAILED')).toBe(true);expect(JSON.stringify(r)).not.toContain('private key secret');expect(r.pair.activeTextExactEqual).toBeNull();
});
test('returned model mismatch is rejected with known usage retained and no substitution',async()=>{
  const fetchImpl=jest.fn(async()=>response({model:'other/model',choices:[],usage:{cost:.03,total_tokens:7}})),r=await run({allowLive:true,fetchImpl});
  expect(fetchImpl).toHaveBeenCalledTimes(2);expect(r.readers[0]).toMatchObject({outcome:'MODEL_ID_MISMATCH',schemaValid:false,returnedModel:'other/model',reportedCost:.03,validationStage:'MODEL_IDENTITY'});
});
test.each(['schema','contract','inner-json','outer-json'])('%s failure is safe and retains known cost on a parsed transport envelope',async kind=>{
  const fetchImpl=jest.fn(async(_u,o)=>{if(kind==='outer-json')return response('invalid JSON');const value=reading();if(kind==='schema')value.unexpected=true;if(kind==='contract')value.activeTranscript='mismatch';
    return response({model:JSON.parse(o.body).model,choices:[{finish_reason:'stop',message:{content:kind==='inner-json'?'invalid JSON':JSON.stringify(value)}}],usage:{cost:.04,total_tokens:15}});});
  const r=await run({allowLive:true,fetchImpl});expect(r.readers[0].schemaValid).toBe(false);expect(r.readers[0].reportedCost).toBe(kind==='outer-json'?null:.04);expect(r.readers[0].activeTranscript).toBeNull();expect(r.readers[0].deletedTextPresentInActiveTranscriptCheck.status).toBe('NOT_EVALUABLE');
  expect(r.readers[0].outcome).toBe(kind==='contract'?'SOURCE_CONTRACT_VALIDATION_FAILED':'SCHEMA_VALIDATION_FAILED');
});
test('raw HTTP error body, key and authorization header never enter the result or normal logs',async()=>{
  const log=jest.spyOn(console,'log').mockImplementation(()=>{}),error=jest.spyOn(console,'error').mockImplementation(()=>{});
  try{const r=await run({allowLive:true,fetchImpl:jest.fn(async()=>response({error:{code:400,message:'secret raw error body',metadata:{key:env.OPENROUTER_API_KEY}}},400))});
    const serialized=JSON.stringify({r,logs:log.mock.calls,errors:error.mock.calls});for(const secret of ['secret raw error body',env.OPENROUTER_API_KEY,'Authorization'])expect(serialized).not.toContain(secret);expect(r.readers[0].outcome).toBe('HTTP_FAILED');
  }finally{log.mockRestore();error.mockRestore();}
});
test('independent cap refuses extra reader attempts even if shared reader unexpectedly invokes transport twice',async()=>{
  const originalReader=source.reader,fetchImpl=fetchOK(),spy=jest.spyOn(source,'reader').mockImplementation(async options=>{await originalReader(options);return originalReader(options);});
  try{const r=await run({allowLive:true,fetchImpl});expect(fetchImpl).toHaveBeenCalledTimes(2);expect(r.providerCalls).toBe(2);expect(r.readers.every(r=>r.safeFailureCode==='BENCHMARK_CALL_LIMIT')).toBe(true);}finally{spy.mockRestore();}
});
test('no credentials, production mode or wrong image path fails before provider access',async()=>{
  const fetchImpl=fetchOK();await expect(run({env:{NODE_ENV:'test'},allowLive:true,fetchImpl})).rejects.toThrow('OCR_SOURCE_CONFIGURATION_INVALID');
  await expect(run({env:{...env,NODE_ENV:'production'},allowLive:true,fetchImpl})).rejects.toThrow('BENCHMARK_LOCAL_ONLY');
  await expect(benchmark.prepare('other.jpeg')).rejects.toThrow('BENCHMARK_IMAGE_PATH');expect(fetchImpl).not.toHaveBeenCalled();
});
test('private output is reserved exclusively before use and safely rewritten through its open file handle',async()=>{
  const output=await benchmark.reserveResult();try{
    expect(fs.existsSync(output.filename)).toBe(true);await output.write({status:'PREFLIGHT_VERIFIED',providerCalls:0});await output.write({status:'PREFLIGHT_ONLY'});
    expect(JSON.parse(fs.readFileSync(output.filename,'utf8'))).toEqual({status:'PREFLIGHT_ONLY'});expect(output.filename).toContain(path.join('tmp','ocr-benchmark-results'));
  }finally{await output.handle.close();fs.unlinkSync(output.filename);}
});
test('file-only runner contains no Google/job/targeted/persistence/previous-output/human-gold imports or image enhancements',()=>{
  const code=fs.readFileSync(path.join(__dirname,'../scripts/ocr-benchmark-003-live.cjs'),'utf8');
  for(const forbidden of ['mongoose','targetedVerification','magnifiedFocusV4','visualContextV3','golden-002','fixtures/','readPage(','updateOne(','findOneAndUpdate(','.resize(','.extract(','.sharpen(','.threshold(','.normalise(','.normalize('])expect(code).not.toContain(forbidden);
  expect(code).toContain('await source.reader(');expect(code).not.toContain(reading().activeTranscript);
});
