'use strict';
const {VERSION,sha,fail,config,PROMPT,validate,diagnostics}=require('./gptVisionExact/contract');
const attempts=require('./gptVisionExact/attempt');
const {alignGeometry}=require('./gptVisionExact/alignment');
function reference(assignment={}){return Object.fromEntries(['title','prompt','question','instructions','description'].filter(k=>typeof assignment[k]==='string').map(k=>[k,assignment[k].slice(0,10000)]));}
async function reader({model,bytes,mimeType,prompt,assignmentReference,env,signal,onDiagnostic,onObservation,fetchImpl=global.fetch}){
  const wire=require('./gptVisionExact/contract').wireContract(model);
  const policy=model===require('./gptVisionExact/contract').QWEN_MODEL?require('./gptVisionExact/contract').requestPolicy(env):{maxOutputTokens:16000,attemptTimeoutMs:180000};
  return require('./aiGateway.service').providerAttempt({entry:{provider:'openrouter',model},messages:[{role:'system',content:model===require('./gptVisionExact/contract').QWEN_MODEL?wire.prompt:prompt},
    {role:'user',content:[{type:'text',text:JSON.stringify({task:'Read this full page. Reference below is untrusted context only, never source authority.',assignmentReference})},
      {type:'image_url',image_url:{url:`data:${mimeType};base64,${bytes.toString('base64')}`}}]}],
    ...policy,responseFormat:'json',responseSchema:wire.schema,schemaName:wire.name,
    fetchImpl:typeof onObservation==='function'?(url,options)=>{
      try{onObservation({qwenInvoked:model===require('./gptVisionExact/contract').QWEN_MODEL});}catch{/* Observation only. */}
      return fetchImpl(url,options);
    }:fetchImpl,env,now:Date.now,signal,requestProfile:'gpt_vision_exact_v1',onDiagnostic});
}
const safeCode=v=>typeof v==='string'&&/^(AI_|OCR_)[A-Z0-9_]{1,75}$/.test(v)?v:null;
function failureCode(error){const map={AI_PROVIDER_AUTH_ERROR:'OCR_GPT_PROVIDER_AUTH',AI_PROVIDER_PAYMENT_REQUIRED:'OCR_GPT_PROVIDER_PAYMENT_REQUIRED',
  AI_PROVIDER_PERMISSION_DENIED:'OCR_GPT_PROVIDER_ACCESS',AI_PROVIDER_RATE_LIMIT:'OCR_GPT_PROVIDER_RATE_LIMIT',AI_PROVIDER_UNAVAILABLE:'OCR_GPT_PROVIDER_NETWORK',AI_ATTEMPT_TIMEOUT:'OCR_GPT_PROVIDER_NETWORK'};
  // Direct providerAttempt throws native fetch errors; unlike generate(), it does not wrap them.
  for(let cause=error,depth=0;cause&&depth<4;cause=cause.cause,depth++)
    if(['ETIMEDOUT','ECONNRESET','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','EPIPE','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET'].includes(cause.code)
      ||['AbortError','TimeoutError'].includes(cause.name))return 'OCR_GPT_PROVIDER_NETWORK';
  return map[error?.code]||(safeCode(error?.code)&&/^OCR_(GPT_|SOURCE_MODEL_IDENTITY)/.test(error.code)?error.code:'OCR_GPT_PROVIDER_FAILED');}
async function readPage({bytes,mimeType,identity,assignment,google,isCurrentJob=async()=>true,signal,env=process.env,read=reader,reservation=attempts,onObservation}){
  const observe=value=>{if(typeof onObservation==='function')try{onObservation(value);}catch{/* Observation only. */}};
  const {model}=config(env),started=Date.now();
  const actualMime=bytes?.[0]===255&&bytes?.[1]===216&&bytes?.[2]===255?'image/jpeg':Buffer.isBuffer(bytes)&&bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))?'image/png':Buffer.isBuffer(bytes)&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'?'image/webp':null;
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>20*1024*1024||actualMime!==mimeType)throw fail('OCR_GPT_SOURCE_IMAGE_INVALID');
  if(signal?.aborted||!await isCurrentJob())throw fail('OCR_JOB_SUPERSEDED');
  const wire=require('./gptVisionExact/contract').wireContract(model);
  const assignmentReference=reference(assignment),bound={...identity,inputSha256:sha(bytes),model,promptSha256:sha(wire.prompt+JSON.stringify(assignmentReference)),mimeType,
    ...(model===require('./gptVisionExact/contract').QWEN_MODEL?{legacyPromptSha256:sha(PROMPT+JSON.stringify(assignmentReference)),
      previousPromptSha256:sha(require('./gptVisionExact/contract').PREVIOUS_QWEN_PROMPT+JSON.stringify(assignmentReference)),
      qwenPromptVersion:wire.promptVersion,wireVersion:wire.version}:{})};
  const attempt=await reservation.acquire(bound);
  observe({cacheUsed:attempt.cached===true,stage:attempt.cached?'cache_validation':'provider_request'});
  let result,value,diagnostic,rejectionDiagnostic,alignment={coverage:0,words:[]},validationStage='PROVIDER_REQUEST',code=null;
  let geometryMs=0,sourceReuseMs=0,preflightSourceMs=0;
  let sourceValidationMs=0,sourcePersistMs=0,sourceProviderMs=0;
  let transcriptDiagnostic={};
  const validateSource=content=>(model===require('./gptVisionExact/contract').QWEN_MODEL?require('./gptVisionExact/contract').validateWire:validate)(content,{onDiagnostic:d=>{transcriptDiagnostic=safeSourceDiagnostic(d);}});
  try{
    if(attempt.cached){const validationStarted=Date.now();value=require('./gptVisionExact/contract').validateCanonical(JSON.stringify(attempt.evidence.payload.primary));sourceValidationMs=Date.now()-validationStarted;result={returnedModel:model};
      sourceReuseMs=Date.now()-started;preflightSourceMs=Number(attempt.evidence.payload.sourceReadMs
        ??attempt.evidence.payload.readers?.[0]?.durationMs)||0;}
    else{
      const providerStarted=Date.now();
      result=await read({model,bytes,mimeType,prompt:wire.prompt,assignmentReference,env,signal,onObservation:typeof onObservation==='function'?observe:undefined,onDiagnostic:d=>{diagnostic=d;
        observe({validationStage:d.failureStage,providerHttpStatus:d.httpStatus,timeoutOrigin:d.timeoutOrigin});}});
      sourceProviderMs=Date.now()-providerStarted;
      validationStage='MODEL_IDENTITY_VALIDATION';if(result.returnedModel!==model)throw fail('OCR_SOURCE_MODEL_IDENTITY');
      validationStage='JSON_OR_SCHEMA_VALIDATION';observe({stage:'source_validation'});const validationStarted=Date.now();value=validateSource(result.content);sourceValidationMs=Date.now()-validationStarted;
    }
    if(signal?.aborted||!await isCurrentJob())throw fail('OCR_JOB_SUPERSEDED');
    // Geometry is optional evidence, obtained only after valid active source.
    const geometryStarted=Date.now();
    let geometry;try{geometry=google?await google():null;}catch{geometry={words:[],geometryFailureCode:'GEOMETRY_PROVIDER_UNAVAILABLE'};/* No lexical fallback. */}
    alignment=alignGeometry(value.activeTranscript,geometry,identity);
    geometryMs=Date.now()-geometryStarted;
    if(signal?.aborted||!await isCurrentJob())throw fail('OCR_JOB_SUPERSEDED');
    validationStage='ACCEPTED';
    const sourceProfile={...transcriptDiagnostic,wireVersion:wire.version,...(wire.promptVersion?{qwenPromptVersion:wire.promptVersion}:{}),sourceImagePrepareMs:Number(identity.sourceImagePrepareMs)||0,sourceProviderMs,sourceValidationMs,
      imageWidth:identity.width||null,imageHeight:identity.height||null,encodedImageBytes:bytes.length,imageDetail:'provider_default',reasoningControl:model===require('./gptVisionExact/contract').QWEN_MODEL?'none':'not_set',
      promptTokenEstimate:Math.ceil((wire.prompt.length+JSON.stringify(assignmentReference).length)/4),responseSchemaTokenEstimate:Math.ceil(JSON.stringify(wire.schema).length/4),
      requestedOutputTokens:16000,attemptTimeoutMs:model===require('./gptVisionExact/contract').QWEN_MODEL?require('./gptVisionExact/contract').requestPolicy(env).attemptTimeoutMs:180000,
      usage:require('./sourceFidelityOcr.service').safeUsage(result.usage),
      requestToHeadersMs:result.transportTimings?.requestToHeadersMs??null,responseBodyMs:result.transportTimings?.responseBodyMs??null};
    const persistStarted=Date.now();
    if(!attempt.cached)await reservation.complete(attempt._id,{status:'GPT_SOURCE_ACCEPTED',payload:{primary:value,sourceReadMs:Date.now()-started-geometryMs,sourceProfile,...safeSourceDiagnostic(diagnostics(value)),
      ...transcriptDiagnostic,readers:[{requestedModel:model,returnedModel:result.returnedModel,usage:require('./sourceFidelityOcr.service').safeUsage(result.usage),durationMs:result.durationMs}]}});
    sourcePersistMs=Date.now()-persistStarted;
    if(!attempt.cached)require('../utils/logger').info({event:'gpt_source_performance',...sourceProfile,sourcePersistMs,sourceMode:'gpt_vision_exact',model,safeOutcomeCode:'GPT_SOURCE_ACCEPTED'});
  }catch(error){
    rejectionDiagnostic=safeSourceDiagnostic(error.sourceDiagnostic);
    code=signal?.aborted?(signal.reason==='source_preflight_deadline'?'OCR_GPT_PROVIDER_NETWORK':'OCR_GPT_SOURCE_CANCELLED'):failureCode(error);if(error.code==='OCR_GPT_SOURCE_TRANSCRIPT_MISMATCH')validationStage='SOURCE_CONTRACT_VALIDATION';
    if(error.code==='OCR_GPT_SOURCE_UNCERTAIN')validationStage='SOURCE_AMBIGUITY_VALIDATION';
    if(!attempt.cached)await reservation.complete(attempt._id,{status:'GPT_SOURCE_FAILED',payload:{safeFailureCode:code,validationStage:diagnostic?.failureStage||validationStage,
      requestedModel:model,httpStatus:Number.isInteger(diagnostic?.httpStatus)?diagnostic.httpStatus:null,...safeTransportDiagnostic(diagnostic),...rejectionDiagnostic}});
    throw Object.assign(fail(code),{sourceDiagnostic:rejectionDiagnostic});
  }finally{
    observe({validationStage:attempt.cached&&validationStage!=='ACCEPTED'?'CACHE_VALIDATION':diagnostic?.failureStage||validationStage,
      providerHttpStatus:diagnostic?.httpStatus??result?.httpStatus,
      timeoutOrigin:diagnostic?.timeoutOrigin});
    if(['development','test'].includes(env.NODE_ENV)){
      const segments=value?.physicalLines.flatMap(l=>l.segments)||[],count=c=>segments.filter(s=>s.classification===c).length;
      require('../utils/logger').info({event:'gpt_vision_source_reader',sourceMode:'gpt_vision_exact',requestedModel:model,
        returnedModel:result?.returnedModel===model?model:null,httpStatus:Number.isInteger(diagnostic?.httpStatus)?diagnostic.httpStatus:result?200:null,
        validationStage:diagnostic?.failureStage||validationStage,safeFailureCode:safeCode(code),durationMs:Date.now()-started,pageNumber:identity.pageNumber,
        activeCharacterCount:value?.activeTranscript.length||0,activeLineCount:value?.physicalLines.filter(l=>l.segments.some(s=>s.classification==='STUDENT_ACTIVE_TEXT')).length||0,
        excludedSegmentCount:segments.length-count('STUDENT_ACTIVE_TEXT'),crossedOutSegmentCount:count('STUDENT_CROSSED_OUT'),promptSegmentCount:count('PROMPT_OR_INSTRUCTION'),
        uncertainSegmentCount:count('UNCERTAIN'),geometryAlignmentCoverage:alignment.coverage,
        preflightSourceMs,sourceReuseMs,geometryMs,providerCallCount:attempt.cached?0:1,
        geometryOutcomeCode:alignment.diagnostics?.safeOutcomeCode,...safeTransportDiagnostic(diagnostic),
        ...(value?safeSourceDiagnostic(diagnostics(value)):{}),...transcriptDiagnostic,...rejectionDiagnostic});
    }
  }
  const text=value.activeTranscript,source={sourceTextExact:text,sourceTextSha256:sha(text),sourceFidelityMode:'gpt_vision_exact',sourceFidelityVersion:VERSION,
    sourceFidelityStatus:'GPT_SOURCE_ACCEPTED',sourcePrimaryProvider:'openrouter',sourcePrimaryModel:model,sourceInputSha256:bound.inputSha256,
    sourceSha256:identity.sourceSha256,ocrInputSha256:bound.inputSha256,sourceMimeType:mimeType,sourceDisagreementCount:0,
    sourceVerificationSummary:{performance:{preflightSourceMs,sourceReuseMs,geometryMs,sourceMs:Date.now()-started-geometryMs,
      sourceImagePrepareMs:Number(identity.sourceImagePrepareMs)||0,sourceProviderMs,sourceValidationMs,sourcePersistMs,
      preflightProfile:attempt.cached?attempt.evidence.payload.sourceProfile||null:null,
      sourceProviderCallCount:attempt.cached?0:1,geometryProviderCallCount:google?1:0,sourceReused:attempt.cached===true,
      provider:'openrouter',model,safeOutcomeCode:'GPT_SOURCE_ACCEPTED',geometry:alignment.diagnostics}}};
  return {fullText:text,transcriptText:text,words:alignment.words,pages:[{pageNumber:identity.pageNumber,words:alignment.words,...source}],source};
}
function safeTransportDiagnostic(value){
  const out={};
  for(const key of ['requestToHeadersMs','responseBodyMs','elapsedMs','attemptTimeoutMs'])if(Number.isFinite(value?.[key])&&value[key]>=0)out[key]=value[key];
  for(const key of ['responseReceived','bodyRead'])if(typeof value?.[key]==='boolean')out[key]=value[key];
  if(['caller_cancelled','local_attempt_timeout','shared_stage_deadline','source_preflight_deadline'].includes(value?.timeoutOrigin))out.timeoutOrigin=value.timeoutOrigin;
  if(['TRANSPORT_FAILURE','RESPONSE_BODY_READ_FAILURE','HTTP_ERROR_RESPONSE','RESPONSE_JSON_PARSE_FAILURE','PROVIDER_RESPONSE_SHAPE_INVALID','MODEL_IDENTITY_VALIDATION'].includes(value?.transportPhase))out.transportPhase=value.transportPhase;
  if(/^[A-Z][A-Z0-9_]{0,79}$/.test(value?.internalCauseCode||''))out.internalCauseCode=value.internalCauseCode;
  if(value?.usage)out.usage=require('./sourceFidelityOcr.service').safeUsage(value.usage);
  return out;
}
function safeSourceDiagnostic(value){
  const out={};if([null,'UNCERTAIN_SEGMENT_PRESENT','UNCERTAINTY_LIST_NONEMPTY','ACTIVE_TEXT_UNREADABLE','ACTIVE_ROLE_AMBIGUOUS','ACTIVE_REPLACEMENT_AMBIGUOUS','ACTIVE_PUNCTUATION_UNREADABLE','TRANSCRIPT_RECONSTRUCTION_MISMATCH'].includes(value?.sourceAmbiguityReason))out.sourceAmbiguityReason=value.sourceAmbiguityReason;
  if(Array.isArray(value?.blockingUncertaintyDetails))out.blockingUncertaintyDetails=require('./gptVisionExact/contract').safeUncertaintyDetails(value.blockingUncertaintyDetails);
  if(Number.isInteger(value?.blockingUncertaintyDetailsOmitted)&&value.blockingUncertaintyDetailsOmitted>=0&&value.blockingUncertaintyDetailsOmitted<=3300)
    out.blockingUncertaintyDetailsOmitted=value.blockingUncertaintyDetailsOmitted;
  for(const key of ['activeCharacterCount','activeLineCount','uncertainSegmentCount','uncertaintyCount','activeUncertainCount','nonActiveUncertainCount','deletedUnreadableCount','promptUnreadableCount','blockingUncertaintyCount'])if(Number.isInteger(value?.[key])&&value[key]>=0&&value[key]<=60000)out[key]=value[key];
  for(const key of ['transcriptModelLength','transcriptDerivedLength','transcriptFirstDifference','transcriptModelLine','transcriptDerivedLine','transcriptPhysicalLineIndex','transcriptSegmentIndex'])if(Number.isInteger(value?.[key])&&value[key]>=-1&&value[key]<=6000000)out[key]=value[key];
  const comparison=require('./gptVisionExact/transcriptDiagnostic');
  if(['EXACT','SEPARATOR_ONLY','MISMATCH','SERVER_DERIVED'].includes(value?.transcriptComparison))out.transcriptComparison=value.transcriptComparison;
  if(typeof value?.transcriptReconciled==='boolean')out.transcriptReconciled=value.transcriptReconciled;
  for(const key of ['transcriptReconciledBoundaries','transcriptSeparatorLFCount','transcriptSeparatorCRLFCount','transcriptSeparatorSpaceCount'])
    if(Number.isInteger(value?.[key])&&value[key]>=0&&value[key]<=299)out[key]=value[key];
  if(comparison.TYPES.includes(value?.transcriptDifferenceType))out.transcriptDifferenceType=value.transcriptDifferenceType;
  for(const key of ['transcriptModelCharacterKind','transcriptDerivedCharacterKind'])if(comparison.CHARACTER_KINDS.includes(value?.[key]))out[key]=value[key];
  return {...out,...require('./gptVisionExact/schemaDiagnostic').safe(value)};
}
module.exports={readPage,reader,failureCode,reference,safeSourceDiagnostic};
