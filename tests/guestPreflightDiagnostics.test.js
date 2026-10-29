'use strict';
const mockBasic=jest.fn(),mockPages=jest.fn(),mockSource=jest.fn();
jest.mock('../src/services/imagePreflight.service',()=>({evaluateImage:(...args)=>mockBasic(...args)}));
jest.mock('../src/services/gptVisionExact/preflight',()=>({...jest.requireActual('../src/services/gptVisionExact/preflight'),
  pagesFor:(...args)=>mockPages(...args),checkPages:(...args)=>mockSource(...args)}));
jest.mock('../src/middlewares/rateLimit.middleware',()=>({createSensitiveRateLimiter:()=> (_req,_res,next)=>next()}));
jest.mock('../src/services/guestAccess.service',()=>({...jest.requireActual('../src/services/guestAccess.service'),requireGuestAccess:(_req,_res,next)=>next()}));
jest.mock('../src/controllers/guestSubmission.controller',()=>new Proxy({},{get:()=> (req,res,next)=>{
  if(req.body?.earlyDenied)return res.status(503).json({success:false,code:'GUEST_INDEX_SETUP_REQUIRED',message:'PRIVATE controller failure'});
  if(req.body?.exception)throw Object.assign(Error('PRIVATE exception body'),{code:'GUEST_REQUEST_FAILED'});
  req.guestContext={assignment:{_id:'synthetic'},owner:{_id:'owner'}};next();
}}));
jest.mock('../src/middlewares/upload.middleware',()=>({setUploadType:()=> (_req,_res,next)=>next(),
  upload:{single:()=> (req,_res,next)=>{if(!req.body?.missingFile)req.file={detectedMime:'image/jpeg',buffer:Buffer.from('PRIVATE image bytes'),originalname:'PRIVATE-filename.jpg'};next();},array:()=> (_req,_res,next)=>next()},
  handleUploadError:(err,_req,_res,next)=>next(err),
  validateUploadedFileSignature:(req,res,next)=>req.body?.badSignature?res.status(400).json({success:false,message:'PRIVATE file error'}):next()}));
const express=require('express'),request=require('supertest'),logger=require('../src/utils/logger');
const diag=require('../src/utils/guestPreflightDiagnostics');
const app=express();app.use(express.json());app.use('/api/guest',require('../src/routes/guestSubmission.routes'));
app.use((err,_req,res,_next)=>res.status(500).json({success:false,code:err.code,message:'PRIVATE exception body'}));
const env={...process.env};let logs;
const send=(body={},path='/api/guest/assignments/PRIVATE-guest-token/image-preflight')=>request(app).post(path)
  .set('Idempotency-Key','opaque-request-reference-1234567890123456').set('Authorization','Bearer PRIVATE').set('Cookie','PRIVATE')
  .set('User-Agent','PRIVATE android chrome').send({name:'PRIVATE student',email:'private@example.invalid',phase:'source',...body});
beforeEach(()=>{
  process.env.GUEST_SUBMISSION_ENABLED='true';process.env.OCR_SOURCE_MODE='gpt_vision_exact';logs=[];
  jest.spyOn(logger,'metric').mockImplementation(value=>logs.push(value));
  jest.spyOn(logger,'info').mockImplementation(()=>{});
  mockBasic.mockReset().mockResolvedValue({ready:true,checks:[]});mockPages.mockReset().mockResolvedValue([{pageNumber:1}]);
  mockSource.mockReset().mockImplementation(async(_pages,_context,{onObservation})=>onObservation?.({qwenInvoked:true,cacheUsed:false,validationStage:'ACCEPTED'}));
});
afterEach(()=>{jest.restoreAllMocks();process.env= {...env};});
test('source PASS emits one production-visible event with matching opaque header and unchanged response',async()=>{
  process.env.NODE_ENV='production';const r=await send();expect(r.status).toBe(200);
  expect(r.body).toMatchObject({success:true,data:{ready:true,sourceReadStatus:'PASSED',canSubmit:true}});
  expect(logs).toHaveLength(1);expect(logs[0]).toMatchObject({event:'guest_image_preflight_result',feature:'guest_image_preflight',
    phase:'source',httpStatus:200,responseCompleted:true,responseSuccess:true,sourceReadStatus:'PASSED',finalOutcome:'passed',
    qwenInvoked:true,cacheUsed:false,errorCode:null,failureStage:null});
  expect(logs[0].correlationId).toBe(r.headers['x-request-id']);expect(logs[0].correlationId).toMatch(/^[a-f0-9-]{36}$/);
  expect(logs[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);expect(logs[0].durationMs).toBeGreaterThanOrEqual(0);
  expect(logger.info.mock.calls.filter(([v])=>v.event==='source_preflight_request')).toHaveLength(0);
});
test('HTTP 200 ambiguous handwriting is an application failure, never PASS',async()=>{
  mockSource.mockImplementation(async(_p,_c,{onObservation})=>{
    onObservation({qwenInvoked:true,cacheUsed:false,stage:'source_validation',validationStage:'SOURCE_AMBIGUITY_VALIDATION',providerHttpStatus:200});
    throw Object.assign(Error('PRIVATE OCR text'),{code:'OCR_GPT_SOURCE_UNCERTAIN'});
  });
  const r=await send();expect(r.status).toBe(200);expect(r.body.data).toMatchObject({sourceReadStatus:'FAILED_IMAGE',ready:false,canSubmit:false});
  expect(logs[0]).toMatchObject({httpStatus:200,finalOutcome:'image_rejected',errorCode:'OCR_GPT_SOURCE_UNCERTAIN',
    failureStage:'SOURCE_AMBIGUITY_VALIDATION',qwenInvoked:true,providerHttpStatus:200});
});
test.each([
  ['OCR_GPT_PROVIDER_NETWORK','REQUEST_ABORTED',null,'local_attempt_timeout'],
  ['OCR_GPT_PROVIDER_AUTH','HTTP_ERROR_RESPONSE',401,undefined],
  ['OCR_GPT_PROVIDER_RATE_LIMIT','HTTP_ERROR_RESPONSE',429,undefined],
  ['OCR_GPT_SOURCE_SCHEMA','JSON_OR_SCHEMA_VALIDATION',200,undefined]
])('existing provider/validation code %s is distinguishable',async(errorCode,validationStage,providerHttpStatus,timeoutOrigin)=>{
  mockSource.mockImplementation(async(_p,_c,{onObservation})=>{onObservation({qwenInvoked:true,cacheUsed:false,stage:'provider_request',validationStage,providerHttpStatus,timeoutOrigin});throw Object.assign(Error('PRIVATE provider response'),{code:errorCode});});
  const r=await send();expect(r.status).toBe(200);expect(r.body.data.canSubmit).toBe(false);
  expect(logs[0]).toMatchObject({finalOutcome:'service_unavailable',errorCode,failureStage:validationStage,providerHttpStatus,timeoutOrigin:timeoutOrigin||null});
});
test('circuit admission failure is not reported as an invoked Qwen request',async()=>{
  mockSource.mockRejectedValue(Object.assign(Error('PRIVATE'),{code:'OCR_GPT_CIRCUIT_OPEN'}));
  const r=await send();expect(r.body.data.canSubmit).toBe(false);
  expect(logs[0]).toMatchObject({finalOutcome:'service_unavailable',errorCode:'OCR_GPT_CIRCUIT_OPEN',circuitOpen:true,qwenInvoked:false,cacheUsed:null});
});
test('image preparation error is logged before any provider invocation, preserving existing service-status mapping',async()=>{
  mockPages.mockRejectedValue(Object.assign(Error('PRIVATE image path'),{code:'OCR_GPT_SOURCE_IMAGE_INVALID'}));
  const r=await send();expect(r.status).toBe(200);expect(r.body.data.canSubmit).toBe(false);expect(mockSource).not.toHaveBeenCalled();
  expect(logs[0]).toMatchObject({stage:'image_preparation',failureStage:'image_preparation',errorCode:'OCR_GPT_SOURCE_IMAGE_INVALID',
    finalOutcome:'service_unavailable',qwenInvoked:false,cacheUsed:null});
});
test('basic phase is CHECKING with no provider request and is not logged as verified PASS',async()=>{
  const r=await send({phase:'basic'});expect(r.body.data).toMatchObject({sourceReadStatus:'CHECKING',ready:false,canSubmit:false});
  expect(mockSource).not.toHaveBeenCalled();expect(logs[0]).toMatchObject({phase:'basic',stage:'basic_quality',sourceReadStatus:'CHECKING',
    finalOutcome:'unknown',failureStage:null,qwenInvoked:false,cacheUsed:null});
});
test.each(['fail','unavailable'])('basic image %s stays separate from provider failure',async status=>{
  mockBasic.mockResolvedValue({ready:false,checks:[{required:true,status,id:'resolution'}]});
  const r=await send();expect(r.status).toBe(200);expect(mockSource).not.toHaveBeenCalled();
  expect(logs[0]).toMatchObject({stage:'basic_quality',finalOutcome:status==='fail'?'image_rejected':'service_unavailable',qwenInvoked:false,errorCode:null});
});
test.each([false,true])('cached %s result reports reuse without buying a provider request',async failed=>{
  mockSource.mockImplementation(async(_p,_c,{onObservation})=>{onObservation({cacheUsed:true,stage:'cache_validation'});
    if(failed)throw Object.assign(Error('PRIVATE'),{code:'OCR_GPT_SOURCE_UNCERTAIN'});
  });
  const r=await send();expect(r.status).toBe(200);expect(logs[0]).toMatchObject({cacheUsed:true,qwenInvoked:false,
    finalOutcome:failed?'image_rejected':'passed'});
});
test.each(['missingFile','badSignature','earlyDenied','exception'])('early %s exit is logged without changing HTTP semantics',async flag=>{
  const r=await send({[flag]:true});expect(r.status).toBe(['missingFile','badSignature'].includes(flag)?400:flag==='earlyDenied'?503:500);
  expect(logs).toHaveLength(1);expect(logs[0].httpStatus).toBe(r.status);expect(logs[0].qwenInvoked).toBe(false);
  expect(mockSource).not.toHaveBeenCalled();
});
test('disabled guest route is observed before availability guard',async()=>{
  process.env.GUEST_SUBMISSION_ENABLED='false';const r=await send();expect(r.status).toBe(403);
  expect(logs[0]).toMatchObject({errorCode:'GUEST_SUBMISSION_UNAVAILABLE',stage:'guest_access',finalOutcome:'service_unavailable'});
});
test('concurrent guest/revision requests have independent correlation IDs and no private metadata',async()=>{
  await Promise.all([send(),send({},'/api/guest/submissions/PRIVATE-return-link/image-preflight')]);
  expect(logs).toHaveLength(2);expect(new Set(logs.map(x=>x.correlationId)).size).toBe(2);
  expect(JSON.stringify(logs)).not.toMatch(/PRIVATE|private@example|guest-token|return-link|android|chrome|127\.0\.0|filename|Bearer|Cookie/);
});
test('observer whitelists values, aggregates page observations, and ignores malicious text',async()=>{
  mockSource.mockImplementation(async(_p,_c,{onObservation})=>{
    onObservation({cacheUsed:true,qwenInvoked:true});onObservation({cacheUsed:false,qwenInvoked:false,
      stage:'PRIVATE',errorCode:'PRIVATE credentials',validationStage:'PRIVATE',providerHttpStatus:9999,timeoutOrigin:'PRIVATE',text:'PRIVATE'});
  });
  await send();expect(logs[0]).toMatchObject({cacheUsed:true,qwenInvoked:true,errorCode:null});expect(JSON.stringify(logs)).not.toContain('PRIVATE');
});
test('logger failure cannot disrupt a successful guest request',async()=>{
  logger.metric.mockImplementation(()=>{throw Error('PRIVATE logger error');});
  const r=await send();expect(r.status).toBe(200);expect(r.body.data.canSubmit).toBe(true);
});
test('closing before a response emits once, without inventing HTTP success or a provider result',()=>{
  const {EventEmitter}=require('events');const req={body:{}},res=Object.assign(new EventEmitter(),{set:jest.fn(),json:jest.fn(),statusCode:200,headersSent:false});
  diag.start(req,res,jest.fn());res.emit('close');res.emit('finish');
  expect(logs).toHaveLength(1);expect(logs[0]).toMatchObject({responseCompleted:false,httpStatus:null,finalOutcome:'unknown',qwenInvoked:false});
});
