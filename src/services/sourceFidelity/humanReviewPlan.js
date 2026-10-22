'use strict';
const sf=require('../../utils/sourceFidelity'),targeted=require('./targetedVerification');
const error=(code,status=409)=>Object.assign(Error(code),{code,status});
const key=p=>String(p.fileId)+':'+p.pageNumber;
function build(submission,evidence){
  const items=[],basePages=JSON.parse(JSON.stringify((submission.ocrPages||[]).map(p=>Object.fromEntries([
    'fileId','fileOrder','pageNumber','pageIndex','sourceTextExact','sourceTextSha256','sourceInputSha256','sourceFidelityVersion','sourceFidelityStatus'
  ].map(k=>[k,p[k]])))));let unavailable=0;const unavailableByPage={};
  const add=(page,n=1)=>{unavailable+=n;unavailableByPage[key(page)]=(unavailableByPage[key(page)]||0)+n;};
  for(const page of basePages){
    if(sf.requiresWholePage(submission)){
      // One mandatory full-page blocker, independent of model confidence/layout.
      if(page.sourceFidelityStatus!=='HUMAN_VERIFIED')add(page);
      continue;
    }
    if(['MODEL_AGREED','HUMAN_VERIFIED'].includes(page.sourceFidelityStatus))continue;
    const rows=evidence.filter(e=>e.identity?.submissionId===String(submission._id)&&e.identity?.runId===String(submission.ocrJobId)
      &&e.identity?.fileId===String(page.fileId)&&e.identity?.pageNumber===page.pageNumber&&e.identity?.inputSha256===page.sourceInputSha256);
    const e=rows.length===1?rows[0]:null,g=e?.payload?.google?.nativePages?.[0],a=e?.payload?.primary,b=e?.payload?.secondary;
    if(!a||!b||!g?.dimensionsMatch||a.activeTranscript!==page.sourceTextExact||sf.sha(page.sourceTextExact)!==page.sourceTextSha256){add(page);continue;}
    let plan;try{plan=targeted.discover({astra:a,fable:b,google:g,identity:{fileId:String(page.fileId),pageNumber:page.pageNumber,inputSha256:page.sourceInputSha256},maxRegions:40});}
    catch{add(page);continue;}
    add(page,plan.unlocalizedSignalCount+plan.omittedRegionCount);
    if(!plan.regions.length)add(page);
    for(const r of plan.regions){
      const m=r.mapping,rect=r.nativeCoordinates;
      if(!rect||![rect.left,rect.top,rect.width,rect.height].every(Number.isInteger)||rect.left<0||rect.top<0||rect.width<=0||rect.height<=0
        ||rect.left+rect.width>g.width||rect.top+rect.height>g.height){add(page);continue;}
      const safe=m?.state==='UNIQUE_STRUCTURAL_SPAN'&&r.sourceGeometryWordIds.length>1;
      const overlap=items.some(i=>i.pageKey===key(page)&&safe&&i.mapping?.state==='UNIQUE_STRUCTURAL_SPAN'&&m.start<i.mapping.end&&m.end>i.mapping.start);
      if(overlap){add(page);continue;}
      const resolvedTarget=e.payload.targeted?.results?.find(v=>v.region?.id===r.id);
      if(resolvedTarget?.status==='TARGETED_MODEL_AGREED'&&resolvedTarget.reconciliation?.alignmentState==='UNIQUE_STRUCTURAL_SPAN'
        &&resolvedTarget.reconciliation.replacement===m?.original)continue;
      items.push({id:sf.sha(String(submission._id)+':'+submission.sourceFidelityInputIdentity+':'+r.id),pageKey:key(page),fileId:String(page.fileId),
        pageNumber:page.pageNumber,pageIndex:page.pageIndex,regionId:r.id,reasonCodes:r.reasons,rect,displayRect:rect,
        transform:{type:'native-pixel-translation',offsetX:rect.left,offsetY:rect.top,scaleX:1,scaleY:1,inputWidth:g.width,inputHeight:g.height},inputSha256:page.sourceInputSha256,
        originalTranscriptSha256:page.sourceTextSha256,geometryWordIds:r.sourceGeometryWordIds,
        mapping:safe?m:{state:'MAPPING_WITHHELD'},provisionalText:safe?m.original:'',state:safe?'PENDING_HUMAN_REVIEW':'NEEDS_ESCALATION',createdAt:new Date().toISOString()});
    }
  }
  if(items.length>400)throw error('HUMAN_REVIEW_REGION_UNAVAILABLE');
  const payload={basePages,originalTranscriptExact:submission.sourceTranscriptExact,originalTranscriptSha256:submission.sourceTranscriptSha256,
    baseIdentity:submission.sourceFidelityInputIdentity,items,unavailable,unavailableByPage,history:[]};
  checkSize(payload);return payload;
}
function checkSize(payload){if(Buffer.byteLength(JSON.stringify(payload))>8*1024*1024)throw error('HUMAN_REVIEW_LIMIT',409);}
function summary(payload){const total=payload.items.length+payload.unavailable,resolved=payload.items.filter(i=>['HUMAN_VERIFIED','SUPERSEDED_BY_FULL_PAGE_HUMAN_VERIFICATION'].includes(i.state)).length;
  return {required:total-resolved>0,total,resolved,unresolved:total-resolved,unavailable:payload.unavailable};}
function decision(body){
  if(!body||Object.keys(body).some(k=>!['sourceHash','revision','classification','text','deletedText'].includes(k))
    ||!Number.isInteger(body.revision)||body.revision<0||!/^[a-f0-9]{64}$/.test(body.sourceHash||'')
    ||!['ACTIVE_STUDENT_TEXT','DELETED_STUDENT_TEXT','NON_STUDENT_ARTIFACT','CANNOT_DETERMINE'].includes(body.classification)
    ||typeof body.text!=='string'||body.text.length>6000||!body.text.isWellFormed()||body.text.includes('\u0000')
    ||body.deletedText!==undefined&&(typeof body.deletedText!=='string'||body.deletedText.length>3000||!body.deletedText.isWellFormed()))throw error('HUMAN_REVIEW_INVALID',400);
  if(body.classification==='ACTIVE_STUDENT_TEXT'&&!body.text.length)throw error('HUMAN_REVIEW_INVALID',400);
  return {classification:body.classification,text:body.text,deletedText:body.deletedText||''};
}
function apply(submission,review,itemId,body,actor){
  const d=decision(body),payload=JSON.parse(JSON.stringify(review.payload)),item=payload.items.find(i=>i.id===itemId);
  if(!item)throw error('HUMAN_REVIEW_NOT_FOUND',404);
  if(item.state==='HUMAN_VERIFIED'&&JSON.stringify(item.decision)===JSON.stringify(d)&&item.requestRevision===body.revision&&item.requestSourceHash===body.sourceHash)return {idempotent:true};
  if(body.revision!==review.revision||body.sourceHash!==submission.sourceTranscriptSha256||review.currentHash!==body.sourceHash)throw error('SOURCE_VERSION_CONFLICT');
  if(['HUMAN_VERIFIED','SUPERSEDED_BY_FULL_PAGE_HUMAN_VERIFICATION'].includes(item.state))throw error('SOURCE_VERSION_CONFLICT');
  const page=(submission.ocrPages||[]).find(p=>key(p)===item.pageKey),base=payload.basePages.find(p=>key(p)===item.pageKey),m=item.mapping;
  if(!page||!base||page.sourceInputSha256!==item.inputSha256||sf.sha(base.sourceTextExact)!==item.originalTranscriptSha256
    ||m.state!=='UNIQUE_STRUCTURAL_SPAN'||m.sourceTranscriptSha256!==item.originalTranscriptSha256)throw error('HUMAN_REVIEW_REGION_UNAVAILABLE');
  if(!Number.isInteger(m.start)||!Number.isInteger(m.end)||m.start<0||m.end<=m.start||m.end>base.sourceTextExact.length
    ||base.sourceTextExact.indexOf(m.original)!==m.start||base.sourceTextExact.indexOf(m.original,m.start+1)!==-1
    ||sf.sha(page.sourceTextExact)!==page.sourceTextSha256||sf.aggregate(submission).sourceTranscriptSha256!==submission.sourceTranscriptSha256)throw error('SOURCE_VERSION_CONFLICT');
  const old=payload.items.filter(i=>i.pageKey===item.pageKey&&i.state==='HUMAN_VERIFIED');
  if(old.some(i=>i.mapping.start<m.end&&i.mapping.end>m.start))throw error('SOURCE_VERSION_CONFLICT');
  const shift=old.filter(i=>i.mapping.end<=m.start).reduce((n,i)=>n+i.replacement.length-(i.mapping.end-i.mapping.start),0),start=m.start+shift,end=m.end+shift;
  if(base.sourceTextExact.slice(m.start,m.end)!==m.original||page.sourceTextExact.slice(start,end)!==m.original
    ||!m.original.startsWith(m.leftAnchor)||!m.original.endsWith(m.rightAnchor))throw error('SOURCE_VERSION_CONFLICT');
  const beforeHash=submission.sourceTranscriptSha256,beforePageHash=page.sourceTextSha256,now=new Date().toISOString();
  item.decision=d;item.requestRevision=body.revision;item.requestSourceHash=body.sourceHash;
  item.reviewedBy=String(actor._id);item.reviewedByRole=actor.role;item.resolvedAt=now;
  if(d.classification==='CANNOT_DETERMINE'){
    item.state='NEEDS_ESCALATION';payload.history.push({reviewItemId:item.id,reviewedBy:item.reviewedBy,reviewedByRole:actor.role,timestamp:now,
      classification:d.classification,reportedText:d.text,deletedText:d.deletedText,applied:false,beforeSpan:m.original,afterSpan:m.original,
      sourceBeforeHash:beforeHash,sourceAfterHash:beforeHash,pageBeforeHash:beforePageHash,pageAfterHash:beforePageHash});
    checkSize(payload);return {payload,pages:submission.ocrPages,receipt:null,summary:summary(payload)};
  }
  item.replacement=d.classification==='ACTIVE_STUDENT_TEXT'?d.text:'';item.state='HUMAN_VERIFIED';
  const pages=JSON.parse(JSON.stringify(submission.ocrPages)),next=pages.find(p=>key(p)===item.pageKey);
  next.sourceTextExact=page.sourceTextExact.slice(0,start)+item.replacement+page.sourceTextExact.slice(end);next.sourceTextSha256=sf.sha(next.sourceTextExact);
  const receipt={reviewItemId:item.id,reviewedBy:item.reviewedBy,reviewedByRole:actor.role,timestamp:now,classification:d.classification,
    beforeSpan:m.original,afterSpan:item.replacement,deletedText:d.deletedText,sourceBeforeHash:beforeHash,pageBeforeHash:beforePageHash,
    pageAfterHash:next.sourceTextSha256,beforeOffsets:{start,end},afterOffsets:{start,end:start+item.replacement.length},previousReceipt:page.sourceHumanReceiptHash||null};
  receipt.sourceAfterHash=sf.sha(pages.slice().sort((a,b)=>a.fileOrder-b.fileOrder||a.pageIndex-b.pageIndex).map(p=>p.sourceTextExact??'').join(sf.PAGE_SEPARATOR));
  const done=payload.items.filter(i=>i.pageKey===item.pageKey).every(i=>i.state==='HUMAN_VERIFIED')&&(payload.unavailableByPage?!(payload.unavailableByPage[item.pageKey]||0):payload.unavailable===0);
  next.sourceFidelityVersion='human-source-v1';next.sourceHumanReceiptHash=sf.sha(JSON.stringify(receipt));next.sourceHumanReviewUnresolved=done?0:1;
  next.sourceFidelityStatus=done?'HUMAN_VERIFIED':'HUMAN_REVIEW_REQUIRED';next.sourceVerificationStage=next.sourceFidelityStatus;
  payload.history.push(receipt);checkSize(payload);return {payload,pages,receipt,summary:summary(payload)};
}
module.exports={build,summary,decision,apply,key,error};
