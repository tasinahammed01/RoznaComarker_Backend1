'use strict';
const {acquire,complete}=require('../src/services/gptVisionExact/attempt');
const c=require('../src/services/gptVisionExact/contract');
const identity={submissionId:'s',runId:'job1',fileId:'f',pageNumber:1,inputSha256:c.sha('pixels'),sourceSha256:c.sha('original'),model:'openai/gpt-5.6-sol',promptSha256:c.sha('prompt')};
function store(){const records=new Map();return {records,create:jest.fn(async v=>{if(records.has(v._id))throw Object.assign(Error(),{code:11000});records.set(v._id,v);}),
  findById:jest.fn(id=>({select:()=>({lean:async()=>records.get(id)})})),
  updateOne:jest.fn(async(q,u)=>{const r=records.get(q._id);if(r?.status!==q.status)return {matchedCount:0};Object.assign(r,u.$set);return {matchedCount:1};})};}
test('concurrent duplicate jobs reserve one intent; run ID changes cannot buy another request',async()=>{
  const s=store(),r=await Promise.allSettled([acquire(identity,s),acquire({...identity,runId:'job2'},s)]);
  expect(r.filter(v=>v.status==='fulfilled')).toHaveLength(1);expect(r.filter(v=>v.status==='rejected')[0].reason.code).toBe('OCR_GPT_SOURCE_ATTEMPT_RESERVED');
  expect([...s.records.values()][0].expiresAt).toBeNull();
});
test('terminal failure and crashed reservation stay blocked across recovery',async()=>{
  const s=store(),a=await acquire(identity,s);await expect(acquire(identity,s)).rejects.toThrow('RESERVED');
  await complete(a._id,{status:'GPT_SOURCE_FAILED',payload:{safeFailureCode:'OCR_GPT_PROVIDER_PAYMENT_REQUIRED'}},s);
  await expect(acquire({...identity,runId:'recovery'},s)).rejects.toThrow('RESERVED');
});
test('completed success reusable only for same model, image and prompt provenance',async()=>{
  const s=store(),a=await acquire(identity,s);await complete(a._id,{status:'GPT_SOURCE_ACCEPTED',payload:{primary:{activeTranscript:'powerfull'}}},s);
  expect((await acquire({...identity,runId:'job2'},s)).cached).toBe(true);
  await expect(acquire({...identity,model:'openai/gpt-6-astra'},s)).rejects.toThrow('RESERVED');
  await expect(acquire({...identity,promptSha256:c.sha('changed')},s)).rejects.toThrow('RESERVED');
  expect((await acquire({...identity,pageNumber:2},s)).cached).toBe(false);
});
test('invalid identity and database admission failure never admit spend',async()=>{
  await expect(acquire({...identity,fileId:''},store())).rejects.toThrow('IDENTITY');
  const s=store();s.create.mockRejectedValue(Error('database unavailable'));await expect(acquire(identity,s)).rejects.toThrow('RESERVATION_FAILED');
});
