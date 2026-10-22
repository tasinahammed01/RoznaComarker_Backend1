'use strict';
const {digest,validIdentity}=require('../hybridSource/reconcile');
const {REQUIRED}=require('../correctionLegendResolver.service');
const VERSION='correction-independent-review-v1';
const DECISIONS=['SUPPORTED','UNSUPPORTED','UNCERTAIN'];
const fail=code=>{throw Object.assign(Error(code),{code});};
const safeId=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/.test(v);
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
function identity(value){if(!validIdentity(value)||!['submissionId','fileId','runId'].every(k=>safeId(value[k])))fail('REVIEW_SOURCE_IDENTITY_INVALID');return Object.fromEntries(['submissionId','fileId','runId','pageNumber','sourceSha256','inputSha256','width','height','orientation'].map(k=>[k,value[k]]));}
function registry(entries,generator){
 if(!safeId(generator?.id)||!safeId(generator?.model)||!Array.isArray(entries)||entries.length>32)fail('REVIEW_REGISTRY_INVALID');
 const found=new Set();const reviewers=entries.map(e=>{
  if(!safeId(e.id)||found.has(e.id)||!['HUMAN_REVIEWER','INDEPENDENT_AI_VERIFIER'].includes(e.kind)||!Array.isArray(e.independentOf)||!e.independentOf.includes(generator.id)||e.id===generator.id)fail('REVIEWER_NOT_INDEPENDENT');
  if(e.kind==='INDEPENDENT_AI_VERIFIER'&&(!safeId(e.model)||e.model.toLowerCase()===generator.model.toLowerCase()))fail('REVIEWER_NOT_INDEPENDENT');
  found.add(e.id);return {id:e.id,kind:e.kind,independentOf:[generator.id],...(e.kind==='INDEPENDENT_AI_VERIFIER'?{model:e.model}:{} )};
 });return freeze({version:VERSION,generator:{id:generator.id,model:generator.model},reviewers});
}
function request(record,analysis,generator){
 const sourceIdentity=identity(analysis.identity);
 if(!analysis.records.includes(record)||!record.sourceLocator.valid||!safeId(generator?.id)||!safeId(generator?.model))fail('REVIEW_CANDIDATE_INVALID');
 const transcript=analysis.originalV15Analysis.document.lines.map(l=>l.text+l.eol).join('');if(digest(transcript)!==analysis.transcriptHash)fail('REVIEW_SOURCE_IDENTITY_INVALID');
 const contextStart=Math.max(0,record.start-120),contextEnd=Math.min(transcript.length,record.end+120);
 const c=record.providerRecord,category=Object.keys(REQUIRED).find(k=>REQUIRED[k].includes(c.code));
 const body={version:VERSION,generator:{id:generator.id,model:generator.model},identity:sourceIdentity,transcriptHash:analysis.transcriptHash,
  sourceContextRange:{start:record.start,end:record.end},sourceContext:record.providerEvidenceQuote,suggestionContext:record.providerSuggestion,operativeEdit:record.operativeEdit.operativeEditSpan,
  characterChangeDiagnostic:record.operativeEdit.characterChange||null,editShapeValid:record.editShape.valid,code:c.code,category,
  surroundingContext:{start:contextStart,end:contextEnd,text:transcript.slice(contextStart,contextEnd)},criterion:record.assignmentCriterion?{id:record.assignmentCriterion.id,text:record.assignmentCriterion.text}:null};
 if(!category||!/^[a-f0-9]{64}$/.test(body.transcriptHash)||body.sourceContext.length>500||body.suggestionContext.length>300||JSON.stringify(body).length>16000)fail('REVIEW_REQUEST_LIMIT');
 const out={...body,candidateKey:digest(JSON.stringify(body))};validateRequest(out);return freeze(out);
}
function validateRequest(req){
 const {candidateKey,...body}=req||{};
 if(!/^[a-f0-9]{64}$/.test(candidateKey||'')||digest(JSON.stringify(body))!==candidateKey||body.version!==VERSION||Buffer.byteLength(JSON.stringify(req))>20000)fail('REVIEW_CANDIDATE_KEY_INVALID');
 identity(body.identity);
 const closed=(value,fields)=>value&&Object.keys(value).sort().join(',')===[...fields].sort().join(',');
 if(!closed(req.generator,['id','model'])||!closed(req.identity,['submissionId','fileId','runId','pageNumber','sourceSha256','inputSha256','width','height','orientation'])||!closed(req.sourceContextRange,['start','end'])||!closed(req.surroundingContext,['start','end','text'])||typeof req.editShapeValid!=='boolean'||(req.criterion!==null&&(!closed(req.criterion,['id','text'])||!safeId(req.criterion.id)||typeof req.criterion.text!=='string'||req.criterion.text.length>10000))||(req.operativeEdit!==null&&!closed(req.operativeEdit,['start','end','source','replacement'])))fail('REVIEW_REQUEST_INVALID');
 const required=['version','generator','identity','transcriptHash','sourceContextRange','sourceContext','suggestionContext','operativeEdit','characterChangeDiagnostic','editShapeValid','code','category','surroundingContext','criterion','candidateKey'];
 if(Object.keys(req).sort().join(',')!==required.sort().join(',')||!safeId(req.generator?.id)||!safeId(req.generator?.model)||!/[a-f0-9]{64}/.test(req.transcriptHash)||typeof req.sourceContext!=='string'||req.sourceContext.length>500||typeof req.suggestionContext!=='string'||req.suggestionContext.length>300||(typeof req.surroundingContext?.text!=='string'||req.surroundingContext.text.length>740)||!REQUIRED[req.category]?.includes(req.code))fail('REVIEW_REQUEST_INVALID');
 const span=req.sourceContextRange;if(!Number.isInteger(span?.start)||!Number.isInteger(span?.end)||span.start<0||span.end-span.start!==req.sourceContext.length)fail('REVIEW_REQUEST_INVALID');
 const around=req.surroundingContext;if(!Number.isInteger(around.start)||!Number.isInteger(around.end)||around.start<0||around.end-around.start!==around.text.length||around.start>span.start||around.end<span.end||around.text.slice(span.start-around.start,span.end-around.start)!==req.sourceContext)fail('REVIEW_REQUEST_INVALID');
 const e=req.operativeEdit;if(e&&(e.start<span.start||e.end>span.end||e.start>e.end||req.sourceContext.slice(e.start-span.start,e.end-span.start)!==e.source||req.sourceContext.slice(0,e.start-span.start)+e.replacement+req.sourceContext.slice(e.end-span.start)!==req.suggestionContext))fail('REVIEW_REQUEST_INVALID');
 return req;
}
function humanReceipt(action,req,trusted){
 validateRequest(req);
 if(action?.action!=='RECORD_HUMAN_SEMANTIC_REVIEW'||action.confirmed!==true)fail('EXPLICIT_HUMAN_REVIEW_REQUIRED');
 const reviewer=trusted.reviewers.find(r=>r.id===action.reviewerId&&r.kind==='HUMAN_REVIEWER');
 if(!reviewer)fail('UNKNOWN_REVIEWER');
 return receipt({...action,reviewerId:reviewer.id,audit:{action:'RECORD_HUMAN_SEMANTIC_REVIEW',confirmed:true}},req,trusted,'HUMAN_REVIEWER');
}
function receipt(result,req,trusted,expectedKind){
 validateRequest(req);
 if(expectedKind==='HUMAN_REVIEWER'&&(result?.audit?.action!=='RECORD_HUMAN_SEMANTIC_REVIEW'||result.audit.confirmed!==true))fail('EXPLICIT_HUMAN_REVIEW_REQUIRED');
 const reviewer=trusted.reviewers.find(r=>r.id===result?.reviewerId);
 if(!reviewer||reviewer.kind!==expectedKind||!reviewer.independentOf.includes(req.generator.id)||trusted.generator.id!==req.generator.id||trusted.generator.model!==req.generator.model)fail('UNKNOWN_OR_FOREIGN_REVIEWER');
 if(result.candidateKey!==req.candidateKey)fail('STALE_CANDIDATE_RECEIPT');
 if(!DECISIONS.includes(result.decision)||!safeId(result.reviewId)||typeof result.rationale!=='string'||!result.rationale.trim()||result.rationale.length>512)fail('REVIEW_RECEIPT_INVALID');
 return freeze({version:VERSION,candidateKey:req.candidateKey,reviewerId:reviewer.id,reviewerKind:reviewer.kind,reviewId:result.reviewId,decision:result.decision,
  rationale:result.rationale,reviewedAt:result.reviewedAt&&Number.isFinite(Date.parse(result.reviewedAt))?new Date(result.reviewedAt).toISOString():new Date().toISOString(),...(expectedKind==='HUMAN_REVIEWER'?{audit:{action:'RECORD_HUMAN_SEMANTIC_REVIEW',confirmed:true}}:{}),metadata:{kind:reviewer.kind,...(reviewer.model?{model:reviewer.model}:{})}});
}
async function independentAdapter(req,trusted,adapter,{signal,reviewerId}={}){
 validateRequest(req);if(typeof adapter!=='function')fail('EXPLICIT_VERIFIER_ADAPTER_REQUIRED');
 if(!trusted.reviewers.some(r=>r.id===reviewerId&&r.kind==='INDEPENDENT_AI_VERIFIER'))fail('UNKNOWN_REVIEWER');
 const result=await adapter(freeze(JSON.parse(JSON.stringify(req))),{signal});
 return receipt({...result,reviewerId},req,trusted,'INDEPENDENT_AI_VERIFIER');
}
function bridge(record,analysis,req,receipts,trusted){
 const phase4=require('../correctionOperativeAuthority.service');
 const allowed=[],reviewers={};
 for(const r of receipts||[]){
  if(r.reviewerKind==='HUMAN_REVIEWER'&&r.version!==VERSION)fail('REVIEW_RECEIPT_INVALID');
  const valid=receipt(r,req,trusted,r.reviewerKind);allowed.push({reviewerId:valid.reviewerId,reviewId:valid.reviewId,candidateKey:phase4.verificationRequest(record,analysis).candidateKey,decision:valid.decision});
  reviewers[valid.reviewerId]={kind:valid.reviewerKind==='HUMAN_REVIEWER'?'HUMAN_REVIEW':'INDEPENDENT_VERIFIER',independentOf:[trusted.generator.id]};
 }
 return {generatorId:trusted.generator.id,semanticVerifications:allowed,trustedSemanticReviewers:reviewers};
}
module.exports={VERSION,DECISIONS,safeId,identity,registry,request,validateRequest,humanReceipt,receipt,independentAdapter,bridge};
