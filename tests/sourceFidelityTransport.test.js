'use strict';
const gateway=require('../src/services/aiGateway.service');
const options=()=>({entry:{provider:'openrouter',model:'openai/gpt-6-astra'},messages:[{role:'system',content:'forensic'}],
  maxOutputTokens:12000,temperature:0,responseFormat:'json',responseSchema:{type:'object'},schemaName:'source',
  attemptTimeoutMs:1000,env:{OPENROUTER_API_KEY:'not-a-real-key'},now:Date.now,requestProfile:'source_fidelity_v1'});
const response=model=>({ok:true,status:200,text:async()=>JSON.stringify({model,choices:[{finish_reason:'stop',message:{content:'{}'}}],usage:{total_tokens:1}})});
test('source profile has only proven wire keys and strict routing; exact returned model',async()=>{
  const fetchImpl=jest.fn(async()=>response('openai/gpt-6-astra'));
  const result=await gateway.providerAttempt({...options(),fetchImpl});
  const body=JSON.parse(fetchImpl.mock.calls[0][1].body);
  expect(Object.keys(body).sort()).toEqual(['model','messages','max_completion_tokens','response_format','provider'].sort());
  expect(body.max_completion_tokens).toBe(12000);expect(body.provider).toEqual({require_parameters:true,allow_fallbacks:false});
  expect(result.returnedModel).toBe('openai/gpt-6-astra');expect(fetchImpl).toHaveBeenCalledTimes(1);
});
test('generic assessment body remains unchanged without profile',async()=>{
  const o=options();delete o.requestProfile;o.entry.model='openai/gpt-4.1';o.maxOutputTokens=123;o.temperature=0.1;
  const fetchImpl=jest.fn(async()=>response('openai/gpt-4.1'));await gateway.providerAttempt({...o,fetchImpl});
  const b=JSON.parse(fetchImpl.mock.calls[0][1].body);expect(b.max_tokens).toBe(123);expect(b.temperature).toBe(0.1);
  expect(b).not.toHaveProperty('provider');expect(b).not.toHaveProperty('max_completion_tokens');
});
test('wrong/missing returned model and unsupported endpoints fail closed, no fallback',async()=>{
  for(const model of ['wrong',undefined])await expect(gateway.providerAttempt({...options(),fetchImpl:async()=>response(model)})).rejects.toMatchObject({code:'OCR_SOURCE_MODEL_IDENTITY'});
  const fetchImpl=jest.fn();await expect(gateway.providerAttempt({...options(),env:{...options().env,OPENROUTER_BASE_URL:'https://other.invalid'},fetchImpl})).rejects.toThrow();
  expect(fetchImpl).not.toHaveBeenCalled();
});
test('cancellation reaches in-flight body read and prevents late success',async()=>{
  const c=new AbortController();
  const fetchImpl=jest.fn(async(_u,o)=>({ok:true,status:200,text:()=>new Promise((_resolve,reject)=>o.signal.addEventListener('abort',()=>reject(Object.assign(Error(),{name:'AbortError'}))))}));
  const p=gateway.providerAttempt({...options(),signal:c.signal,fetchImpl});await Promise.resolve();c.abort();await expect(p).rejects.toThrow();
});
