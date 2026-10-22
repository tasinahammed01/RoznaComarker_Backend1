'use strict';
const {PIN,args,prepare,runPair}=require('../scripts/targeted-v2-live-smoke.cjs');
const source=require('../src/services/sourceFidelityOcr.service');
const t=require('../src/services/sourceFidelity/targetedVerification');
const history=require('./fixtures/source-fidelity/targeted-failed-run.cjs');
const env={NODE_ENV:'test',OCR_ASTRA_MODEL:'openai/gpt-6-astra',OCR_FABLE_MODEL:'anthropic/claude-fable-5.1',OPENROUTER_API_KEY:'mock-secret'};
const bytes=Buffer.from('isolated test crop; never network data');
const reading=text=>({activeTranscript:text,segments:[{type:'ACTIVE_STUDENT_TEXT',text,confidence:.8,notes:''}],uncertainSpans:[]});
const prepared=()=>({page:structuredClone(history.pages[0]),region:structuredClone(history.pages[0].targeted.results[7].region),
  crop:{bytes,mimeType:'image/png',cropSha256:PIN.cropSha256,cropDimensions:{width:PIN.width,height:PIN.height}}});
let spy;
beforeEach(()=>{
  // Only the isolated transport fixture's hash is substituted; production uses real SHA verification.
  const real=source.sha;spy=jest.spyOn(source,'sha').mockImplementation(v=>Buffer.isBuffer(v)&&v.equals(bytes)?PIN.cropSha256:real(v));
});
afterEach(()=>spy.mockRestore());
const response=(body,status=200)=>({ok:status>=200&&status<300,status,text:async()=>typeof body==='string'?body:JSON.stringify(body)});
const successful=()=>jest.fn(async(_url,o)=>{const b=JSON.parse(o.body);return response({model:b.model,
  choices:[{finish_reason:'stop',message:{content:JSON.stringify(reading('shift The literal of any human begin, as'))}}],usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30,cost:.02}});});
test('explicit allow-live flag only; unsupported submission/slot/flags rejected',()=>{
  expect(args(['--submission',PIN.submissionId,'--slot','8']).allowLive).toBe(false);
  expect(args(['--submission',PIN.submissionId,'--slot','8','--allow-live']).allowLive).toBe(true);
  for(const a of [['--submission',PIN.submissionId,'--slot','7'],['--submission','other','--slot','8'],['--submission',PIN.submissionId,'--slot','8','--allow-live','--allow-live']])expect(()=>args(a)).toThrow('SMOKE_USAGE');
});
test('without allow-live no fetch, source.reader, gold comparison or patch is performed',async()=>{
  const fetchImpl=successful(),read=jest.spyOn(source,'reader');
  try{const r=await runPair(prepared(),{env,fetchImpl});expect(r.providerCalls).toBe(0);expect(fetchImpl).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();expect(r).not.toHaveProperty('humanGoldComparison');expect(r.status).toBe('PREFLIGHT_ONLY');
  }finally{read.mockRestore();}
});
test('exact production reader wire contract, two requests, matching crop/prompt/schema/budget, no contamination',async()=>{
  const fetchImpl=successful(),read=jest.spyOn(source,'reader');const before=prepared(),snapshot=JSON.stringify(before.page);
  try{const r=await runPair(before,{env,fetchImpl,allowLive:true});expect(r.providerCalls).toBe(2);expect(fetchImpl).toHaveBeenCalledTimes(2);expect(read).toHaveBeenCalledTimes(2);
    const bodies=fetchImpl.mock.calls.map(c=>JSON.parse(c[1].body));expect(bodies.map(b=>b.model)).toEqual([env.OCR_ASTRA_MODEL,env.OCR_FABLE_MODEL]);
    expect(bodies[0].messages).toEqual(bodies[1].messages);expect(bodies[0].response_format).toEqual(bodies[1].response_format);
    for(const b of bodies){expect(Object.keys(b).sort()).toEqual(['model','messages','max_completion_tokens','response_format','provider'].sort());
      expect(b).not.toHaveProperty('temperature');expect(b).not.toHaveProperty('max_tokens');expect(b.max_completion_tokens).toBe(12000);
      expect(b.provider).toEqual({require_parameters:true,allow_fallbacks:false});expect(b.messages[0].content).toBe(t.PROMPT);
      expect(b.messages[1].content[1].image_url.url).toBe('data:image/png;base64,'+bytes.toString('base64'));
      expect(b.messages[0].content).not.toContain('Judiment');expect(b.messages[0].content).not.toContain('shift the');}
    expect(r.readers[0]).toMatchObject({outcome:'SUCCESS',reportedCost:.02,returnedModel:env.OCR_ASTRA_MODEL,schemaValid:true});
    expect(r.pair.activeTextExactEqual).toBe(true);expect(r.reconciliation).toMatchObject({dryRun:true,patchApplied:false,mappedStart:484,mappedEnd:517,originalHashMatch:true});
    expect(JSON.stringify(before.page)).toBe(snapshot);expect(r.sourceMutation).toBe(false);
  }finally{read.mockRestore();}
});
test('call failures are never retried and each model is attempted at most once',async()=>{
  const fetchImpl=jest.fn(async()=>{throw Object.assign(Error('private API key body'),{code:'ECONNRESET'});});
  const r=await runPair(prepared(),{env,fetchImpl,allowLive:true});expect(fetchImpl).toHaveBeenCalledTimes(2);expect(r.providerCalls).toBe(2);
  expect(r.readers.every(r=>r.outcome==='TRANSPORT_FAILED')).toBe(true);expect(JSON.stringify(r)).not.toContain('private API key body');
});
test('non-2xx safe status/provider code retained without error bodies or secrets',async()=>{
  const fetchImpl=jest.fn(async()=>response({error:{code:429,message:'secret raw error',metadata:{apiKey:'never-record'}}},429));
  const r=await runPair(prepared(),{env,fetchImpl,allowLive:true});expect(r.readers[0]).toMatchObject({outcome:'HTTP_FAILED',httpStatus:429,providerCode:429});
  expect(JSON.stringify(r)).not.toContain('secret raw error');expect(JSON.stringify(r)).not.toContain('never-record');expect(fetchImpl).toHaveBeenCalledTimes(2);
});
test('returned model mismatch recorded without fallback',async()=>{
  const fetchImpl=jest.fn(async()=>response({model:'other/model',choices:[]}));const r=await runPair(prepared(),{env,fetchImpl,allowLive:true});
  expect(r.readers[0]).toMatchObject({outcome:'MODEL_ID_MISMATCH',returnedModel:'other/model'});expect(fetchImpl).toHaveBeenCalledTimes(2);
});
test.each(['outer-json','inner-json','schema','contract'])('%s failure retains the correct validation outcome and known usage',async kind=>{
  const fetchImpl=jest.fn(async(_url,o)=>{
    if(kind==='outer-json')return response('invalid outer JSON');
    const b=JSON.parse(o.body),value=reading('literal');if(kind==='contract')value.activeTranscript='different';if(kind==='schema')value.extra=true;
    return response({model:b.model,choices:[{finish_reason:'stop',message:{content:kind==='inner-json'?'invalid inner JSON':JSON.stringify(value)}}],usage:{cost:.03,total_tokens:40}});
  });const r=await runPair(prepared(),{env,fetchImpl,allowLive:true});
  expect(r.readers[0].outcome).toBe(kind==='contract'?'SOURCE_CONTRACT_VALIDATION_FAILED':'SCHEMA_VALIDATION_FAILED');
  if(kind!=='outer-json')expect(r.readers[0].reportedCost).toBe(.03);expect(r.readers[0].schemaValid).toBe(false);
});
test('timeout outcome retained, no retries',async()=>{
  jest.useFakeTimers();const fetchImpl=jest.fn((_url,o)=>new Promise((_resolve,reject)=>o.signal.addEventListener('abort',()=>reject(Object.assign(Error('private timeout'),{name:'AbortError'})),{once:true})));
  try{const pending=runPair(prepared(),{env,fetchImpl,allowLive:true});await jest.advanceTimersByTimeAsync(360005);const r=await pending;
    expect(r.readers.map(r=>r.outcome)).toEqual(['TIMEOUT','TIMEOUT']);expect(fetchImpl).toHaveBeenCalledTimes(2);
  }finally{jest.useRealTimers();}
});
test('bad prepared crop dimensions/hash cannot reach transport even with allow-live',async()=>{
  const fetchImpl=successful(),p=prepared();p.crop.bytes=Buffer.from('not verified');
  await expect(runPair(p,{env,fetchImpl,allowLive:true})).rejects.toThrow('SMOKE_CROP_SHA');expect(fetchImpl).not.toHaveBeenCalled();
});
test('stored job/input/region identity mismatch stops local preparation before provider access',async()=>{
  const e={...structuredClone(history),sourceTranscriptExact:history.pages[0].astra.activeTranscript,
    sourceTranscriptSha256:source.sha(history.pages[0].astra.activeTranscript),localFiles:[]};
  for(const field of ['job','input','region']){const value=structuredClone(e);
    if(field==='job')value.ocrJobId='other';if(field==='input')value.pages[0].inputSha256='other';if(field==='region')value.pages[0].targeted.results[7].region.id='other';
    await expect(prepare(value)).rejects.toThrow(/^SMOKE_/);}
});
test('no application pipeline, model persistence, Google call or correction entrypoint belongs to smoke',()=>{
  const code=require('fs').readFileSync(require('path').join(__dirname,'../scripts/targeted-v2-live-smoke.cjs'),'utf8');
  for(const forbidden of ['readPage(','persistEvidence(','updateOne(','findOneAndUpdate(','generateAndPersist(','google()','verify({'])expect(code).not.toContain(forbidden);
  expect(code).toContain('await source.reader(');expect(code).toContain('targeted.reconcile(');
});
