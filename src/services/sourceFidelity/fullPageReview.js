'use strict';
const sf=require('../../utils/sourceFidelity'),plan=require('./humanReviewPlan');
const SUPERSEDED='SUPERSEDED_BY_FULL_PAGE_HUMAN_VERIFICATION';
const ordered=doc=>(doc.ocrPages||[]).slice().sort((a,b)=>a.fileOrder-b.fileOrder||a.pageIndex-b.pageIndex);
function ledger(payload){
  if(payload.unavailableByPage)return {...payload.unavailableByPage};
  // Old plans stored only a global count. Conservatively retain it on EVERY blocked
  // page; never guess which other page can be cleared. Evidence remains unchanged.
  return Object.fromEntries(payload.basePages.filter(p=>!['MODEL_AGREED','HUMAN_VERIFIED'].includes(p.sourceFidelityStatus)).map(p=>[plan.key(p),payload.unavailable||0]));
}
function page(doc,index){
  if(!/^(0|[1-9]\d*)$/.test(String(index))||!Number.isSafeInteger(Number(index)))throw plan.error('HUMAN_REVIEW_NOT_FOUND',404);
  const p=ordered(doc)[Number(index)];if(!p)throw plan.error('HUMAN_REVIEW_NOT_FOUND',404);
  if((doc.ocrPages||[]).filter(v=>plan.key(v)===plan.key(p)).length!==1)throw plan.error('SOURCE_VERSION_CONFLICT');return p;
}
const identity=(doc,p)=>sf.sha(JSON.stringify([String(doc._id),doc.ocrJobId,String(p.fileId),p.pageNumber,p.pageIndex,p.sourceInputSha256,doc.sourceFidelityInputIdentity]));
function state(doc,review,index){
  const p=page(doc,index),payload=review?.payload,k=plan.key(p),record=payload?.fullPageReviews?.[k];
  const blockers=(payload?.items||[]).filter(i=>i.pageKey===k&&!['HUMAN_VERIFIED',SUPERSEDED].includes(i.state));
  const unavailable=payload?(ledger(payload)[k]||0):0;
  const escalation=unavailable+blockers.filter(i=>i.state==='NEEDS_ESCALATION'||i.mapping?.state!=='UNIQUE_STRUCTURAL_SPAN'||!i.rect||i.rect.width<100||i.rect.height<=0||i.rect.width*i.rect.height>p.width*p.height*.3||i.geometryWordIds?.length<2).length;
  const eligible=Boolean(payload&&sf.isExact(doc)&&!sf.eligible(doc)&&!['pending','processing'].includes(doc.ocrStatus)
    &&(sf.requiresWholePage(doc)?p.sourceFidelityStatus!=='PROVIDER_FAILED'&&!record?.confirmed:!['MODEL_AGREED','HUMAN_VERIFIED'].includes(p.sourceFidelityStatus)&&!record?.confirmed&&escalation>0));
  return {pageIndex:Number(index),pageNumber:p.pageNumber,pageHash:p.sourceTextSha256,pageIdentity:identity(doc,p),sourceHash:doc.sourceTranscriptSha256,
    revision:review?.revision||0,eligible,verificationState:record?.confirmed?'PAGE_HUMAN_VERIFIED':p.sourceFidelityStatus,
    blockerCount:blockers.length+unavailable,provisionalTranscript:p.sourceTextExact??'',
    ...(sf.requiresWholePage(doc)?{uncertainSpans:p.sourceUncertainSpans||[]}: {})};
}
function decision(body){
  if(!body||Object.keys(body).some(k=>!['revision','sourceHash','pageHash','pageIdentity','classification','transcriptExact','confirmWholePage','reviewedDeletedMaterial'].includes(k))
    ||!Number.isInteger(body.revision)||body.revision<0||![body.sourceHash,body.pageHash,body.pageIdentity].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v))
    ||!['ACTIVE_PAGE_TRANSCRIPT','CANNOT_DETERMINE'].includes(body.classification)||typeof body.transcriptExact!=='string'
    ||body.transcriptExact.length>50000||!body.transcriptExact.isWellFormed()||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(body.transcriptExact)
    ||body.reviewedDeletedMaterial!==undefined&&typeof body.reviewedDeletedMaterial!=='boolean'
    ||body.confirmWholePage!==undefined&&typeof body.confirmWholePage!=='boolean'
    ||body.classification==='ACTIVE_PAGE_TRANSCRIPT'&&body.confirmWholePage!==true)throw plan.error('HUMAN_REVIEW_INVALID',400);
  return {classification:body.classification,transcriptExact:body.transcriptExact,confirmWholePage:body.confirmWholePage===true,reviewedDeletedMaterial:body.reviewedDeletedMaterial===true};
}
function replay(doc,review,index,body){
  const d=decision(body),p=page(doc,index),record=review.payload.fullPageReviews?.[plan.key(p)];
  return Boolean(record?.confirmed&&record.requestRevision===body.revision&&record.requestSourceHash===body.sourceHash
    &&record.requestPageHash===body.pageHash&&record.requestPageIdentity===body.pageIdentity&&JSON.stringify(record.decision)===JSON.stringify(d));
}
function apply(doc,review,index,body,actor){
  const d=decision(body);if(replay(doc,review,index,body))return {idempotent:true};
  const p=page(doc,index),k=plan.key(p),base=review.payload.basePages.find(v=>plan.key(v)===k);
  if(body.revision!==review.revision||review.currentHash!==body.sourceHash||doc.sourceTranscriptSha256!==body.sourceHash
    ||p.sourceTextSha256!==body.pageHash||sf.sha(p.sourceTextExact)!==body.pageHash||identity(doc,p)!==body.pageIdentity
    ||sf.aggregate(doc).sourceTranscriptSha256!==body.sourceHash||sf.sha(doc.sourceTranscriptExact)!==body.sourceHash||!base||base.sourceInputSha256!==p.sourceInputSha256
    ||review.payload.fullPageReviews?.[k]?.confirmed)throw plan.error('SOURCE_VERSION_CONFLICT');
  if(!state(doc,review,index).eligible)throw plan.error('HUMAN_REVIEW_REGION_UNAVAILABLE');
  const payload=JSON.parse(JSON.stringify(review.payload)),pages=JSON.parse(JSON.stringify(doc.ocrPages));
  const next=pages.find(v=>plan.key(v)===k),timestamp=new Date().toISOString();
  const receipt={submissionId:String(doc._id),fileId:String(p.fileId),pageNumber:p.pageNumber,reviewerId:String(actor._id),reviewerRole:actor.role,timestamp,
    reviewType:'FULL_PAGE_HUMAN_REVIEW',classification:d.classification,priorPageSha256:p.sourceTextSha256,priorRootSha256:body.sourceHash,
    originalSourceVersion:p.sourceFidelityVersion,resultingSourceVersion:d.classification==='ACTIVE_PAGE_TRANSCRIPT'?'human-source-v1':p.sourceFidelityVersion,
    beforeTextExact:p.sourceTextExact,afterTextExact:d.classification==='ACTIVE_PAGE_TRANSCRIPT'?d.transcriptExact:p.sourceTextExact,
    reviewedDeletedMaterial:d.reviewedDeletedMaterial,previousReceipt:p.sourceHumanReceiptHash||null};
  payload.fullPageReviews||={};
  payload.fullPageReviews[k]={confirmed:d.classification==='ACTIVE_PAGE_TRANSCRIPT',decision:d,requestRevision:body.revision,requestSourceHash:body.sourceHash,requestPageHash:body.pageHash,requestPageIdentity:body.pageIdentity};
  let superseded=0;
  if(d.classification==='ACTIVE_PAGE_TRANSCRIPT'){
    payload.unavailableByPage=ledger(payload);superseded=payload.unavailableByPage[k]||0;
    receipt.supersededUnavailableCount=superseded;receipt.supersededUnavailableState=SUPERSEDED;
    receipt.priorVerificationStage=p.sourceVerificationStage;receipt.priorVerificationSummary=p.sourceVerificationSummary;
    receipt.priorBlockersState=SUPERSEDED;
    payload.unavailableByPage[k]=0;payload.unavailable=Object.values(payload.unavailableByPage).reduce((n,v)=>n+v,0);
    for(const item of payload.items.filter(i=>i.pageKey===k)){
      if(!['HUMAN_VERIFIED',SUPERSEDED].includes(item.state)){item.previousState=item.state;item.state=SUPERSEDED;superseded++;}
    }
    next.sourceTextExact=d.transcriptExact;next.sourceTextSha256=sf.sha(d.transcriptExact);
    next.sourceFidelityVersion='human-source-v1';next.sourceFidelityStatus='HUMAN_VERIFIED';next.sourceVerificationStage='PAGE_HUMAN_VERIFIED';next.sourceHumanReviewUnresolved=0;
  }
  receipt.resultingPageSha256=next.sourceTextSha256;
  receipt.resultingRootSha256=sf.sha(ordered({ocrPages:pages}).map(v=>v.sourceTextExact??'').join(sf.PAGE_SEPARATOR));
  receipt.blockersSuperseded=superseded;
  if(d.classification==='ACTIVE_PAGE_TRANSCRIPT')next.sourceHumanReceiptHash=sf.sha(JSON.stringify(receipt));
  payload.history.push(receipt);
  if(Buffer.byteLength(JSON.stringify(payload))>8*1024*1024)throw plan.error('HUMAN_REVIEW_LIMIT');
  return {payload,pages,summary:plan.summary(payload),receipt};
}
module.exports={page,state,decision,replay,apply,identity};
