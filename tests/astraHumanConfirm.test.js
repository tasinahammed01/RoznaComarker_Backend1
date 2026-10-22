'use strict';
const source=require('../src/services/sourceFidelityOcr.service'),sf=require('../src/utils/sourceFidelity');
const {validateOcrConfiguration}=require('../src/config/ocr');
const {requireTransactions}=require('../src/services/sourceFidelity/transactionSupport');
const env={NODE_ENV:'production',OCR_SOURCE_MODE:'astra_human_confirm',OCR_ASTRA_MODEL:'openai/gpt-6-astra',OPENROUTER_API_KEY:'mock-only'};
const literal='  wemen,\nSocial sence.\t';
const value={activeTranscript:literal,segments:[{type:'ACTIVE_STUDENT_TEXT',text:literal,confidence:1,notes:''}],uncertainSpans:[]};
test('production mode requires only Astra and no Google/Fable configuration',()=>{
  expect(validateOcrConfiguration(env)).toMatchObject({mode:'astra_human_confirm',astraModel:env.OCR_ASTRA_MODEL,transactionRequired:true});
  expect(()=>validateOcrConfiguration({...env,OCR_SOURCE_VERIFICATION_MODE:'targeted_v4'})).toThrow();
  expect(()=>validateOcrConfiguration({...env,OCR_ASTRA_MODEL:'other/model'})).toThrow();
});
test.each([1,2])('one full-page Astra attempt per page; no Google/Fable/targeted (%i pages)',async count=>{
  const read=jest.fn(async()=>({returnedModel:env.OCR_ASTRA_MODEL,value})),google=jest.fn(),persistEvidence=jest.fn();
  for(let i=0;i<count;i++){
    const r=await source.readPage({bytes:Buffer.from([255,216,255,1]),mimeType:'image/jpeg',identity:{pageNumber:i+1},env:{...env,OCR_SOURCE_VERIFICATION_MODE:'targeted_v4'},reader:read,google,persistEvidence});
    expect(r.source).toMatchObject({sourceTextExact:literal,sourceTextSha256:sf.sha(literal),sourceFidelityStatus:'ASTRA_PROVISIONAL',sourceFidelityMode:'astra_human_confirm'});
    expect(read.mock.calls[i][0]).toMatchObject({model:'openai/gpt-6-astra',targeted:false,prompt:source.PROMPT});
    expect(persistEvidence.mock.calls[i][0].payload).toMatchObject({primary:value,secondary:null});
  }
  expect(read).toHaveBeenCalledTimes(count);expect(google).not.toHaveBeenCalled();
});
test('failed reader never retries or falls back, and remains blocked',async()=>{
  const read=jest.fn(async()=>{throw Error('failed');}),persistEvidence=jest.fn();
  const r=await source.readPage({bytes:Buffer.from([255,216,255]),mimeType:'image/jpeg',identity:{},env,reader:read,persistEvidence});
  expect(read).toHaveBeenCalledTimes(1);expect(r.source.sourceFidelityStatus).toBe('PROVIDER_FAILED');
});
test.each([
  [400,'AI_PROVIDER_INVALID_REQUEST','HTTP_ERROR_RESPONSE','HTTP_FAILED'],
  [402,'AI_PROVIDER_PAYMENT_REQUIRED','HTTP_ERROR_RESPONSE','HTTP_FAILED'],
  [null,'AI_PROVIDER_UNAVAILABLE','TRANSPORT_FAILURE','NO_HTTP_RESPONSE'],
  [200,'OCR_SOURCE_MODEL_IDENTITY','MODEL_IDENTITY_VALIDATION','HTTP_SUCCESS'],
  [200,'OCR_SOURCE_SCHEMA','JSON_OR_SCHEMA_VALIDATION','HTTP_SUCCESS'],
  [200,'OCR_SOURCE_TRANSCRIPT_MISMATCH','SOURCE_CONTRACT_VALIDATION','HTTP_SUCCESS']
])('development failure logs only safe fields (%s, %s)',async(httpStatus,code,stage,outcome)=>{
  const logger=require('../src/utils/logger'),spy=jest.spyOn(logger,'info').mockImplementation(()=>{}),persistEvidence=jest.fn();
  const read=jest.fn(async o=>{o.onDiagnostic({httpStatus,responseReceived:httpStatus!==null,failureStage:stage,safeCode:code,
    returnedModel:'openai/gpt-6-astra',rawBody:'SECRET_BODY',headers:{Authorization:'SECRET_KEY'}});throw Object.assign(Error('SECRET_BODY'),{code});});
  try{
    const r=await source.readPage({bytes:Buffer.from([255,216,255]),mimeType:'image/jpeg',identity:{},env:{...env,NODE_ENV:'development'},reader:read,persistEvidence});
    expect(r.source.sourceFidelityStatus).toBe('PROVIDER_FAILED');expect(read).toHaveBeenCalledTimes(1);
    const log=spy.mock.calls.map(([v])=>v).find(v=>v.event==='source_fidelity_reader_failure');
    expect(Object.keys(log).sort()).toEqual(['event','requestedModel','returnedModel','httpStatus','transportOutcome','validationStage','safeFailureCode','durationMs'].sort());
    expect(log).toMatchObject({requestedModel:'openai/gpt-6-astra',httpStatus,transportOutcome:outcome,validationStage:stage,safeFailureCode:code});
    expect(JSON.stringify(spy.mock.calls)).not.toContain('SECRET');
  }finally{spy.mockRestore();}
});
test('production failure does not enable development diagnostic logging',async()=>{
  const logger=require('../src/utils/logger'),spy=jest.spyOn(logger,'info').mockImplementation(()=>{}),persistEvidence=jest.fn();
  const read=jest.fn(async o=>{expect(o.onDiagnostic).toBeUndefined();throw Error('do not log');});
  try{await source.readPage({bytes:Buffer.from([255,216,255]),mimeType:'image/jpeg',identity:{},env,reader:read,persistEvidence});
    expect(spy.mock.calls.some(([v])=>v.event==='source_fidelity_reader_failure')).toBe(false);
  }finally{spy.mockRestore();}
});
test('Astra alone cannot authorize any page, even forged MODEL_AGREED',()=>{
  const p={fileId:'f',sourceFidelityMode:'astra_human_confirm',sourceFidelityStatus:'MODEL_AGREED',sourceTextExact:literal,sourceTextSha256:sf.sha(literal)};
  const d={sourceFidelityMode:'astra_human_confirm',files:['f'],ocrPages:[p]};Object.assign(d,sf.aggregate(d));
  expect(sf.eligible(d)).toBe(false);expect(d.sourceFidelityStatus).toBe('HUMAN_REVIEW_REQUIRED');
});
test.each([{isWritablePrimary:true,maxWireVersion:17,logicalSessionTimeoutMinutes:30},{setName:'rs',maxWireVersion:6,logicalSessionTimeoutMinutes:30}])('unsupported transactions fail closed',async hello=>{
  await expect(requireTransactions({db:{admin:()=>({command:async()=>hello})}})).rejects.toMatchObject({code:'OCR_SOURCE_TRANSACTIONS_REQUIRED'});
});
test.each([{setName:'rs',maxWireVersion:17,logicalSessionTimeoutMinutes:30},{msg:'isdbgrid',maxWireVersion:17,logicalSessionTimeoutMinutes:30}])('replica/sharded topology admitted',async hello=>{
  await expect(requireTransactions({db:{admin:()=>({command:async()=>hello})}})).resolves.toBe(true);
});
