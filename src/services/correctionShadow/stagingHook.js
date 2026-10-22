'use strict';
// Staging-only seam after normal persisted OCR/corrections. No provider import/default.
const pipeline=require('./pipeline');
const review=require('./verifier');
const store=require('./privateReview');
const {digest,polygonValid}=require('../hybridSource/reconcile');
const events=[];const pending=new Set(),responses=new Map();let configured=null;
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
function enabled(env=process.env){return pipeline.mode(env)==='shadow_v15';}
function emit(event,identity,detail={}){const item={event,identityKey:identity?digest(JSON.stringify(identity)):null,at:new Date().toISOString(),...detail};events.push(item);if(events.length>128)events.shift();return item;}
function snapshotCompleted({submissionId,runId,status,pages,assignment={},failures=[]}){
 if(status!=='completed'||!runId||failures.length||!Array.isArray(pages)||!pages.length||pages.length>20)throw Error('COMPLETED_SOURCE_REQUIRED');
 const selected={title:assignment.title||'',description:assignment.description||assignment.instructions||'',rubric:assignment.rubric||null,rubrics:assignment.rubrics||null};
 if(Buffer.byteLength(JSON.stringify(selected))>40000)throw Error('SHADOW_CONTEXT_LIMIT');
 return freeze(pages.map(p=>{
  const id=review.identity({submissionId:String(submissionId),fileId:String(p.fileId?._id||p.fileId||''),runId:String(runId),pageNumber:p.pageNumber,sourceSha256:p.sourceSha256,inputSha256:p.ocrInputSha256,width:p.width,height:p.height,orientation:p.ocrExifOrientation});
  if(p.ocrRunId!==runId||typeof p.text!=='string'||!p.text.trim()||p.text.length>100000||(p.transcriptHash!==undefined&&p.transcriptHash!==digest(p.text)))throw Error('SHADOW_PAGE_SOURCE_INVALID');
  const nativeWords=(p.words||[]).map(w=>{
   if(typeof w.id!=='string'||!w.id.startsWith(`word_${id.fileId}_${id.pageNumber}_`))throw Error('SHADOW_FOREIGN_WORD');
   return {id:w.id,text:String(w.text||''),...(w.bbox?{bbox:{x0:w.bbox.x0,y0:w.bbox.y0,x1:w.bbox.x1,y1:w.bbox.y1}}:{}),...(polygonValid(w.polygon,id)?{polygon:w.polygon.map(v=>({x:v.x,y:v.y}))}:{})};
  });
  // Stored OCR boxes are retained as boxes. Never invent native polygons or independent source trust.
  return {identity:id,sources:{legacy:{identity:{...id},transcript:p.text,transcriptHash:digest(p.text)}},analysisSource:'legacy',assignment:JSON.parse(JSON.stringify(selected)),evidence:{nativeWords,bindings:[],attestations:[]}};
 }));
}

function trackResponse(submissionId,runId,response,env=process.env){
 if(!enabled(env))return;
 const begin=performance.now();
 try {
 if(!response||typeof response.once!=='function')throw Error('boundary');
 const key=String(submissionId)+':'+String(runId);
 if(responses.size>=128){const old=[...responses].find(([,v])=>v.settled);if(old)responses.delete(old[0]);else{emit('SKIPPED',null,{reason:'RESPONSE_ADMISSION_LIMIT'});return;}}
 let resolve;const entry={settled:false,promise:new Promise(r=>resolve=r)};responses.set(key,entry);
 let timer;const settle=ok=>{if(entry.settled)return;entry.settled=true;clearTimeout(timer);response.removeListener?.('finish',finished);response.removeListener?.('close',closed);resolve(ok);};
 const finished=()=>settle(true),closed=()=>settle(response.writableFinished===true);
 if(response.writableFinished)settle(true);else{response.once('finish',finished);response.once('close',closed);timer=setTimeout(()=>settle(false),30000);timer.unref?.();}
 emit('RESPONSE_GATE_OVERHEAD',null,{durationMs:performance.now()-begin});
 } catch {emit('SKIPPED',null,{reason:'RESPONSE_BOUNDARY_FAILED'});}
}

function repository(page){
 const Submission=require('../../models/Submission'),Evidence=require('../../models/CorrectionShadowReview');
 const base=store.repository({Submission,Evidence}),id=page.identity,text=page.sources.legacy.transcript;
 const query={_id:id.submissionId,ocrJobId:id.runId,ocrStatus:'completed',$or:[{files:id.fileId},{file:id.fileId}],ocrPages:{$elemMatch:{fileId:id.fileId,pageNumber:id.pageNumber,ocrRunId:id.runId,sourceSha256:id.sourceSha256,ocrInputSha256:id.inputSha256,width:id.width,height:id.height,ocrExifOrientation:id.orientation,text}}};
 const isCurrent=async()=>Boolean(await Submission.exists(query).maxTimeMS(3000));
 return {isCurrent,save:async artifact=>{if(!await isCurrent()){emit('STALE',id);return;}await base.save(artifact);}};
}
function configureStagingAdapters(options,env=process.env){
 if(!enabled(env))throw Error('STAGING_CONFIGURATION_REQUIRED');
 if(options?.verify)throw Error('VERIFIER_NOT_CONNECTED_IN_PHASE6');
 if(options&&typeof options.generate!=='function')throw Error('EXPLICIT_GENERATOR_REQUIRED');
 if(options)review.registry(options.reviewers||[],options.generator);
 configured=options?{...options}:null;
}
function observeCompleted(pages,{env=process.env,adapters=configured,repositoryFactory=repository,requireResponseBoundary=false}={}){
 if(!enabled(env))return {scheduled:false,reason:'LEGACY_MODE'};
 if(requireResponseBoundary){
  const first=pages?.[0]?.identity,key=first?first.submissionId+':'+first.runId:'';
  const gate=responses.get(key);if(!gate){emit('SKIPPED',first,{reason:'RESPONSE_BOUNDARY_UNAVAILABLE'});return {scheduled:false};}
  responses.delete(key);
  const deferred=gate.promise.then(ok=>{if(ok)observeCompleted(pages,{env,adapters,repositoryFactory});else emit('SKIPPED',first,{reason:'RESPONSE_NOT_COMPLETED'});}).finally(()=>pending.delete(deferred));pending.add(deferred);
  return {scheduled:true,reason:'AFTER_RESPONSE_FINISH'};
 }
 const started=performance.now();let copy,admitted=0;
 try{copy=JSON.parse(JSON.stringify(pages));if(!Array.isArray(copy)||copy.length>20)throw Error('limit');}catch{emit('SKIPPED',null,{reason:'INVALID_SNAPSHOT'});return {scheduled:false};}
 for(const page of copy){
  const id=page.identity;let task;
  try{
   review.identity(id);if(page.sources.legacy.transcriptHash!==digest(page.sources.legacy.transcript))throw Error('hash');
   const repo=repositoryFactory(page);
   if(!adapters?.generate){
    emit('GENERATOR_MISSING',id);
    task=new Promise(resolve=>setImmediate(resolve)).then(async()=>{if(enabled(env)&&await repo.isCurrent(id))await repo.save({version:'correction-staging-hook-v1',identity:id,status:'GENERATOR_NOT_CONFIGURED',errorCode:'GENERATOR_NOT_CONFIGURED',publishable:false,studentVisible:false,scoreMutation:false});}).catch(()=>emit('PRIVATE_WRITE_FAILED',id));
   }else{
    let cause=null;
    const generate=async(input,{signal})=>{
     const onAbort=()=>{cause='TIMED_OUT';emit('TIMED_OUT',id);};signal?.addEventListener('abort',onAbort,{once:true});
     try{return await adapters.generate(input,{signal});}catch{if(!cause){cause='GENERATOR_FAILED';emit('GENERATOR_FAILED',id);}throw Error('SHADOW_GENERATOR_FAILED');}finally{signal?.removeEventListener('abort',onAbort);}
    };
    const handle=pipeline.scheduleAfterUpload(freeze(page),{generator:adapters.generator,generate,reviewers:adapters.reviewers||[],receipts:adapters.receipts||[],timeoutMs:adapters.timeoutMs,
     isCurrent:async()=>{const current=enabled(env)&&await repo.isCurrent(id);if(!current)emit(enabled(env)?'STALE':'SKIPPED',id);return current;},
     save:async artifact=>{
      try{if(!enabled(env)||!await repo.isCurrent(id)){emit(enabled(env)?'STALE':'SKIPPED',id);return;}await repo.save(artifact);emit(artifact.status==='SHADOW_UNAVAILABLE'?(cause||'GENERATOR_FAILED'):'COMPLETED',id);}catch{emit('PRIVATE_WRITE_FAILED',id);throw Error('PRIVATE_SHADOW_WRITE_FAILED');}
     }},env);
    if(!handle.scheduled){emit('SKIPPED',id,{reason:handle.reason});continue;}
    emit('SCHEDULED',id);task=handle.completion;
   }
   admitted++;pending.add(task);task.finally(()=>pending.delete(task)).catch(()=>undefined);
  }catch{emit('SKIPPED',id,{reason:'INVALID_OR_UNAVAILABLE_SOURCE'});}
 }
 const schedulingMs=performance.now()-started;emit('SCHEDULING_OVERHEAD',null,{schedulingMs});return {scheduled:admitted>0,schedulingMs};
}
async function waitForIdle(){while(pending.size)await Promise.allSettled([...pending]);}
module.exports={trackResponse,recordHookOverhead:durationMs=>{if(Number.isFinite(durationMs)&&durationMs>=0)emit('HOOK_OVERHEAD',null,{durationMs});},recordSkipped:()=>emit('SKIPPED',null,{reason:'INCOMPLETE_OR_INVALID_SOURCE'}),enabled,snapshotCompleted,observeCompleted,configureStagingAdapters,waitForIdle,diagnostics:()=>events.map(e=>({...e})),clearDiagnostics:()=>{events.length=0;},repository};
