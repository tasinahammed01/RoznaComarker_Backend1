'use strict';
const gateway=require('../src/services/aiGateway.service'),client=require('../src/services/semanticAIClient.service');
const semantic=require('../src/services/semanticWritingCorrections.service'),coordinator=require('../src/services/semanticCorrectionCoordinator.service');
const canonical=require('../src/services/correctionCanonical.service'),wire=require('../src/services/compactCorrectionWire.service');
const {defaultLegend}=require('../src/services/writingCorrections.service');
const {reviewPayload,finding}=require('./helpers/astraAssessmentFixtures.cjs');
const policy=require('../src/services/teacherEvaluationPolicy.service');
const model=process.env.TEST_STRICT_CORRECTION_MODEL||'openai/gpt-5.4-mini',env={OPENROUTER_API_KEY:'mock-only',CORRECTION_DETECTION_MODEL:model,ASSESSMENT_AI_PRIMARY_RETRIES:'0'};
const examples={REL:['My shoe is blue.',''],DEV:['This is useful.',''],TA:['I will not discuss the assigned question.',''],CL:['This thing changes that thing.',''],SD:['Everyone agrees with this claim.',''],
  COH:['The result happened before its cause.',''],CO:['It was raining. Therefore, it was dry.',''],PU:['Trees provide shade. My shoe is blue.',''],TS:['Several unrelated details appear here.',''],CONC:['That is all I know.',''],
  T:['Yesterday I walk home.','Yesterday I walked home.'],VF:['I have went home.','I have gone home.'],AGR:['She go home.','She goes home.'],FRAG:['Because it rained.','We stayed because it rained.'],RO:['It rained we stayed.','It rained, so we stayed.'],WO:['I home went.','I went home.'],ART:['I saw a elephant.','I saw an elephant.'],PREP:['We depend of rain.','We depend on rain.'],
  WC:['The idea tasted loud.','The idea sounded bold.'],WF:['It is a benefit plan.','It is a beneficial plan.'],REP:['The plan is useful useful.','The plan is useful.'],FORM:['The report is kinda good.','The report is somewhat useful.'],COL:['We made attention.','We paid attention.'],SP:['mispell','misspell'],P:['Where is the library.','Where is the library?'],CAP:['i agree.','I agree.'],SPC:['twowords','two words'],FMT:['Item oneItem two','Item one; item two']};
const cases=defaultLegend().groups.flatMap(g=>g.symbols.map(s=>({category:g.key,symbol:s.symbol,...Object.fromEntries([['text',examples[s.symbol][0]],['suggestion',examples[s.symbol][1]]])})));
function payload(hash,findings=[]){const v=reviewPayload(hash,undefined,findings);return {reviewContract:wire.VERSION,transcriptHash:hash,categories:Object.fromEntries(Object.entries(v.categories).map(([k,r])=>[k,{reviewed:true,reviewedSymbols:Object.fromEntries(r.reviewedSymbols.map(symbol=>[symbol,true])),corrections:r.corrections.map(item=>Object.fromEntries(Object.entries(item).filter(([key])=>!['message','stylePreference'].includes(key))))}]))};}
const response=(value,returned=model,status=200)=>({ok:status===200,status,headers:{get:()=>null},text:async()=>JSON.stringify(status===200?{model:returned,choices:[{finish_reason:'stop',message:{content:typeof value==='string'?value:JSON.stringify(value)}}],usage:{prompt_tokens:100,completion_tokens:50,total_tokens:150}}:{error:{message:'private provider details'}})});
async function analyze(text,findings=[],options={}){const fetchImpl=options.fetchImpl||jest.fn(async()=>response(payload('synthetic',findings)));const result=await semantic.analyze({transcript:text,transcriptHash:'synthetic',transcriptComplete:true,disableCategoryAudit:true,...options.input},{env,fetchImpl,...options.dependencies});return {result,fetchImpl};}
beforeAll(()=>jest.spyOn(require('../src/utils/logger'),'info').mockImplementation(()=>{}));
afterAll(()=>jest.restoreAllMocks());
test('exact dedicated model, medium effort, closed schema, private route and usage; scoring and OCR remain separate',async()=>{
  const {result,fetchImpl}=await analyze('mispell',[finding('MECHANICS','SP','mispell',{suggestedText:'misspell'})]);
  const body=JSON.parse(fetchImpl.mock.calls[0][1].body);
  expect(body.model).toBe(model);if(model==='openai/gpt-4.1-mini')expect(body).not.toHaveProperty('reasoning');else expect(body.reasoning).toEqual({effort:'medium'});expect(body.provider).toEqual({require_parameters:true,allow_fallbacks:false});
  expect(body.response_format).toMatchObject({type:'json_schema',json_schema:{strict:true}});expect(body.max_tokens).toBe(8000);
  expect(body).not.toHaveProperty('temperature');expect(body).not.toHaveProperty('models');expect(body).not.toHaveProperty('max_completion_tokens');
  expect(result.model).toBe(model);expect(result.usage).toMatchObject({prompt_tokens:100,completion_tokens:50});expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(client.getAssessmentAIConfig(env).model).toBe('openai/gpt-6-astra');
  expect(require('../src/services/gptVisionExact/contract').config({...env,OCR_GPT_VISION_MODEL:'qwen/qwen3.8-27b'}).model).toBe('qwen/qwen3.8-27b');
});
test.each(cases)('$category/$symbol: exact span, suggestion, explanation and category survive strict GPT54 Mini contract',async f=>{
  const {result,fetchImpl}=await analyze(f.text,[finding(f.category,f.symbol,f.text,{suggestedText:f.suggestion})]);
  expect(fetchImpl).toHaveBeenCalledTimes(1);expect(result.corrections).toHaveLength(1);
  expect(result.corrections[0]).toMatchObject({category:f.category,symbol:f.symbol,quotedText:f.text,startChar:0,endChar:f.text.length});
  expect(result.corrections[0].message).toEqual(expect.any(String));
});
test('golden inventory covers every built-in symbol exactly once',()=>{expect(cases).toHaveLength(28);expect(new Set(cases.map(v=>v.symbol)).size).toBe(28);});
test.each([undefined,'openai/gpt-6-astra','openai/gpt-5.4-mini-20261007'])('missing/wrong/expanded identity %s rejected',async returned=>{
  const fetchImpl=jest.fn(async()=>{const r=response(payload('synthetic'));r.text=async()=>JSON.stringify({model:returned,choices:[{message:{content:JSON.stringify(payload('synthetic'))}}]});return r;});
  await expect(analyze('Correct writing.',[],{fetchImpl})).rejects.toMatchObject({finalFailureCode:'AI_CORRECTION_MODEL_MISMATCH'});expect(fetchImpl).toHaveBeenCalledTimes(1);
});
test.each([
  ()=>'{broken',v=>'```json\n'+JSON.stringify(v)+'\n```',v=>({...v,extra:1}),v=>({...v,categories:{...v.categories,UNKNOWN:{}}}),
  v=>{delete v.categories.CONTENT;return v;},
  v=>{v.categories.MECHANICS.corrections[0].symbol='UNKNOWN';return v;},
  v=>{delete v.categories.MECHANICS.corrections[0].quotedText;return v;},
  v=>{v.categories.MECHANICS.corrections[0].suggestedText=42;return v;},
  v=>{v.categories.MECHANICS.corrections[0].explanation='extra';return v;}
])('malformed/partial/unknown/type/extra correction output fails complete schema',async mutate=>{
  const value=mutate(payload('synthetic',[finding('MECHANICS','SP','mispell',{suggestedText:'misspell'})]));
  await expect(analyze('mispell',[],{fetchImpl:jest.fn(async()=>response(value))})).rejects.toBeDefined();
});
test('correct and informal negative fixtures accept no invented corrections',async()=>{
  for(const text of ['The birds fly home.','Thanks! See you soon.'])expect((await analyze(text)).result.corrections).toHaveLength(0);
});
test.each(['friendly','balanced','strict'])('%s policy propagates and changes cache identity and threshold without changing source',async strictness=>{
  const text='She go home. mispell',inputPolicy={strictness};const {result,fetchImpl}=await analyze(text,[finding('GRAMMAR','AGR','She go home.',{confidence:.85,suggestedText:'She goes home.'}),finding('MECHANICS','SP','mispell',{suggestedText:'misspell'})],{input:{policy:inputPolicy}});
  expect(result.corrections.length).toBe(strictness==='friendly'?1:2);
  expect(JSON.parse(fetchImpl.mock.calls[0][1].body).messages[1].content).toContain(strictness);
  const keys=['friendly','balanced','strict'].map(s=>semantic.semanticSourceKey({correctionSourceHash:'same',config:client.getCorrectionAIConfig(env),policyHash:policy.evaluationPolicyHash({strictness:s})}));
  expect(new Set(keys).size).toBe(3);expect(text).toBe('She go home. mispell');
});
test('model identity separates cache and manual rollback is explicit',()=>{
  const a=client.getCorrectionAIConfig({...env,CORRECTION_DETECTION_MODEL:'openai/gpt-6-astra'}),b=client.getCorrectionAIConfig(env);
  expect(semantic.semanticSourceKey({correctionSourceHash:'same',config:a})).not.toBe(semantic.semanticSourceKey({correctionSourceHash:'same',config:b}));
  expect(a.chain).toHaveLength(1);expect(()=>gateway.getCorrectionAIConfig({...env,CORRECTION_DETECTION_MODEL:'anthropic/*'})).toThrow();
});
test('duplicate and competing spans use the established deterministic merge',async()=>{
  const f=finding('GRAMMAR','AGR','She go',{suggestedText:'She goes'});
  const {result}=await analyze('She go home.',[f,f]);expect(canonical.mergeCanonicalCorrections({aiCorrections:result.corrections}).corrections).toHaveLength(1);
});
test.each([1,2,3,5,12])('%i image/PDF canonical pages preserve repeated occurrence and file/page identity',async count=>{
  const text=Array.from({length:count},()=> 'mispell').join('\n\n');
  const spans=Array.from({length:count},(_,i)=>({start:i*9,end:i*9+7,wordId:'word-'+i,id:'word-'+i,fileId:'file-'+i,page:i+1,text:'mispell'}));
  const {result}=await analyze(text,spans.map((s,i)=>finding('MECHANICS','SP','mispell',{occurrence:i,suggestedText:'misspell'})),{input:{spans}});
  expect(result.corrections).toHaveLength(count);expect(result.corrections.map(v=>v.startChar)).toEqual(spans.map(s=>s.start));
  expect(new Set(result.corrections.map(v=>v.id)).size).toBe(count);
  result.corrections.forEach((c,i)=>{expect(c.fileId).toBe('file-'+i);expect(c.page).toBe(i+1);expect(c.wordIds).toEqual(['word-'+i]);});
});
test('a localized quote cannot attach across two pages of the same PDF',()=>{
  const spans=[{start:0,end:3,fileId:'pdf',page:1,wordId:'one'},{start:5,end:8,fileId:'pdf',page:2,wordId:'two'}];
  expect(canonical.mapOffsetsToWords({startChar:0,endChar:8},spans)).toBeNull();
});
test('long chunking covers all characters with bounded chunks and original ordering',()=>{
  const text='A controlled sentence. '.repeat(20000),chunks=coordinator.buildChunks(text,[],coordinator.config({}));
  expect(chunks.length).toBeLessThanOrEqual(12);let end=0;for(const c of chunks){expect(c.startChar).toBeLessThanOrEqual(end);expect(c.text).toBe(text.slice(c.startChar,c.endChar));end=c.endChar;}expect(end).toBe(text.length);
});
test.each([401,402,403,429,503])('HTTP %i remains a bounded failure without fallback',async status=>{
  const fetchImpl=jest.fn(async()=>response(null,model,status));await expect(analyze('Correct.',[],{fetchImpl})).rejects.toBeDefined();expect(fetchImpl).toHaveBeenCalledTimes(1);
});
test.each([1,10,25,50,64])('%i concurrent mocked jobs are isolated and provider concurrency stays at four',async count=>{
  let active=0,peak=0;const jobs=Array.from({length:count},(_,i)=>async()=>{
    const fetchImpl=async(_url,options)=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,2));active--;const body=JSON.parse(options.body);return response({job:body.messages[0].content});};
    const result=await gateway.providerAttempt({feature:'semantic_corrections',entry:{provider:'openrouter',model},messages:[{role:'user',content:String(i)}],responseFormat:'json',responseSchema:{type:'object',additionalProperties:false,properties:{job:{type:'string'}},required:['job']},maxOutputTokens:1000,attemptTimeoutMs:5000,env,fetchImpl,now:Date.now});
    expect(JSON.parse(result.content)).toEqual({job:String(i)});
  });await Promise.all(jobs.map(job=>job()));expect(peak).toBeLessThanOrEqual(4);expect(require('../src/services/correctionAdmission.service').shared.snapshot()).toMatchObject({active:0,queued:0});
});
test('finite backpressure, cancellation and failures release all admission state',async()=>{
  const gate=require('../src/services/correctionAdmission.service').createAdmission({limit:1,queueLimit:1});const release=await gate.acquire(1000);const controller=new AbortController();const waiting=gate.acquire(1000,controller.signal);await expect(gate.acquire(1000)).rejects.toMatchObject({code:'AI_PROVIDER_UNAVAILABLE'});controller.abort();await expect(waiting).rejects.toBeDefined();release();expect(gate.snapshot()).toMatchObject({active:0,queued:0});
});
test('100 arrivals have finite admission: four active, 64 queued, excess fails safely',async()=>{
  let calls=0,active=0,peak=0;
  const fetchImpl=async()=>{calls++;active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,2));active--;return response('{}');};
  const results=await Promise.allSettled(Array.from({length:100},()=>gateway.providerAttempt({feature:'semantic_corrections',entry:{provider:'openrouter',model},messages:[],responseFormat:'json',responseSchema:{type:'object'},maxOutputTokens:1000,attemptTimeoutMs:5000,env,fetchImpl,now:Date.now})));
  expect(calls).toBe(68);expect(peak).toBe(4);expect(results.filter(r=>r.status==='rejected')).toHaveLength(32);
  results.filter(r=>r.status==='rejected').forEach(r=>expect(r.reason.code).toBe('AI_PROVIDER_UNAVAILABLE'));
  expect(require('../src/services/correctionAdmission.service').shared.snapshot()).toMatchObject({active:0,queued:0});
});
test('timeout releases transport and Qwen/scoring do not acquire correction slots',async()=>{
  await expect(gateway.providerAttempt({feature:'semantic_corrections',entry:{provider:'openrouter',model},messages:[],responseFormat:'json',responseSchema:{type:'object'},maxOutputTokens:1000,attemptTimeoutMs:10,env,fetchImpl:()=>new Promise(()=>{}),now:Date.now})).rejects.toMatchObject({code:'AI_ATTEMPT_TIMEOUT'});
  expect(require('../src/services/correctionAdmission.service').shared.snapshot().active).toBe(0);
  const spy=jest.spyOn(require('../src/services/correctionAdmission.service').shared,'acquire');
  for(const [feature,m] of [['semantic_rubric_assessment','openai/gpt-6-astra'],['gpt_vision_exact','qwen/qwen3.8-27b']])await gateway.providerAttempt({feature,entry:{provider:'openrouter',model:m},messages:[],maxOutputTokens:100,attemptTimeoutMs:1000,env,fetchImpl:async()=>response('{}',m),now:Date.now});
  expect(spy).not.toHaveBeenCalled();spy.mockRestore();
});
test('one configured transient retry stays on GPT54 Mini with bounded calls',async()=>{
  const fetchImpl=jest.fn().mockResolvedValueOnce(response(null,model,429)).mockResolvedValueOnce(response(payload('synthetic')));
  const config={...client.getCorrectionAIConfig(env),primaryRetries:1,retryDelayMs:0};
  const {result}=await analyze('A correct sentence.',[],{fetchImpl,dependencies:{config,sleepFn:async()=>{}}});
  expect(result.corrections).toEqual([]);expect(fetchImpl).toHaveBeenCalledTimes(2);
  for(const [,options] of fetchImpl.mock.calls)expect(JSON.parse(options.body).model).toBe(model);
});
test('teacher comment uses correction authority without invoking rubric evaluation',async()=>{
  const previous=process.env.CORRECTION_DETECTION_MODEL;process.env.CORRECTION_DETECTION_MODEL=model;process.env.OPENROUTER_API_KEY='mock-only';
  const comment='You present a clear idea and support it with examples. Keep developing your explanations so each point connects naturally to the next.';
  const fetchMock=jest.spyOn(global,'fetch').mockImplementation(async()=>response({comment},gateway.CLAUDE_CORRECTION_MODEL));
  try{expect(await require('../src/services/teacherComments.service').generateTeacherCommentDraft({rubricScores:{CONTENT:{comment:'A clear idea supported with examples.'}}},'synthetic')).toEqual({comment});
    const body=JSON.parse(fetchMock.mock.calls[0][1].body);expect(body.model).toBe(gateway.CLAUDE_CORRECTION_MODEL);expect(body.reasoning).toEqual({effort:'none'});expect(body.max_tokens).toBe(240);expect(fetchMock).toHaveBeenCalledTimes(1);
  }finally{fetchMock.mockRestore();if(previous===undefined)delete process.env.CORRECTION_DETECTION_MODEL;else process.env.CORRECTION_DETECTION_MODEL=previous;}
});
test('oversized single input fails before transport rather than truncating source',async()=>{
  const fetchImpl=jest.fn();await expect(analyze('word '.repeat(100000),[],{fetchImpl})).rejects.toMatchObject({code:'SEMANTIC_INPUT_LIMIT'});expect(fetchImpl).not.toHaveBeenCalled();
});
test.each(['friendly','balanced','strict'])('mixed 28-symbol essay retains all categories under %s with disjoint source spans',async strictness=>{
  const ordered=[...cases.filter(c=>c.symbol!=='CONC'),cases.find(c=>c.symbol==='CONC')];
  const text=ordered.map(c=>c.text).join('\n\n');
  const findings=ordered.map(c=>finding(c.category,c.symbol,c.text,{suggestedText:c.suggestion}));
  const {result}=await analyze(text,findings,{input:{policy:{strictness}}});
  const merged=canonical.mergeCanonicalCorrections({aiCorrections:result.corrections}).corrections;
  expect(merged).toHaveLength(28);expect(new Set(merged.map(c=>c.symbol))).toEqual(new Set(cases.map(c=>c.symbol)));
  merged.forEach(c=>expect(text.slice(c.startChar,c.endChar)).toBe(c.quotedText));
});
test.each([1,3,12])('%i PDF pages retain distinct occurrences under a shared file ID',async count=>{
  const text=Array.from({length:count},()=> 'mispell').join('\n\n');
  const spans=Array.from({length:count},(_,i)=>({start:i*9,end:i*9+7,wordId:'word-'+i,fileId:'pdf',page:i+1}));
  const {result}=await analyze(text,spans.map((s,i)=>finding('MECHANICS','SP','mispell',{occurrence:i,suggestedText:'misspell'})),{input:{spans}});
  const corrections=canonical.mergeCanonicalCorrections({aiCorrections:result.corrections}).corrections;
  expect(corrections).toHaveLength(count);expect(corrections.map(c=>c.page)).toEqual(spans.map(s=>s.page));
});
test.each([1,2,3,5,12])('%i page coordinator uses bounded existing passes and retains complete source coverage',async count=>{
  let offset=0;const pages=Array.from({length:count},(_,i)=>{const text=('A clear controlled sentence '+i+'. ').repeat(3+i);const startChar=offset;offset+=text.length+2;return {fileId:'f'+i,pageNumber:1,startChar,endChar:offset-2,text};});
  const transcript=pages.map(p=>p.text).join('\n\n');
  const fetchImpl=jest.fn(async(_url,options)=>{const body=JSON.parse(options.body),schema=body.response_format.json_schema.schema;
    const categories=Object.fromEntries(Object.entries(schema.properties.categories.properties).map(([category,r])=>[category,{reviewed:true,reviewedSymbols:Object.fromEntries(r.properties.reviewedSymbols.required.map(symbol=>[symbol,true])),corrections:[]} ]));
    return response({reviewContract:wire.VERSION,transcriptHash:schema.properties.transcriptHash.const,categories});
  });
  const result=await coordinator.analyze({transcript,transcriptHash:'pages',transcriptComplete:true,pageManifest:pages},{env,fetchImpl});
  expect(result.coverage.coveredCharacters).toBe(transcript.length);expect(result.coverage.complete).toBe(true);expect(result.corrections).toEqual([]);
  expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(14);expect(result.metrics.providerCallCount).toBe(fetchImpl.mock.calls.length);
  if(count===1)expect(fetchImpl).toHaveBeenCalledTimes(1);
});
