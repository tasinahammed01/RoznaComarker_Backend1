'use strict';
const fs=require('fs/promises');
const Evidence=require('../../models/SourceFidelityEvidence');
const {VERSION,PROMPT,sha,config,validateCanonical:validate,fail,QWEN_MODEL,GEMINI_MODEL,sourceBinding,claimModelAccepted,sameSourcePrompt}=require('./contract');
const {orientImage}=require('./imageInput');
const IMAGE_MESSAGE='Some handwriting could not be read confidently. Please upload a clearer image.';
const RETRY_MESSAGE='We could not finish reading this page this time. Please try again.';
const SERVICE_MESSAGE='Handwriting verification is temporarily unavailable. Please try again later.';
function binding(context,page,env=process.env){
  const {model}=config(env),assignmentId=String(context.assignment._id),ownerId=String(context.ownerId);
  const reference=require('../gptVisionExact.service').reference(context.assignment),extra=sourceBinding(model,reference,env);
  const gemini=model===GEMINI_MODEL;
  // Qwen keeps the legacy hash in the identity so its durable key never changes. Gemini's identity carries its own prompt and reader
  // version, so a new prompt version gets a new key instead of finding old, differently-read evidence.
  const request=gemini?require('./verbatimReader').settings(env):null;
  const identity={preSubmission:true,ownerId,assignmentId,sourceMode:'gpt_vision_exact',version:VERSION,model,
    promptSha256:gemini?extra.promptSha256:sha(PROMPT+JSON.stringify(reference)),
    // Reasoning and temperature change what the model returns, so they are part of the Gemini identity (a .env change never returns an old transcript).
    ...(gemini?{readerMode:extra.readerMode,readerVersion:extra.readerVersion,sourceReasoning:request.reasoning,sourceTemperature:request.temperature===0?'0':'omit'}:{}),
    sourceSha256:page.sourceSha256,inputSha256:sha(page.bytes),pageNumber:page.pageNumber,pageIndex:page.pageNumber-1};
  // Keep the durable reservation key across this wire migration and across readers: changing it
  // would reset failed-source attempts/cooldowns and permit duplicate paid reads.
  const key=sha(JSON.stringify(identity)).slice(0,24);
  return {...identity,...extra,key};
}
async function pagesFor(file){
  const started=Date.now();
  const bytes=file.buffer||await fs.readFile(file.path),sourceSha256=sha(bytes);
  if((file.detectedMime||file.mimetype)==='application/pdf'){
    if(bytes.length>10*1024*1024||bytes.subarray(0,5).toString()!=='%PDF-')throw fail('OCR_PDF_INVALID');
    const pages=await require('../pdfSubmissionPages.service').rasterize(bytes);
    return pages.map((p,i)=>({bytes:p.buffer,mimeType:'image/jpeg',pageNumber:i+1,sourceSha256,sourceImagePrepareMs:Date.now()-started}));
  }
  const normalized=await orientImage(bytes);
  return [{bytes:normalized.data,mimeType:normalized.info.format==='jpeg'?'image/jpeg':`image/${normalized.info.format}`,pageNumber:1,sourceSha256,
    width:normalized.info.width,height:normalized.info.height,sourceImagePrepareMs:Date.now()-started}];
}
async function find(key){return Evidence.findById(key).select('+payload').lean();}
// Switch-over and rollback (F7): a page checked under the previously approved model stays submittable without another paid read.
// Looks the page up under the paired model's key and accepts it only when it is valid accepted evidence for the same owner,
// assignment and image, and the stored assignment text is unchanged (the reader-independent legacy hash proves that).
async function carriedEvidence(context,page,bound,env){
  const other=bound.model===GEMINI_MODEL?QWEN_MODEL:bound.model===QWEN_MODEL?GEMINI_MODEL:null;
  if(!other)return null;
  let alt;
  try{alt=binding(context,page,{...env,OCR_GPT_VISION_MODEL:other,OCR_GPT_VISION_READER:other===GEMINI_MODEL?'verbatim_json':'json_contract',OCR_GPT_VISION_SECOND_READER:undefined});}catch{return null;}
  const saved=await find(alt.key),id=saved?.identity;
  if(saved?.status!=='GPT_SOURCE_ACCEPTED'||!saved.payload?.primary||!id||id.model!==other||!claimModelAccepted(id.model,bound.model))return null;
  if(id.ownerId!==bound.ownerId||id.assignmentId!==bound.assignmentId||id.sourceSha256!==bound.sourceSha256||id.inputSha256!==bound.inputSha256||id.pageNumber!==bound.pageNumber)return null;
  if(!id.legacyPromptSha256||id.legacyPromptSha256!==bound.legacyPromptSha256)return null;
  return saved;
}
const sameBinding=(a,b)=>a&&b&&(Object.keys(b).every(k=>a[k]===b[k])
  ||b.model===QWEN_MODEL&&sameSourcePrompt(a,b)&&(!a.wireVersion||a.wireVersion===b.wireVersion)
    &&Object.keys(b).filter(k=>!['promptSha256','legacyPromptSha256','wireVersion','previousPromptSha256','qwenPromptVersion',
      'readerMode','readerVersion','jsonPromptSha256','plainPromptSha256'].includes(k)).every(k=>a[k]===b[k]));
function reservationFor(bound,onObservation){
const observe=value=>{if(typeof onObservation==='function')try{onObservation(value);}catch{/* Observation only. */}};
const owner=require('crypto').randomUUID(),policy=require('../sourceVerificationPolicy');let probe;
return {
  async acquire(){
    try{await Evidence.create({_id:bound.key,identity:bound,status:'GPT_SOURCE_RESERVED',expiresAt:null,
      leaseOwner:owner,leaseUntil:new Date(Date.now()+240000),attempts:1});}
    catch(e){if(e.code!==11000)throw fail('OCR_GPT_SOURCE_RESERVATION_FAILED');
    const old=await find(bound.key);
    if(old?.status==='GPT_SOURCE_ACCEPTED'&&sameBinding(old.identity,bound)&&old.payload?.primary)return {_id:bound.key,cached:true,evidence:old};
    if(old?.status==='GPT_SOURCE_RESERVED'&&(old.providerStartedAt&&(!old.leaseUntil||old.leaseUntil<=new Date())||!old.leaseUntil&&old.updatedAt<=new Date(Date.now()-240000)))throw fail('OCR_GPT_SOURCE_ATTEMPT_UNKNOWN');
    const payment=old?.status==='GPT_SOURCE_FAILED'&&policy.isPaymentFailure(old.payload?.safeFailureCode);
    if(old?.status==='GPT_SOURCE_FAILED'&&!payment&&(policy.classify(old.payload?.safeFailureCode,old.payload?.httpStatus)!=='retryable'||(old.attempts||1)>=policy.maxAttempts(old.payload?.safeFailureCode,bound.model))){
      observe({cacheUsed:true});
      throw Object.assign(fail(old.payload?.safeFailureCode||'OCR_GPT_PROVIDER_FAILED'),{sourceDiagnostic:require('../gptVisionExact.service').safeSourceDiagnostic(old.payload)});
    }
    // Historical payment evidence has no nextAttemptAt. Its timestamp supplies
    // the same cooldown; lifetime attempt count never permanently latches billing.
    const paymentRetry={status:'GPT_SOURCE_FAILED','payload.safeFailureCode':'OCR_GPT_PROVIDER_PAYMENT_REQUIRED',
      $or:[{nextAttemptAt:{$lte:new Date()}},{nextAttemptAt:null,updatedAt:{$lte:new Date(Date.now()-policy.PAYMENT_COOLDOWN_MS)}}]};
    const cap=policy.maxAttempts(old?.payload?.safeFailureCode,bound.model);
    const reclaimed=await Evidence.findOneAndUpdate({_id:bound.key,$or:[
      {status:'GPT_SOURCE_RESERVED',leaseUntil:{$lte:new Date()}},
      ...(payment?[paymentRetry]:[
      {status:'GPT_SOURCE_FAILED',nextAttemptAt:{$lte:new Date()},attempts:{$lt:cap}},
      {status:'GPT_SOURCE_FAILED',nextAttemptAt:null,updatedAt:{$lte:new Date(Date.now()-15000)},$or:[{attempts:{$exists:false}},{attempts:{$lt:cap}}]}])
    ]},{$set:{identity:bound,status:'GPT_SOURCE_RESERVED',leaseOwner:owner,leaseUntil:new Date(Date.now()+240000)},$unset:{providerStartedAt:1},$inc:{attempts:1}},{returnDocument:'after'});
    if(!reclaimed){if(old?.status==='GPT_SOURCE_FAILED')observe({cacheUsed:true});throw fail(old?.status==='GPT_SOURCE_FAILED' ? old.payload?.safeFailureCode||'OCR_GPT_PROVIDER_FAILED' : 'OCR_GPT_SOURCE_CHECKING');}
    }
    try{probe=await require('../sourceVerificationCircuit.service').enter(bound.model);}
    catch(error){await Evidence.updateOne({_id:bound.key,leaseOwner:owner},{$set:{leaseUntil:new Date(0)},$inc:{attempts:-1}});require('../../utils/logger').info({event:'source_verification_admission_blocked',model:bound.model,errorCode:error.code,providerCallCount:0});throw error;}
    try{
      const admitted=await Evidence.updateOne({_id:bound.key,leaseOwner:owner},{$set:{providerStartedAt:new Date()}});
      if(!admitted.matchedCount)throw fail('OCR_GPT_SOURCE_RESERVATION_FAILED');
    }catch(error){await require('../sourceVerificationCircuit.service').finish(probe,'OCR_GPT_SOURCE_CANCELLED').catch(()=>{});probe=null;throw error;}
    return {_id:bound.key,cached:false};
  },
  async complete(id,value){
    const code=value.payload?.safeFailureCode,status=value.payload?.httpStatus;
    try{
    const old=await Evidence.findOne({_id:id,leaseOwner:owner}).select('+payload').lean();if(!old)throw fail('OCR_GPT_SOURCE_RESERVATION_FAILED');
    const history=old.payload?.paymentFailureHistory||[];
    if(!history.length&&policy.isPaymentFailure(old.payload?.safeFailureCode))history.push({attempt:old.attempts-1,code:old.payload.safeFailureCode,httpStatus:old.payload.httpStatus||402,legacy:true});
    if(policy.isPaymentFailure(code))history.push({attempt:old.attempts,at:new Date(),code,httpStatus:status||402});
    // Retain bounded safe billing diagnostics even when fresh accepted payload replaces failure.
    if(history.length)value={...value,payload:{...value.payload,paymentFailureHistory:history.slice(-10)}};
    const r=await Evidence.updateOne({_id:id,status:'GPT_SOURCE_RESERVED',leaseOwner:owner},{$set:{...value,
      nextAttemptAt:policy.isPaymentFailure(code)?new Date(Date.now()+policy.PAYMENT_COOLDOWN_MS):policy.classify(code,status)==='retryable'?new Date(Date.now()+policy.delay(old.attempts)):null},$unset:{leaseOwner:1,leaseUntil:1}});
    if(!r.matchedCount)throw fail('OCR_GPT_SOURCE_RESERVATION_FAILED');
    require('../../utils/logger').info({event:'source_verification_outcome',outcome:code?policy.classify(code,status):'passed',attempt:old.attempts,httpStatus:status||null,errorCode:code||null});
    }finally{await require('../sourceVerificationCircuit.service').finish(probe,code,status).catch(()=>require('../../utils/logger').warn({event:'source_verification_circuit_update_failed'}));probe=null;}
  },
  // Adds review flags (for example the second reader's differences) to accepted evidence. Flags only: the canonical
  // evidence ('payload.primary') is never touched here.
  async annotate(id,patch){
    const $set=Object.fromEntries(Object.entries(patch||{}).map(([key,value])=>[`payload.review.${key}`,value]));
    if(Object.keys($set).length)await Evidence.updateOne({_id:id,status:'GPT_SOURCE_ACCEPTED'},{$set});
  }
};}
function ui(error){
  if(!error)return {sourceReadStatus:'PASSED',canSubmit:true,message:'The handwriting can be read for assessment.'};
  const code=/^OCR_[A-Z0-9_]{1,90}$/.test(error.code||'')?error.code:'OCR_GPT_PROVIDER_FAILED';
  if(code==='OCR_GPT_SOURCE_CHECKING')return {sourceReadStatus:'CHECKING',canSubmit:false,sourceReadErrorCode:code,message:'We are checking whether the handwriting can be read accurately.'};
  if(['OCR_GPT_SOURCE_TRUNCATED','OCR_GPT_SOURCE_SCHEMA','OCR_GPT_SOURCE_TRANSCRIPT_MISMATCH'].includes(code))return {sourceReadStatus:'FAILED_SERVICE',canSubmit:false,sourceReadErrorCode:code,message:RETRY_MESSAGE};
  const image=['OCR_GPT_SOURCE_UNCERTAIN','OCR_GPT_SOURCE_EMPTY','OCR_PDF_INVALID','OCR_PDF_PASSWORD','OCR_PDF_LIMIT'].includes(code);
  return {sourceReadStatus:image?'FAILED_IMAGE':'FAILED_SERVICE',canSubmit:false,sourceReadErrorCode:code,message:image?IMAGE_MESSAGE:SERVICE_MESSAGE};
}
function withSourceCheck(basic,state){return {...basic,basicChecksPassed:basic.ready,sourceReadRequired:true,...state,ready:basic.ready&&state.canSubmit,
  checks:[...basic.checks,{id:'handwritingReadability',label:'Handwriting readability',required:true,
    status:state.sourceReadStatus==='PASSED'?'pass':state.sourceReadStatus==='CHECKING'?'checking':state.sourceReadStatus==='FAILED_IMAGE'?'fail':'unavailable',message:state.message}]};}
async function checkPages(pages,context,{run=false,env=process.env,signal,deadlineAt,onObservation}={}){
  const bindings=[];
  for(const page of pages){
    if(signal?.aborted)throw fail(signal.reason==='source_user_cancelled'?'OCR_GPT_SOURCE_CANCELLED':'OCR_GPT_PROVIDER_NETWORK');
    const bound=binding(context,page,env);bindings.push(bound);
    if(!run){
      const own=await find(bound.key);
      if(!(own?.status==='GPT_SOURCE_ACCEPTED'&&sameBinding(own.identity,bound)&&own.payload?.primary)){
        const carried=await carriedEvidence(context,page,bound,env);
        if(carried){validate(JSON.stringify(carried.payload.primary));bindings[bindings.length-1]=carried.identity;continue;}
      }
    }
    // Do not purchase a page read with too little request time to give it its full attempt budget.
    // Already accepted PDF pages remain reusable, so a later explicit retry resumes safely.
    if(run&&Number.isFinite(deadlineAt)&&Date.now()+([QWEN_MODEL,GEMINI_MODEL].includes(bound.model)?require('./contract').requestPolicy(env).attemptTimeoutMs:180000)>deadlineAt){
      const saved=await find(bound.key);
      if(saved?.status!=='GPT_SOURCE_ACCEPTED'||!sameBinding(saved.identity,bound)||!saved.payload?.primary)throw fail('OCR_GPT_PROVIDER_NETWORK');
    }
    if(run)await require('../gptVisionExact.service').readPage({bytes:page.bytes,mimeType:page.mimeType,assignment:context.assignment,
      identity:{submissionId:'preflight',fileId:page.sourceSha256,pageNumber:page.pageNumber,sourceSha256:page.sourceSha256,
        width:page.width,height:page.height,sourceImagePrepareMs:page.sourceImagePrepareMs},env,signal,onObservation,reservation:reservationFor(bound,onObservation)});
    const saved=await find(bound.key);
    if(saved?.status!=='GPT_SOURCE_ACCEPTED'||!sameBinding(saved.identity,bound)||!saved.payload?.primary){
      if(saved?.status==='GPT_SOURCE_FAILED')throw fail(saved.payload?.safeFailureCode||'OCR_GPT_PROVIDER_FAILED');
      throw fail(saved?.status==='GPT_SOURCE_RESERVED'?'OCR_GPT_SOURCE_CHECKING':'OCR_GPT_SOURCE_PREFLIGHT_REQUIRED');
    }
    validate(JSON.stringify(saved.payload.primary));
  }
  return {ownerId:String(context.ownerId),uploaderId:String(context.uploaderId),assignmentId:String(context.assignment._id),bindings};
}
function claimReservation(file,identity){return {
  async acquire(bound){
    const proof=file.gptSourcePreflight,claim=proof?.bindings?.find(p=>p.pageNumber===bound.pageNumber);
    if(!claim||String(file.uploadedBy)!==proof.uploaderId||String(identity.assignmentId)!==proof.assignmentId
      ||identity.studentId&&String(identity.studentId)!==proof.ownerId
      ||claim.sourceMode!=='gpt_vision_exact'||claim.version!==VERSION||!claimModelAccepted(claim.model,bound.model)
      // Same model: the usual prompt identity. The previously approved model (switch or rollback): the stored assignment text
      // must be unchanged, which the reader-independent legacy hash proves.
      ||!(claim.model===bound.model?sameSourcePrompt(claim,bound):Boolean(claim.legacyPromptSha256)&&claim.legacyPromptSha256===bound.legacyPromptSha256)
      ||claim.sourceSha256!==bound.sourceSha256||claim.inputSha256!==bound.inputSha256)throw fail('OCR_GPT_SOURCE_PREFLIGHT_REQUIRED');
    const old=await find(claim.key);
    if(old?.status!=='GPT_SOURCE_ACCEPTED'||!old.payload?.primary||!sameBinding(old.identity,claim)||old.identity.ownerId!==proof.ownerId||old.identity.assignmentId!==proof.assignmentId)throw fail('OCR_GPT_SOURCE_PREFLIGHT_REQUIRED');
    validate(JSON.stringify(old.payload.primary));
    const attached=await Evidence.updateOne({_id:claim.key,status:'GPT_SOURCE_ACCEPTED'},{$addToSet:{'payload.claims':{submissionId:identity.submissionId,fileId:bound.fileId,runId:identity.runId,pageNumber:bound.pageNumber}}});
    if(!attached.matchedCount)throw fail('OCR_GPT_SOURCE_PREFLIGHT_REQUIRED');
    return {_id:claim.key,cached:true,evidence:old};
  },
  async complete(){throw fail('OCR_GPT_SOURCE_PREFLIGHT_REQUIRED');}
};}
module.exports={binding,pagesFor,reservationFor,checkPages,claimReservation,ui,withSourceCheck,IMAGE_MESSAGE,SERVICE_MESSAGE,RETRY_MESSAGE};
