'use strict';
// One prepared page, independent readers. Model agreement is NOT human verification.
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const sha = value => createHash('sha256').update(value).digest('hex');
const PROMPT = fs.readFileSync(path.join(__dirname, 'sourceFidelity/forensic-prompt.txt'), 'utf8');
const VERSION = 'astra-fable-exact-v1';
const PAGE_SEPARATOR = '\n\n\f\n\n'; // Application page structure, never claimed as handwritten characters.
const TYPES = ['ACTIVE_STUDENT_TEXT','CROSSED_OUT_OR_DELETED','UNCERTAIN','NON_STUDENT_ARTIFACT'];
const closed = properties => ({ type:'object', properties, required:Object.keys(properties), additionalProperties:false });
const schema = closed({ activeTranscript:{type:'string'}, segments:{type:'array',items:closed({
  type:{type:'string',enum:TYPES},text:{type:['string','null']},confidence:{type:'number',description:'Visual reading confidence from 0 to 1. Confidence does not establish source truth.'},notes:{type:'string'} })},
  uncertainSpans:{type:'array',items:closed({visibleContext:{type:'string'},candidateReading:{type:['string','null']},reason:{type:'string'}})}
});
const fail = code => Object.assign(Error(code), { code, retryable:false });
function config(env=process.env) {
  if(env.OCR_SOURCE_MODE==='astra_human_confirm'){
    if(env.OCR_ASTRA_MODEL!=='openai/gpt-6-astra'||!env.OPENROUTER_API_KEY)throw fail('OCR_SOURCE_CONFIGURATION_INVALID');
    return {astra:env.OCR_ASTRA_MODEL};
  }
  if (env.OCR_ASTRA_MODEL !== 'openai/gpt-6-astra' || env.OCR_FABLE_MODEL !== 'anthropic/claude-fable-5.1'
      || !env.OPENROUTER_API_KEY) throw fail('OCR_SOURCE_CONFIGURATION_INVALID');
  return {astra:env.OCR_ASTRA_MODEL,fable:env.OCR_FABLE_MODEL};
}
const keys = (obj, wanted) => obj && typeof obj==='object' && !Array.isArray(obj)
  && Object.keys(obj).sort().join('|')===wanted.slice().sort().join('|');
function validate(content) {
  if(typeof content!=='string'||Buffer.byteLength(content)>180000) throw fail('OCR_SOURCE_SCHEMA');
  let v; try {v=JSON.parse(content);} catch {throw fail('OCR_SOURCE_SCHEMA');}
  if(!keys(v,['activeTranscript','segments','uncertainSpans'])||typeof v.activeTranscript!=='string'
    ||!Array.isArray(v.segments)||v.segments.length>1000||!Array.isArray(v.uncertainSpans)||v.uncertainSpans.length>1000) throw fail('OCR_SOURCE_SCHEMA');
  if(!v.activeTranscript.isWellFormed())throw fail('OCR_SOURCE_SCHEMA');
  for(const s of v.segments) if(!keys(s,['type','text','confidence','notes'])||!TYPES.includes(s.type)
    ||!(s.text===null||typeof s.text==='string')||typeof s.notes!=='string'||typeof s.confidence!=='number'
    ||!Number.isFinite(s.confidence)||s.confidence<0||s.confidence>1
    ||(s.type===TYPES[0]&&typeof s.text!=='string')) throw fail('OCR_SOURCE_SCHEMA');
  for(const s of v.uncertainSpans) if(!keys(s,['visibleContext','candidateReading','reason'])||typeof s.visibleContext!=='string'
    ||!(s.candidateReading===null||typeof s.candidateReading==='string')||typeof s.reason!=='string') throw fail('OCR_SOURCE_SCHEMA');
  if(v.activeTranscript!==v.segments.filter(s=>s.type===TYPES[0]).map(s=>s.text).join('\n')) throw fail('OCR_SOURCE_TRANSCRIPT_MISMATCH');
  return v; // Never trim, repair, or normalize decoded strings.
}
function compare(a,b) {
  if(a===b)return [];
  // Bounded diagnostics, not an authority or fuzzy alignment algorithm.
  const types=[];
  if(a.toLowerCase()===b.toLowerCase())types.push('CAPITALIZATION_ONLY');
  else if(a.replace(/\s/gu,'')===b.replace(/\s/gu,''))types.push('WHITESPACE');
  else if(a.replace(/[\p{P}\p{S}]/gu,'')===b.replace(/[\p{P}\p{S}]/gu,''))types.push('PUNCTUATION');
  else if(a.length!==b.length)types.push('INSERTION_DELETION','SPELLING_LEXICAL');
  else types.push('SPELLING_LEXICAL');
  let start=0;while(start<Math.min(a.length,b.length)&&a[start]===b[start])start++;
  return types.map(category=>({category,start}));
}
let active=0; const queue=[];
async function slot(run,signal) {
  // Two pages maximum in flight, two readers per page. Existing file/page workers also remain bounded.
  if(signal?.aborted)throw fail('OCR_SOURCE_CANCELLED');
  if(active<2)active++;
  else await new Promise((resolve,reject)=>{
    const entry={resolve:()=>{clearTimeout(entry.timer);signal?.removeEventListener('abort',entry.abort);resolve();}};
    entry.abort=()=>{const i=queue.indexOf(entry);if(i>=0)queue.splice(i,1);clearTimeout(entry.timer);reject(fail('OCR_SOURCE_CANCELLED'));};
    entry.timer=setTimeout(entry.abort,180000);signal?.addEventListener('abort',entry.abort,{once:true});queue.push(entry);
  });
  try{if(signal?.aborted)throw fail('OCR_SOURCE_CANCELLED');return await run();}
  finally{const next=queue.shift();if(next)next.resolve();else active--;}
}
function readerMessages({bytes,mimeType,prompt,targeted=false,images,magnifiedFocus=false}){
  if(images&&(!targeted||!Array.isArray(images)||images.length!==2||images.some(i=>!Buffer.isBuffer(i.bytes)||!i.bytes.length||i.bytes.length>20*1024*1024||i.mimeType!=='image/png')))throw fail('OCR_SOURCE_IMAGE_INVALID');
  return [{role:'system',content:prompt},{role:'user',content:[{type:'text',text:images&&magnifiedFocus?'Transcribe the shared target handwriting row from line context and an enlarged view of the same region. Enlargement contains no new or corrected information. Follow the shared forensic instruction and strict segment contract.':images?'Transcribe the shared target handwriting row from the two original-pixel views under the shared forensic instruction and strict segment contract.':targeted?'Transcribe only this crop under the shared forensic instruction and strict segment contract.':'Transcribe the original handwritten page under the shared forensic instruction and strict segment contract.'},
    ...(images||[{bytes,mimeType}]).map(i=>({type:'image_url',image_url:{url:`data:${i.mimeType};base64,${i.bytes.toString('base64')}`}}))]}];
}
async function reader({model,bytes,mimeType,prompt,signal,env,targeted=false,images,magnifiedFocus=false,fetchImpl=global.fetch,onDiagnostic}) {
  let result;
  try{result=await require('./aiGateway.service').providerAttempt({entry:{provider:'openrouter',model},
    messages:readerMessages({bytes,mimeType,prompt,targeted,images,magnifiedFocus}),
    maxOutputTokens:12000,responseFormat:'json',responseSchema:schema,schemaName:'forensic_handwriting_source_v1',
    attemptTimeoutMs:180000,fetchImpl,env,now:Date.now,signal,requestProfile:'source_fidelity_v1',onDiagnostic});
  }catch(error){
    if(targeted)error.sourceReaderDiagnostic={validationStatus:'NOT_REACHED',failureCode:/^[A-Z][A-Z0-9_]{0,79}$/.test(error.code||'')?error.code:'SOURCE_READER_REJECTED'};
    throw error;
  }
  try{return {value:validate(result.content),returnedModel:result.returnedModel,usage:safeUsage(result.usage),durationMs:result.durationMs};}
  catch(error){
    // Observability only: preserve known usage on schema rejection, without accepting text or logging output.
    if(typeof onDiagnostic==='function')try{onDiagnostic({failureStage:error.code==='OCR_SOURCE_TRANSCRIPT_MISMATCH'?'SOURCE_CONTRACT_VALIDATION':'JSON_OR_SCHEMA_VALIDATION',
      safeCode:error.code,returnedModel:result.returnedModel,httpStatus:null,responseReceived:true,bodyRead:true});}catch{/* Diagnostics never change acceptance. */}
    if(targeted)error.sourceReaderDiagnostic={validationStatus:'FAILED',failureCode:error.code,
      returnedModel:result.returnedModel,usage:safeUsage(result.usage),durationMs:result.durationMs};
    throw error;
  }
}
function safeUsage(usage) {
  return Object.fromEntries(['prompt_tokens','completion_tokens','total_tokens','cost','thoughts_tokens']
    .filter(k=>Number.isFinite(usage?.[k])).map(k=>[k,usage[k]]));
}
async function storeEvidence(value) { await require('../models/SourceFidelityEvidence').create(value); }
async function readPage({bytes,mimeType,identity,google,isCurrentJob=async()=>true,signal,env=process.env,
  reader:read=reader,persistEvidence=storeEvidence,targetedBudget,targetedCropper}) {
  const models=config(env);
  const humanConfirm=env.OCR_SOURCE_MODE==='astra_human_confirm';
  const targetedMode=!humanConfirm&&require('./sourceFidelity/targetedVerification').enabled(env);
  const targetedVersion=env.OCR_SOURCE_VERIFICATION_MODE==='targeted_v4'?'targeted-source-v4':env.OCR_SOURCE_VERIFICATION_MODE==='targeted_v3'?'targeted-source-v3':'targeted-source-v2';
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>20*1024*1024||!['image/jpeg','image/png','image/webp'].includes(mimeType))throw fail('OCR_SOURCE_IMAGE_INVALID');
  const actualMime=bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'image/jpeg':bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))?'image/png'
    :bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'?'image/webp':null;
  if(actualMime!==mimeType)throw fail('OCR_SOURCE_IMAGE_MIME_MISMATCH');
  return slot(async()=>{
    if(signal?.aborted||!(await isCurrentJob()))throw fail('OCR_JOB_SUPERSEDED');
    const inputSha256=sha(bytes),promptSha256=sha(PROMPT);
    const started=Date.now();
    if(humanConfirm){
      // One full-page attempt. No independent reader, layout call or paid retry.
      let result=null,a=null;
      let diagnostic=null;
      const attempt=persistEvidence===storeEvidence?await require('./sourceFidelity/urgentAttempt').acquire({...identity,inputSha256,promptSha256,mimeType}):null;
      try{result=attempt?.cached?{value:attempt.evidence.payload.primary,returnedModel:models.astra}:await read({role:'astra',model:models.astra,bytes,mimeType,prompt:PROMPT,schema,maxCompletionTokens:12000,signal,env,targeted:false,
        ...(['development','test'].includes(env.NODE_ENV)?{onDiagnostic:d=>{diagnostic=d;}}:{})});
        if(result.returnedModel!==models.astra)throw fail('OCR_SOURCE_MODEL_IDENTITY');
        a=validate(JSON.stringify(result.value));
      }catch(error){
        if(['development','test'].includes(env.NODE_ENV)){
          const safeCode=v=>typeof v==='string'&&/^(AI_|OCR_)[A-Z0-9_]{1,75}$/.test(v)?v:null;
          const safeModel=v=>typeof v==='string'&&v.length<=120&&/^[a-z0-9_.-]+\/[a-z0-9_.:-]+$/.test(v)?v:null;
          const httpStatus=Number.isInteger(diagnostic?.httpStatus)&&diagnostic.httpStatus>=100&&diagnostic.httpStatus<=599?diagnostic.httpStatus:null;
          const stages=['REQUEST_BUILD_FAILURE','TRANSPORT_FAILURE','REQUEST_ABORTED','HTTP_ERROR_RESPONSE','RESPONSE_BODY_READ_FAILURE','RESPONSE_JSON_PARSE_FAILURE','PROVIDER_RESPONSE_SHAPE_INVALID','JSON_OR_SCHEMA_VALIDATION','SOURCE_CONTRACT_VALIDATION'];
          const validationStage=error.code==='OCR_SOURCE_MODEL_IDENTITY'?'MODEL_IDENTITY_VALIDATION':error.code==='OCR_SOURCE_TRANSCRIPT_MISMATCH'?'SOURCE_CONTRACT_VALIDATION':error.code==='OCR_SOURCE_SCHEMA'?'JSON_OR_SCHEMA_VALIDATION':stages.includes(diagnostic?.failureStage)?diagnostic.failureStage:null;
          require('../utils/logger').info({event:'source_fidelity_reader_failure',requestedModel:models.astra,
            returnedModel:safeModel(result?.returnedModel||diagnostic?.returnedModel),httpStatus,
            transportOutcome:httpStatus!==null?(httpStatus>=200&&httpStatus<300?'HTTP_SUCCESS':'HTTP_FAILED'):diagnostic?.responseReceived?'HTTP_RESPONSE_RECEIVED':diagnostic?.responseReceived===false?'NO_HTTP_RESPONSE':'UNKNOWN',
            validationStage,safeFailureCode:safeCode(error.code)||safeCode(diagnostic?.safeCode),durationMs:Date.now()-started});
        }
        if(signal?.aborted||error.code==='OCR_JOB_SUPERSEDED')throw error;
      }
      if(signal?.aborted||!(await isCurrentJob()))throw fail('OCR_JOB_SUPERSEDED');
      const status=a?'ASTRA_PROVISIONAL':'PROVIDER_FAILED',text=a?.activeTranscript??'';
      const source={sourceTextExact:text,sourceTextSha256:sha(text),sourceFidelityStatus:status,sourceFidelityMode:'astra_human_confirm',
        sourcePrimaryProvider:'openrouter',sourcePrimaryModel:models.astra,sourceDisagreementCount:0,sourceInputSha256:inputSha256,
        sourceFidelityVersion:'astra-human-confirm-v1',sourceVerificationStage:status,sourceMimeType:mimeType,
        sourceSha256:identity.sourceSha256,ocrInputSha256:inputSha256,
        sourceUncertainSpans:a?[...a.uncertainSpans,...a.segments.filter(s=>s.type==='UNCERTAIN').map(s=>({visibleContext:s.text,reason:s.notes}))]:[]};
      const evidence={identity:{...identity,inputSha256,promptSha256,mimeType},status,
        payload:{primary:a,secondary:null,differences:[],readers:[{requestedModel:models.astra,returnedModel:result?.returnedModel||null,
          usage:safeUsage(result?.usage),durationMs:result?.durationMs??null}]}};
      if(!attempt)await persistEvidence(evidence);
      else if(!attempt.cached)await require('./sourceFidelity/urgentAttempt').complete(attempt._id,evidence);
      require('../utils/logger').info({event:'source_fidelity_page',status,sourceMode:'astra_human_confirm',providerCallCount:attempt?.cached?0:1,
        pageNumber:identity.pageNumber,inputSha256,durationMs:Date.now()-started});
      return {fullText:text,transcriptText:text,words:[],pages:[{pageNumber:identity.pageNumber||1,words:[]}],source};
    }
    const results=await Promise.allSettled([google(),...['astra','fable'].map(role=>read({role,model:models[role],bytes,mimeType,
      prompt:PROMPT,schema,maxCompletionTokens:12000,signal,env}))]);
    if(signal?.aborted||!(await isCurrentJob()))throw fail('OCR_JOB_SUPERSEDED');
    const parsed=results.slice(1).map((r,i)=>{try{
      if(r.status!=='fulfilled')return null;
      if(r.value.returnedModel&&r.value.returnedModel!==models[i===0?'astra':'fable'])return null;
      return validate(JSON.stringify(r.value.value));
    }catch{return null;}});
    const [a,b]=parsed, g=results[0].status==='fulfilled'?results[0].value:null;
    const differences=a&&b?compare(a.activeTranscript,b.activeTranscript):[];
    // Require the same ordered classification/text signature. Notes/confidence are never votes.
    const signature=v=>JSON.stringify(v.segments.map(s=>({type:s.type,text:s.text})));
    if(a&&b&&signature(a)!==signature(b))differences.push({category:'SEGMENT_CLASSIFICATION_OR_TEXT'});
    const native=g?.[require('./hybridSource/shadow').rawEvidence];
    const hasGeometry=Boolean(g?.pages?.length===1&&g?.words?.length&&g.words.every(w=>w.bbox&&Object.values(w.bbox).every(Number.isFinite))
      &&(!native||native.every(p=>p.dimensionsMatch===true)));
    let status=!a?'PROVIDER_FAILED':!a.activeTranscript.trim()?'SOURCE_UNREADABLE':'MODEL_AGREED';
    if(a&&(!b||!hasGeometry||differences.length||a.uncertainSpans.length||b?.uncertainSpans.length
      ||a.segments.some(s=>s.type==='UNCERTAIN')||b?.segments.some(s=>s.type==='UNCERTAIN')))status='OCR_UNCERTAIN';
    let targeted;
    if(targetedMode&&a&&b&&hasGeometry&&native?.[0]){
      try{
        targeted=await require('./sourceFidelity/targetedVerification').verify({bytes,identity:{...identity,inputSha256},
          google:native[0],astra:a,fable:b,firstPassStatus:status,read,env,signal,isCurrentJob,budget:targetedBudget,cropper:targetedCropper});
      }catch(error){
        if(signal?.aborted||error?.code==='OCR_JOB_SUPERSEDED')throw fail('OCR_JOB_SUPERSEDED');
        targeted={version:targetedVersion,firstPassStatus:status,status:'OCR_UNCERTAIN',stage:'OCR_UNCERTAIN',text:a.activeTranscript,
          failureCode:'OCR_TARGETED_PLANNING_FAILED',summary:{firstPassStatus:status,candidateRegionCount:0,candidateReasons:[],
            targetedRegionCount:0,resolvedTargetedCount:0,unresolvedTargetedCount:1,finalSourceStatus:'OCR_UNCERTAIN',readers:[]}};
      }
      status=targeted.status;
      require('../utils/logger').info({event:targetedVersion==='targeted-source-v4'?'source_fidelity_targeted_v4':targetedVersion==='targeted-source-v3'?'source_fidelity_targeted_v3':'source_fidelity_targeted_v2',pageNumber:identity.pageNumber,...targeted.summary});
    }else if(targetedMode){
      // A missing first-pass reader/layout is never replaced by a targeted crop.
      if(a)status='OCR_UNCERTAIN';
      require('../utils/logger').info({event:targetedVersion==='targeted-source-v4'?'source_fidelity_targeted_v4':targetedVersion==='targeted-source-v3'?'source_fidelity_targeted_v3':'source_fidelity_targeted_v2',firstPassStatus:status,pageNumber:identity.pageNumber,
        candidateRegionCount:0,targetedRegionCount:0,resolvedTargetedCount:0,unresolvedTargetedCount:1,finalSourceStatus:status});
    }
    if(targetedMode&&(signal?.aborted||!(await isCurrentJob())))throw fail('OCR_JOB_SUPERSEDED');
    const exactText=targeted?.text??a?.activeTranscript??'';
    const source={sourceTextExact:exactText,sourceTextSha256:sha(exactText),
      sourceFidelityStatus:status,sourceFidelityMode:'astra_verified',sourcePrimaryProvider:'openrouter',sourcePrimaryModel:models.astra,
      sourceSecondaryProvider:'openrouter',sourceSecondaryModel:models.fable,sourceDisagreementCount:differences.length,
      sourceInputSha256:inputSha256,sourceFidelityVersion:targetedMode?targetedVersion:VERSION,sourceMimeType:mimeType,
      ...(targetedMode?{sourceVerificationStage:targeted?.stage||'OCR_UNCERTAIN',sourceVerificationSummary:targeted
        ?Object.fromEntries(['candidateRegionCount','targetedRegionCount','resolvedTargetedCount','unresolvedTargetedCount','candidateReasons']
          .map(key=>[key,targeted.summary[key]])):{candidateRegionCount:0,unresolvedTargetedCount:1,candidateReasons:[]}}:{}),
      sourceSha256:identity.sourceSha256,ocrInputSha256:inputSha256};
    // Private bounded, allowlisted evidence only. Never persist headers, keys, image bytes or provider errors.
    await persistEvidence({identity:{...identity,inputSha256,promptSha256,mimeType},status,
      payload:{primary:a,secondary:b,differences,...(targeted?{targeted}:{}),google:{wordCount:g?.words?.length||0,
        nativePages:native?.slice(0,1).map(p=>({...p,words:p.words.slice(0,2000).map(w=>({...w,symbols:w.symbols.slice(0,200)}))}))},
        readers:results.slice(1).map((r,i)=>({requestedModel:models[i===0?'astra':'fable'],
          returnedModel:r.status==='fulfilled'?r.value.returnedModel||null:null,
          usage:r.status==='fulfilled'?safeUsage(r.value.usage):{},durationMs:r.status==='fulfilled'?r.value.durationMs:null}))}});
    require('../utils/logger').info({event:'source_fidelity_page',status,providerCallCount:2,models:Object.values(models),
      sourceMode:'astra_verified',submissionId:identity.submissionId,jobId:identity.runId,pageNumber:identity.pageNumber,
      googleGeometryAvailable:hasGeometry,
      durationMs:Date.now()-started,inputSha256,disagreementCount:differences.length,
      readers:results.slice(1).map((r,i)=>({model:models[i===0?'astra':'fable'],
        usage:r.status==='fulfilled'?safeUsage(r.value.usage):{},latencyMs:r.status==='fulfilled'?r.value.durationMs:null}))});
    return {fullText:source.sourceTextExact,transcriptText:source.sourceTextExact,words:g?.words||[],
      pages:g?.pages?.length?g.pages:[{pageNumber:identity.pageNumber||1,words:[]}],source};
  },signal);
}
module.exports={sha,VERSION,PAGE_SEPARATOR,PROMPT,schema,config,validate,compare,readPage,safeUsage,reader,readerMessages};
