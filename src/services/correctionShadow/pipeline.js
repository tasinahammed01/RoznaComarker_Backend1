'use strict';
// No default provider, public endpoint, Submission writer or scoring/PDF writer.
const layer=require('../correctionOperativeAuthority.service');
const review=require('./verifier');
const {digest}=require('../hybridSource/reconcile');
const VERSION='correction-shadow-pipeline-v1';
const inFlight=new Map(),activeWork=new Set();
function mode(env=process.env){return env.CORRECTION_PIPELINE_MODE==='shadow_v15'&&env.NODE_ENV==='staging'?'shadow_v15':'legacy';}
function source(value,pageIdentity,label){
 if(!value)return null;
 const id=review.identity(value.identity);
 if(JSON.stringify(id)!==JSON.stringify(pageIdentity)||typeof value.transcript!=='string'||value.transcript.length>100000||value.transcriptHash!==digest(value.transcript))throw Error('SHADOW_SOURCE_IDENTITY_INVALID');
 return {identity:id,transcript:value.transcript,transcriptHash:value.transcriptHash,label};
}
async function runPage(page,deps={}){
 const id=review.identity(page.identity),legacy=source(page.sources?.legacy,id,'PRODUCTION_LEGACY'),hybrid=source(page.sources?.hybrid,id,'SHADOW_HYBRID'),human=source(page.sources?.human,id,'HUMAN_REVIEW_DRAFT');
 if(!legacy)throw Error('LEGACY_SOURCE_REQUIRED');
 const sources={legacy,hybrid,human},selected=page.analysisSource||'legacy';if(!sources[selected])throw Error('EXPLICIT_SOURCE_REQUIRED');
 // Input cloning prevents injected adapters from acquiring a live Submission/document reference.
 const selectedSource=sources[selected],assignment=page.assignment||{};
 const input=JSON.parse(JSON.stringify({identity:id,transcript:selectedSource.transcript,transcriptHash:selectedSource.transcriptHash,assignment}));
 if(Buffer.byteLength(JSON.stringify(input))>160000)throw Error('SHADOW_INPUT_LIMIT');
 let content=page.savedCompletion;
 if(typeof content!=='string'){
  if(typeof deps.generate!=='function')throw Error('EXPLICIT_SHADOW_GENERATOR_REQUIRED');
  content=await deps.generate(JSON.parse(JSON.stringify(input)),{signal:deps.signal});
 }
 const analysis=layer.analyzeSaved(input,content),trusted=review.registry(deps.reviewers||[],deps.generator),rows=[];
 const evidence=JSON.parse(JSON.stringify(page.evidence||{}));
 for(const r of analysis.records){
  if(deps.signal?.aborted)throw Error('SHADOW_CANCELLED');
  const req=r.sourceLocator.valid?review.request(r,analysis,trusted.generator):null,receipts=req?(deps.receipts||[]).filter(x=>x.candidateKey===req.candidateKey).map(x=>review.receipt(x,req,trusted,x.reviewerKind)):[];
  // Receipt mismatch is explicit failure, never silently applied to another candidate.
  if(req&&typeof deps.verify==='function')receipts.push(await review.independentAdapter(req,trusted,deps.verify,{signal:deps.signal,reviewerId:deps.verifierId}));
  const semantic=req?review.bridge(r,analysis,req,receipts,trusted):{},authority=layer.authority(r,analysis,{...evidence,identity:id,transcript:input.transcript,...semantic});
  rows.push({index:r.index,candidateKey:req?.candidateKey||null,providerEvidenceQuote:r.providerEvidenceQuote,providerSuggestion:r.providerSuggestion,
   operativeEdit:r.operativeEdit,code:r.providerRecord.code,category:r.category,sourceLocator:r.sourceLocator,authority,receipts,
   withheldReasons:[...r.reasons,...(!authority.semanticCorrectionAuthority.sufficient?[authority.semanticCorrectionAuthority.reason]:[])],publishable:false,studentVisible:false,scoreMutation:false});
 }
 if((deps.receipts||[]).some(r=>!rows.some(c=>c.candidateKey===r.candidateKey)))throw Error('STALE_CANDIDATE_RECEIPT');
 const artifact={version:VERSION,identity:id,transcriptHash:input.transcriptHash,sourceMode:selected,sources,generator:{...trusted.generator,prompt:analysis.originalV15Analysis.promptVersion,schema:analysis.providerSchemaVersion,analysis:analysis.analysisVersion},
  status:'SHADOW_REVIEW_REQUIRED',rows,publishable:false,studentVisible:false,scoreMutation:false,markerPublication:false,pdfPublication:false};
 if(Buffer.byteLength(JSON.stringify(artifact))>1500000)throw Error('SHADOW_ARTIFACT_LIMIT');
 return {artifact,analysis};
}
function scheduleAfterUpload(page,deps={},env=process.env){
 if(mode(env)!=='shadow_v15')return {scheduled:false,reason:'LEGACY_MODE'};
 // One private detached task per current page/run; bounded concurrency, no retained upload buffers.
 let copy,key;try{copy=JSON.parse(JSON.stringify(page));const id=review.identity(copy.identity);key=digest(JSON.stringify(id));if(Buffer.byteLength(JSON.stringify(copy))>2000000)throw Error('limit');}catch{return {scheduled:false,reason:'SHADOW_INPUT_INVALID'};}
 if(inFlight.has(key)||activeWork.has(key)||inFlight.size>=2||activeWork.size>=2)return {scheduled:false,reason:'SHADOW_CAPACITY_OR_DUPLICATE'};
 if(typeof deps.save!=='function'||typeof deps.isCurrent!=='function')return {scheduled:false,reason:'EXPLICIT_PRIVATE_STORAGE_REQUIRED'};
 const controller=new AbortController();let timer;
 const current=async()=>{let cap;try{return Boolean(await Promise.race([Promise.resolve().then(()=>deps.isCurrent(copy.identity)),new Promise(resolve=>{cap=setTimeout(()=>resolve(false),3000);cap.unref?.();})]));}finally{clearTimeout(cap);}};
 const timeout=Math.min(45000,Math.max(10,deps.timeoutMs||45000));
 const task=new Promise(resolve=>setImmediate(resolve)).then(async()=>{
  const timeoutTask=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('SHADOW_TIMEOUT'));},timeout);timer.unref?.();});
  activeWork.add(key);
  const work=(async()=>{if(!await current())throw Error('SHADOW_STALE_RUN');return runPage(copy,{...deps,signal:controller.signal});})().finally(()=>activeWork.delete(key));
  try{const result=await Promise.race([work,timeoutTask]);if(!controller.signal.aborted&&await current())await Promise.race([deps.save(result.artifact),timeoutTask]);return {status:'SHADOW_RECORDED'};}
  catch{if(!controller.signal.aborted)controller.abort();try{if(await current())void Promise.resolve(deps.save({version:VERSION,identity:copy.identity,status:'SHADOW_UNAVAILABLE',errorCode:'SHADOW_PROCESSING_FAILED',publishable:false,studentVisible:false,scoreMutation:false})).catch(()=>undefined);}catch{}return {status:'SHADOW_UNAVAILABLE'};}
  finally{clearTimeout(timer);controller.abort();}
 }).catch(()=>({status:'SHADOW_UNAVAILABLE'})).finally(()=>inFlight.delete(key));
 inFlight.set(key,task);return {scheduled:true,completion:task};
}
module.exports={VERSION,mode,runPage,scheduleAfterUpload};
