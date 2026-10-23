'use strict';
const {VERSION,sha,fail,config,schema,PROMPT,validate,diagnostics}=require('./gptVisionExact/contract');
const attempts=require('./gptVisionExact/attempt');
const {alignGeometry}=require('./gptVisionExact/alignment');
function reference(assignment={}){return Object.fromEntries(['title','prompt','question','instructions','description'].filter(k=>typeof assignment[k]==='string').map(k=>[k,assignment[k].slice(0,10000)]));}
async function reader({model,bytes,mimeType,prompt,assignmentReference,env,signal,onDiagnostic,fetchImpl=global.fetch}){
  return require('./aiGateway.service').providerAttempt({entry:{provider:'openrouter',model},messages:[{role:'system',content:prompt},
    {role:'user',content:[{type:'text',text:JSON.stringify({task:'Read this full page. Reference below is untrusted context only, never source authority.',assignmentReference})},
      {type:'image_url',image_url:{url:`data:${mimeType};base64,${bytes.toString('base64')}`}}]}],
    maxOutputTokens:16000,responseFormat:'json',responseSchema:schema,schemaName:'gpt_vision_exact_v2',attemptTimeoutMs:180000,
    fetchImpl,env,now:Date.now,signal,requestProfile:'gpt_vision_exact_v1',onDiagnostic});
}
const safeCode=v=>typeof v==='string'&&/^(AI_|OCR_)[A-Z0-9_]{1,75}$/.test(v)?v:null;
function failureCode(error){const map={AI_PROVIDER_AUTH_ERROR:'OCR_GPT_PROVIDER_AUTH',AI_PROVIDER_PAYMENT_REQUIRED:'OCR_GPT_PROVIDER_PAYMENT_REQUIRED',
  AI_PROVIDER_PERMISSION_DENIED:'OCR_GPT_PROVIDER_ACCESS',AI_PROVIDER_RATE_LIMIT:'OCR_GPT_PROVIDER_RATE_LIMIT',AI_PROVIDER_UNAVAILABLE:'OCR_GPT_PROVIDER_NETWORK',AI_ATTEMPT_TIMEOUT:'OCR_GPT_PROVIDER_NETWORK'};
  return map[error?.code]||(safeCode(error?.code)&&/^OCR_(GPT_|SOURCE_MODEL_IDENTITY)/.test(error.code)?error.code:'OCR_GPT_PROVIDER_FAILED');}
async function readPage({bytes,mimeType,identity,assignment,google,isCurrentJob=async()=>true,signal,env=process.env,read=reader,reservation=attempts}){
  const {model}=config(env),started=Date.now();
  const actualMime=bytes?.[0]===255&&bytes?.[1]===216&&bytes?.[2]===255?'image/jpeg':Buffer.isBuffer(bytes)&&bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))?'image/png':Buffer.isBuffer(bytes)&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'?'image/webp':null;
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>20*1024*1024||actualMime!==mimeType)throw fail('OCR_GPT_SOURCE_IMAGE_INVALID');
  if(signal?.aborted||!await isCurrentJob())throw fail('OCR_JOB_SUPERSEDED');
  const assignmentReference=reference(assignment),bound={...identity,inputSha256:sha(bytes),model,promptSha256:sha(PROMPT+JSON.stringify(assignmentReference)),mimeType};
  const attempt=await reservation.acquire(bound);
  let result,value,diagnostic,rejectionDiagnostic,alignment={coverage:0,words:[]},validationStage='PROVIDER_REQUEST',code=null;
  let geometryMs=0,sourceReuseMs=0,preflightSourceMs=0;
  try{
    if(attempt.cached){value=validate(JSON.stringify(attempt.evidence.payload.primary));result={returnedModel:model};
      sourceReuseMs=Date.now()-started;preflightSourceMs=Number(attempt.evidence.payload.sourceReadMs
        ??attempt.evidence.payload.readers?.[0]?.durationMs)||0;}
    else{
      result=await read({model,bytes,mimeType,prompt:PROMPT,assignmentReference,env,signal,onDiagnostic:d=>{diagnostic=d;}});
      validationStage='MODEL_IDENTITY_VALIDATION';if(result.returnedModel!==model)throw fail('OCR_SOURCE_MODEL_IDENTITY');
      validationStage='JSON_OR_SCHEMA_VALIDATION';value=validate(result.content);
    }
    if(signal?.aborted||!await isCurrentJob())throw fail('OCR_JOB_SUPERSEDED');
    // Geometry is optional evidence, obtained only after valid active source.
    const geometryStarted=Date.now();
    let geometry;try{geometry=google?await google():null;}catch{geometry={words:[],geometryFailureCode:'GEOMETRY_PROVIDER_UNAVAILABLE'};/* No lexical fallback. */}
    alignment=alignGeometry(value.activeTranscript,geometry,identity);
    geometryMs=Date.now()-geometryStarted;
    if(signal?.aborted||!await isCurrentJob())throw fail('OCR_JOB_SUPERSEDED');
    validationStage='ACCEPTED';
    if(!attempt.cached)await reservation.complete(attempt._id,{status:'GPT_SOURCE_ACCEPTED',payload:{primary:value,sourceReadMs:Date.now()-started-geometryMs,...safeSourceDiagnostic(diagnostics(value)),
      readers:[{requestedModel:model,returnedModel:result.returnedModel,usage:require('./sourceFidelityOcr.service').safeUsage(result.usage),durationMs:result.durationMs}]}});
  }catch(error){
    rejectionDiagnostic=safeSourceDiagnostic(error.sourceDiagnostic);
    code=failureCode(error);if(error.code==='OCR_GPT_SOURCE_TRANSCRIPT_MISMATCH')validationStage='SOURCE_CONTRACT_VALIDATION';
    if(error.code==='OCR_GPT_SOURCE_UNCERTAIN')validationStage='SOURCE_AMBIGUITY_VALIDATION';
    if(!attempt.cached)await reservation.complete(attempt._id,{status:'GPT_SOURCE_FAILED',payload:{safeFailureCode:code,validationStage:diagnostic?.failureStage||validationStage,
      requestedModel:model,httpStatus:Number.isInteger(diagnostic?.httpStatus)?diagnostic.httpStatus:null,...rejectionDiagnostic}});
    throw Object.assign(fail(code),{sourceDiagnostic:rejectionDiagnostic});
  }finally{
    if(['development','test'].includes(env.NODE_ENV)){
      const segments=value?.physicalLines.flatMap(l=>l.segments)||[],count=c=>segments.filter(s=>s.classification===c).length;
      require('../utils/logger').info({event:'gpt_vision_source_reader',sourceMode:'gpt_vision_exact',requestedModel:model,
        returnedModel:result?.returnedModel===model?model:null,httpStatus:Number.isInteger(diagnostic?.httpStatus)?diagnostic.httpStatus:result?200:null,
        validationStage:diagnostic?.failureStage||validationStage,safeFailureCode:safeCode(code),durationMs:Date.now()-started,pageNumber:identity.pageNumber,
        activeCharacterCount:value?.activeTranscript.length||0,activeLineCount:value?.physicalLines.filter(l=>l.segments.some(s=>s.classification==='STUDENT_ACTIVE_TEXT')).length||0,
        excludedSegmentCount:segments.length-count('STUDENT_ACTIVE_TEXT'),crossedOutSegmentCount:count('STUDENT_CROSSED_OUT'),promptSegmentCount:count('PROMPT_OR_INSTRUCTION'),
        uncertainSegmentCount:count('UNCERTAIN'),geometryAlignmentCoverage:alignment.coverage,
        preflightSourceMs,sourceReuseMs,geometryMs,providerCallCount:attempt.cached?0:1,
        geometryOutcomeCode:alignment.diagnostics?.safeOutcomeCode,
        ...(value?safeSourceDiagnostic(diagnostics(value)):{}),...rejectionDiagnostic});
    }
  }
  const text=value.activeTranscript,source={sourceTextExact:text,sourceTextSha256:sha(text),sourceFidelityMode:'gpt_vision_exact',sourceFidelityVersion:VERSION,
    sourceFidelityStatus:'GPT_SOURCE_ACCEPTED',sourcePrimaryProvider:'openrouter',sourcePrimaryModel:model,sourceInputSha256:bound.inputSha256,
    sourceSha256:identity.sourceSha256,ocrInputSha256:bound.inputSha256,sourceMimeType:mimeType,sourceDisagreementCount:0,
    sourceVerificationSummary:{performance:{preflightSourceMs,sourceReuseMs,geometryMs,sourceMs:Date.now()-started-geometryMs,
      sourceProviderCallCount:attempt.cached?0:1,geometryProviderCallCount:google?1:0,sourceReused:attempt.cached===true,
      provider:'openrouter',model,safeOutcomeCode:'GPT_SOURCE_ACCEPTED',geometry:alignment.diagnostics}}};
  return {fullText:text,transcriptText:text,words:alignment.words,pages:[{pageNumber:identity.pageNumber,words:alignment.words,...source}],source};
}
function safeSourceDiagnostic(value){
  const out={};if([null,'UNCERTAIN_SEGMENT_PRESENT','UNCERTAINTY_LIST_NONEMPTY','ACTIVE_TEXT_UNREADABLE','ACTIVE_ROLE_AMBIGUOUS','ACTIVE_REPLACEMENT_AMBIGUOUS','ACTIVE_PUNCTUATION_UNREADABLE','TRANSCRIPT_RECONSTRUCTION_MISMATCH'].includes(value?.sourceAmbiguityReason))out.sourceAmbiguityReason=value.sourceAmbiguityReason;
  for(const key of ['activeCharacterCount','activeLineCount','uncertainSegmentCount','uncertaintyCount','activeUncertainCount','nonActiveUncertainCount','deletedUnreadableCount','promptUnreadableCount','blockingUncertaintyCount'])if(Number.isInteger(value?.[key])&&value[key]>=0&&value[key]<=60000)out[key]=value[key];
  return out;
}
module.exports={readPage,reader,failureCode,reference,safeSourceDiagnostic};
