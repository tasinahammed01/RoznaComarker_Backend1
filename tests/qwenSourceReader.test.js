'use strict';
const c=require('../src/services/gptVisionExact/contract');
const source=require('../src/services/gptVisionExact.service');
const gateway=require('../src/services/aiGateway.service');
const model='qwen/qwen3.8-27b';
const env={NODE_ENV:'test',OCR_SOURCE_MODE:'gpt_vision_exact',OCR_GPT_VISION_MODEL:model,OPENROUTER_API_KEY:'mock-only',
  AI_PRIMARY_PROVIDER:'openrouter',AI_PRIMARY_MODEL:'openai/gpt-4.1-mini',AI_FALLBACK_1_PROVIDER:'openrouter',AI_FALLBACK_1_MODEL:'openai/gpt-6-astra'};
const segment=(text,classification='STUDENT_ACTIVE_TEXT')=>({text,classification,confidence:1});
const fixture=()=>({version:c.VERSION,activeTranscript:'Society always expect powerfull wrong wrong ,\nSay naïve — বাংলা  unfinished',
  physicalLines:[{segments:[segment('Question?','PROMPT_OR_INSTRUCTION')]},
    {segments:[segment('Society always expect '),segment(null,'STUDENT_CROSSED_OUT'),segment('powerfull wrong wrong ,')]},
    {segments:[segment('Say naïve — বাংলা  unfinished')]}],uncertainties:[]});
const wireFixture=()=>{const {activeTranscript,...v}=fixture();return {...v,version:c.QWEN_WIRE_VERSION};};
function response(content=JSON.stringify(wireFixture()),returnedModel=model){return {ok:true,status:200,text:async()=>JSON.stringify({model:returnedModel,
  choices:[{finish_reason:'stop',message:{content}}],usage:{prompt_tokens:123,completion_tokens:45,cost:.0001}})};}
function options(fetchImpl=jest.fn(async()=>response())){
  const reservation={acquire:jest.fn(async()=>({_id:'source',cached:false})),complete:jest.fn(async()=>{})};
  return {bytes:Buffer.from([255,216,255]),mimeType:'image/jpeg',identity:{submissionId:'s',fileId:'f',pageNumber:1,sourceSha256:c.sha('crop')},
    assignment:{instructions:'Reference only'},env,reservation,read:args=>source.reader({...args,fetchImpl}),fetchImpl};
}
test.each([model,'openai/gpt-6-astra','openai/gpt-5.6-sol'])('explicit approved source model %s resolves safely',approved=>{
  expect(c.config({...env,OCR_GPT_VISION_MODEL:approved})).toEqual({model:approved});
});
test.each(['qwen/deepseek-v3.2','qwen/deepseek-v4.1-flash','qwen/unknown','qwen/*','openai/not-approved','anthropic/claude-fable-5.1'])('unknown or unapproved model %s fails before transport',async rejected=>{
  expect(()=>c.config({...env,OCR_GPT_VISION_MODEL:rejected})).toThrow('OCR_GPT_SOURCE_CONFIGURATION_INVALID');
  const fetchImpl=jest.fn();await expect(source.reader({model:rejected,bytes:Buffer.from([255,216,255]),mimeType:'image/jpeg',prompt:c.PROMPT,
    assignmentReference:{},env,fetchImpl})).rejects.toMatchObject({code:'OCR_SOURCE_PROFILE_INVALID'});expect(fetchImpl).not.toHaveBeenCalled();
});
test('Qwen uses the existing private endpoint, closed schema and one supported token-limit field without fallback/sampling',async()=>{
  const o=options();const result=await source.readPage(o);
  expect(o.fetchImpl).toHaveBeenCalledTimes(1);const [url,request]=o.fetchImpl.mock.calls[0],body=JSON.parse(request.body);
  expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');expect(request.redirect).toBe('error');
  expect(body.model).toBe(model);expect(body.max_tokens).toBe(16000);expect(body).not.toHaveProperty('max_completion_tokens');
  expect(body.provider).toEqual({require_parameters:true,allow_fallbacks:false,sort:'latency'});
  expect(body.reasoning).toEqual({effort:'none'});
  expect(body.response_format).toEqual({type:'json_schema',json_schema:{name:'qwen_physical_source_v1',strict:true,schema:c.wireContract(model).schema}});
  expect(body.messages[0].content).toBe(c.wireContract(model).prompt);expect(body.messages[1].content[1].image_url.url).toBe('data:image/jpeg;base64,/9j/');
  for(const key of ['temperature','top_p','seed','models','transforms'])expect(body).not.toHaveProperty(key);
  expect(result.fullText).toBe(fixture().activeTranscript);expect(result.source.sourcePrimaryModel).toBe(model);
  expect(result.source.sourcePrimaryProvider).toBe('openrouter');expect(o.reservation.complete).toHaveBeenCalledTimes(1);
});
test.each(['openai/gpt-6-astra','qwen/deepseek-v4.1-flash-20261017','deepseek-flash','qwen/other',undefined])('wrong or missing returned identity %s is rejected exactly',async identity=>{
  const fetchImpl=jest.fn(async()=>({ok:true,status:200,text:async()=>JSON.stringify({model:identity,choices:[{message:{content:JSON.stringify(fixture())}}]})}));
  const o=options(fetchImpl);await expect(source.readPage(o)).rejects.toMatchObject({code:'OCR_SOURCE_MODEL_IDENTITY'});
  expect(fetchImpl).toHaveBeenCalledTimes(1);expect(o.reservation.complete.mock.calls[0][1].status).toBe('GPT_SOURCE_FAILED');
});
test.each([
  ['malformed',()=>'{invalid','OCR_GPT_SOURCE_SCHEMA'],
  ['missing',v=>{delete v.physicalLines;return JSON.stringify(v);},'OCR_GPT_SOURCE_SCHEMA'],
  ['extra',v=>JSON.stringify({...v,grade:100}),'OCR_GPT_SOURCE_SCHEMA'],
  ['enum',v=>{v.physicalLines[1].segments[0].classification='FIXED_TEXT';return JSON.stringify(v);},'OCR_GPT_SOURCE_SCHEMA'],
  ['rewrite',v=>JSON.stringify({...v,activeTranscript:'Society always expects powerful words.'}),'OCR_GPT_SOURCE_SCHEMA'],
  ['uncertain',v=>{v.physicalLines[1].segments.push(segment(null,'UNCERTAIN'));return JSON.stringify(v);},'OCR_GPT_SOURCE_UNCERTAIN']
])('HTTP 200 with %s source fails the unchanged validator',async(_name,content,code)=>{
  const o=options(jest.fn(async()=>response(content(wireFixture()))));await expect(source.readPage(o)).rejects.toMatchObject({code});
  expect(o.fetchImpl).toHaveBeenCalledTimes(1);expect(o.reservation.complete.mock.calls[0][1].status).toBe('GPT_SOURCE_FAILED');
});
test.each([[401,'OCR_GPT_PROVIDER_AUTH'],[402,'OCR_GPT_PROVIDER_PAYMENT_REQUIRED'],[403,'OCR_GPT_PROVIDER_ACCESS'],
  [429,'OCR_GPT_PROVIDER_RATE_LIMIT'],[503,'OCR_GPT_PROVIDER_NETWORK']])('HTTP %i remains a safe service failure without fallback',async(status,code)=>{
  const o=options(jest.fn(async()=>({ok:false,status,text:async()=>JSON.stringify({error:{message:'PRIVATE BILLING IMAGE TEXT'}})})));
  await expect(source.readPage(o)).rejects.toMatchObject({code});expect(o.fetchImpl).toHaveBeenCalledTimes(1);
  const state=require('../src/services/gptVisionExact/preflight').ui({code});expect(state).toMatchObject({sourceReadStatus:'FAILED_SERVICE',canSubmit:false});
  expect(JSON.stringify(o.reservation.complete.mock.calls)).not.toMatch(/PRIVATE BILLING IMAGE TEXT/);
});
test.each([Object.assign(Error('private'),{name:'AbortError'}),Object.assign(Error('private'),{code:'ECONNRESET'})])('network/timeout fails safely without another model',async error=>{
  const o=options(jest.fn(async()=>{throw error;}));await expect(source.readPage(o)).rejects.toMatchObject({code:expect.stringMatching(/^OCR_GPT_PROVIDER_/)});
  expect(o.fetchImpl).toHaveBeenCalledTimes(1);expect(JSON.stringify(o.reservation.complete.mock.calls)).not.toContain('private');
});
test('safe startup diagnostics resolve explicit Qwen without changing assessment or global chains',()=>{
  const startup=require('../src/config/ocr').validateOcrConfiguration(env);
  expect(startup).toMatchObject({mode:'gpt_vision_exact',gptVisionModel:model,openrouterConfigured:true,sourceCallsPerPage:1});
  expect(JSON.stringify(startup)).not.toContain('mock-only');
  expect(gateway.getAssessmentAIConfig(env).chain.map(v=>v.model)).toEqual(['google/gemini-3.8-flash']);
  expect(gateway.getAIConfig(env).chain.map(v=>v.model)).toEqual(['openai/gpt-4.1-mini','openai/gpt-6-astra']);
});
test('usage stays provider-reported; exact accepted source is reused without a second request',async()=>{
  const o=options();const output=await source.reader({model,bytes:o.bytes,mimeType:o.mimeType,prompt:c.PROMPT,assignmentReference:{},env,fetchImpl:o.fetchImpl});
  expect(output.usage).toMatchObject({prompt_tokens:123,completion_tokens:45,cost:.0001});
  o.fetchImpl.mockClear();o.reservation.acquire.mockResolvedValue({_id:'source',cached:true,evidence:{payload:{primary:fixture()}}});
  expect((await source.readPage(o)).fullText).toBe(fixture().activeTranscript);expect(o.fetchImpl).not.toHaveBeenCalled();
});

test.each(['deepseek/deepseek-v4.1-flash-1017','openai/gpt-6-astra'])('accepted %s proof cannot authorize Qwen upload',async previous=>{
  const preflight=require('../src/services/gptVisionExact/preflight');
  const context={ownerId:'student',uploaderId:'student',assignment:{_id:'assignment'}};
  const page={bytes:Buffer.from('crop A'),sourceSha256:c.sha('crop A'),pageNumber:1};
  const old=preflight.binding(context,page,{...env,OCR_GPT_VISION_MODEL:previous});
  const current=preflight.binding(context,page,env);
  expect(old.key).not.toBe(current.key);
  const file={uploadedBy:'student',gptSourcePreflight:{ownerId:'student',uploaderId:'student',assignmentId:'assignment',bindings:[old]}};
  await expect(preflight.claimReservation(file,{assignmentId:'assignment',studentId:'student'}).acquire(current))
    .rejects.toMatchObject({code:'OCR_GPT_SOURCE_PREFLIGHT_REQUIRED'});
});
test('original and two crops have isolated Qwen evidence identities',()=>{
  const preflight=require('../src/services/gptVisionExact/preflight'),context={ownerId:'s',assignment:{_id:'a'}};
  const keys=['original','crop A','crop B'].map(text=>preflight.binding(context,{bytes:Buffer.from(text),sourceSha256:c.sha(text),pageNumber:1},env).key);
  expect(new Set(keys).size).toBe(3);
});

test('request observation marks actual Qwen fetch and cache reuse separately, without affecting calls',async()=>{
  const o=options(),events=[];await source.readPage({...o,onObservation:value=>events.push(value)});
  expect(o.fetchImpl).toHaveBeenCalledTimes(1);expect(events).toContainEqual({qwenInvoked:true});
  expect(events).toContainEqual({cacheUsed:false,stage:'provider_request'});
  events.length=0;o.fetchImpl.mockClear();o.reservation.acquire.mockResolvedValue({_id:'source',cached:true,evidence:{payload:{primary:fixture()}}});
  await source.readPage({...o,onObservation:value=>events.push(value)});
  expect(o.fetchImpl).not.toHaveBeenCalled();expect(events).toContainEqual({cacheUsed:true,stage:'cache_validation'});
  expect(events.some(e=>e.qwenInvoked===true)).toBe(false);
});
test('throwing request observer cannot change source acceptance or buy another call',async()=>{
  const o=options();expect((await source.readPage({...o,onObservation:()=>{throw Error('observer');}})).fullText).toBe(fixture().activeTranscript);
  expect(o.fetchImpl).toHaveBeenCalledTimes(1);
});
test('invalid cached source is diagnosed as cache validation without invoking Qwen',async()=>{
  const o=options(),events=[];
  o.reservation.acquire.mockResolvedValue({_id:'source',cached:true,evidence:{payload:{primary:{...fixture(),activeTranscript:'invalid'}}}});
  await expect(source.readPage({...o,onObservation:value=>events.push(value)})).rejects.toMatchObject({code:'OCR_GPT_SOURCE_TRANSCRIPT_MISMATCH'});
  expect(o.fetchImpl).not.toHaveBeenCalled();expect(o.reservation.complete).not.toHaveBeenCalled();
  expect(events).toContainEqual(expect.objectContaining({validationStage:'CACHE_VALIDATION'}));
  expect(events.some(e=>e.qwenInvoked===true)).toBe(false);
});
test.each([
  v=>{v.physicalLines[1].segments[0].confidence='1';},
  v=>{v.uncertainties=[{lineIndex:299,segmentIndex:0,kind:'NON_ACTIVE_DELETED_UNCERTAIN',reason:'synthetic'}];}
])('invalid type/reference remains blocking with safe schema diagnostics',async mutate=>{
  const value=wireFixture();mutate(value);const o=options(jest.fn(async()=>response(JSON.stringify(value))));
  await expect(source.readPage(o)).rejects.toMatchObject({code:'OCR_GPT_SOURCE_SCHEMA',sourceDiagnostic:{schemaErrorKeyword:expect.any(String)}});
  expect(o.reservation.complete.mock.calls[0][1].status).toBe('GPT_SOURCE_FAILED');
});
