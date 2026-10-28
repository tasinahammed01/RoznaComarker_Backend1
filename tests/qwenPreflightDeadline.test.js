'use strict';
const c=require('../src/services/gptVisionExact/contract');
const source=require('../src/services/gptVisionExact.service');
const model=c.QWEN_MODEL,env={NODE_ENV:'test',OCR_GPT_VISION_MODEL:model,OPENROUTER_API_KEY:'offline-only'};
const value={version:c.VERSION,activeTranscript:'wrong wrong ,\nunfinished',physicalLines:['wrong wrong ,','unfinished'].map(text=>({segments:[{classification:'STUDENT_ACTIVE_TEXT',text,confidence:1}]})),uncertainties:[]};
const payload={model,choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}],usage:{prompt_tokens:100,completion_tokens:50,total_tokens:150,completion_tokens_details:{reasoning_tokens:0}}};
const response=()=>({ok:true,status:200,text:async()=>JSON.stringify(payload)});
function options(fetchImpl){return {model,bytes:Buffer.from([255,216,255]),mimeType:'image/jpeg',prompt:c.PROMPT,assignmentReference:{},env,fetchImpl,onDiagnostic:jest.fn()};}
beforeEach(()=>jest.useFakeTimers());
afterEach(()=>{jest.useRealTimers();jest.restoreAllMocks();});

test('bounded configuration retains full-page output and permits valid 90-second reads',async()=>{
  expect(c.requestPolicy(env)).toEqual({attemptTimeoutMs:120000,maxOutputTokens:16000});
  for(const ms of [100000,180000])expect(c.requestPolicy({...env,OCR_GPT_VISION_ATTEMPT_TIMEOUT_MS:String(ms)}).attemptTimeoutMs).toBe(ms);
  for(const ms of ['NaN','99999','180001','Infinity','120000.5'])expect(()=>c.config({...env,OCR_GPT_VISION_ATTEMPT_TIMEOUT_MS:ms})).toThrow('CONFIGURATION_INVALID');
  const fetchImpl=jest.fn(()=>new Promise(resolve=>setTimeout(()=>resolve(response()),90000))),o=options(fetchImpl);
  const pending=source.reader(o);await jest.advanceTimersByTimeAsync(90000);
  const result=await pending;expect(c.validate(result.content)).toEqual(value);
  expect(result.transportTimings).toEqual({requestToHeadersMs:90000,responseBodyMs:0});
  expect(result.usage.thoughts_tokens).toBe(0);expect(fetchImpl).toHaveBeenCalledTimes(1);expect(jest.getTimerCount()).toBe(0);
});

test.each(['connection_or_headers','body'])('exact deadline aborts actual transport and safely locates %s stall',async phase=>{
  let transportSignal,aborted=false;
  const fetchImpl=jest.fn(async(url,request)=>{transportSignal=request.signal;request.signal.addEventListener('abort',()=>{aborted=true;});
    return phase==='body'?{ok:true,status:200,text:()=>new Promise(()=>{})}:new Promise(()=>{});});
  const o=options(fetchImpl),pending=source.reader(o);let settled=false;
  const checked=expect(pending.finally(()=>{settled=true;})).rejects.toMatchObject({code:'AI_ATTEMPT_TIMEOUT',timeoutOrigin:'local_attempt_timeout'});
  await jest.advanceTimersByTimeAsync(119999);expect(settled).toBe(false);expect(aborted).toBe(false);
  await jest.advanceTimersByTimeAsync(1);await checked;
  expect(transportSignal.aborted).toBe(true);expect(aborted).toBe(true);expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(o.onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({failureStage:'REQUEST_ABORTED',
    transportPhase:phase==='body'?'RESPONSE_BODY_READ_FAILURE':'TRANSPORT_FAILURE',elapsedMs:120000,attemptTimeoutMs:120000,
    responseReceived:phase==='body',bodyRead:false,...(phase==='body'?{httpStatus:200,responseBodyMs:120000}:{httpStatus:null})}));
  expect(jest.getTimerCount()).toBe(0);
});

test('header latency and body duration remain distinct on body failure after HTTP 200',async()=>{
  const fetchImpl=jest.fn(()=>new Promise(resolve=>setTimeout(()=>resolve({ok:true,status:200,text:()=>new Promise((_,reject)=>setTimeout(()=>reject(Object.assign(Error('PRIVATE'),{code:'ECONNRESET'})),5000))}),2000)));
  const o=options(fetchImpl),checked=expect(source.reader(o)).rejects.toMatchObject({code:'ECONNRESET'});
  await jest.advanceTimersByTimeAsync(7000);await checked;
  expect(o.onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({transportPhase:'RESPONSE_BODY_READ_FAILURE',httpStatus:200,
    requestToHeadersMs:2000,responseBodyMs:5000,elapsedMs:7000,internalCauseCode:'ECONNRESET'}));
  expect(JSON.stringify(o.onDiagnostic.mock.calls)).not.toContain('PRIVATE');
});

test.each(['source_user_cancelled','source_preflight_deadline'])('caller signal %s aborts provider immediately and clears deadline',async reason=>{
  const controller=new AbortController(),fetchImpl=jest.fn(async()=>new Promise(()=>{})),o={...options(fetchImpl),signal:controller.signal};
  const checked=expect(source.reader(o)).rejects.toMatchObject({code:'AI_ATTEMPT_TIMEOUT',timeoutOrigin:reason==='source_preflight_deadline'?reason:'caller_cancelled'});
  await jest.advanceTimersByTimeAsync(20);controller.abort(reason);await checked;
  expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);expect(jest.getTimerCount()).toBe(0);
});

test('unsupported reasoning/schema capability fails closed on HTTP 400 without model, fallback or retry',async()=>{
  const fetchImpl=jest.fn(async()=>({ok:false,status:400,text:async()=>JSON.stringify({error:{code:400,message:'Parameter unsupported'}})})),o=options(fetchImpl);
  await expect(source.reader(o)).rejects.toMatchObject({status:400});
  expect(fetchImpl).toHaveBeenCalledTimes(1);expect(o.onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({transportPhase:'HTTP_ERROR_RESPONSE',httpStatus:400}));
  const body=JSON.parse(fetchImpl.mock.calls[0][1].body);expect(body.reasoning.effort).toBe('none');expect(body.provider).toEqual({require_parameters:true,allow_fallbacks:false,sort:'latency'});
  expect(body.response_format.json_schema).toMatchObject({strict:true,schema:c.schema});
});

test('HTTP 200 provider error is classified before identity validation',async()=>{
  const o=options(jest.fn(async()=>({ok:true,status:200,text:async()=>JSON.stringify({error:{code:503,message:'PRIVATE'}})})));
  await expect(source.reader(o)).rejects.toMatchObject({code:'AI_PROVIDER_UNAVAILABLE',status:503});
  expect(o.onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({httpStatus:200,transportPhase:'HTTP_ERROR_RESPONSE'}));
});

test('truncation remains rejected; safe token diagnostics survive without retaining output',async()=>{
  const truncated={...payload,choices:[{finish_reason:'length',message:{content:'PRIVATE'}}]};
  const o=options(jest.fn(async()=>({ok:true,status:200,text:async()=>JSON.stringify(truncated)})));
  await expect(source.reader(o)).rejects.toMatchObject({code:'AI_RESPONSE_TRUNCATED'});
  expect(o.onDiagnostic.mock.calls[0][0].usage).toEqual({prompt_tokens:100,completion_tokens:50,total_tokens:150,thoughts_tokens:0});
  expect(JSON.stringify(o.onDiagnostic.mock.calls)).not.toContain('PRIVATE');
});

test('real timeout saves retryable failure only, never accepted evidence or geometry',async()=>{
  const logger=jest.spyOn(require('../src/utils/logger'),'info').mockImplementation(()=>{}),fetchImpl=jest.fn(()=>new Promise(()=>{}));
  const reservation={acquire:jest.fn(async()=>({_id:'test',cached:false})),complete:jest.fn(async()=>{})},google=jest.fn();
  const o=options(fetchImpl),checked=expect(source.readPage({...o,identity:{fileId:'file',pageNumber:1,sourceSha256:c.sha('synthetic')},reservation,google,
    read:args=>source.reader({...args,fetchImpl})})).rejects.toMatchObject({code:'OCR_GPT_PROVIDER_NETWORK'});
  await jest.advanceTimersByTimeAsync(120000);await checked;
  expect(reservation.complete).toHaveBeenCalledWith('test',expect.objectContaining({status:'GPT_SOURCE_FAILED',payload:expect.objectContaining({safeFailureCode:'OCR_GPT_PROVIDER_NETWORK',transportPhase:'TRANSPORT_FAILURE',elapsedMs:120000,timeoutOrigin:'local_attempt_timeout'})}));
  expect(google).not.toHaveBeenCalled();expect(require('../src/services/sourceVerificationPolicy').classify('OCR_GPT_PROVIDER_NETWORK')).toBe('retryable');
  expect(JSON.stringify(logger.mock.calls)).not.toMatch(/offline-only|base64|wrong wrong/);
});

test.each(['ECONNRESET','ENOTFOUND','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET'])('native fetch cause %s stays retryable and never becomes an image failure',code=>{
  const error=new TypeError('private provider error',{cause:Object.assign(Error('private'),{code})});
  const failure=source.failureCode(error);expect(failure).toBe('OCR_GPT_PROVIDER_NETWORK');
  expect(require('../src/services/sourceVerificationPolicy').classify(failure)).toBe('retryable');
  expect(require('../src/services/gptVisionExact/preflight').ui({code:failure})).toMatchObject({sourceReadStatus:'FAILED_SERVICE',canSubmit:false});
});
