'use strict';
const mongoose=require('mongoose'),fs=require('fs/promises'),path=require('path');
const Submission=require('../models/Submission'),Review=require('../models/SourceHumanReview'),Evidence=require('../models/SourceFidelityEvidence');
const Class=require('../models/class.model'),Assignment=require('../models/assignment.model'),File=require('../models/File');
const sf=require('../utils/sourceFidelity'),plan=require('./sourceFidelity/humanReviewPlan'),logger=require('../utils/logger');
const full=require('./sourceFidelity/fullPageReview');
async function authorize(id,user,session){
  if(!user?._id||user.role!=='teacher')throw plan.error('HUMAN_REVIEW_FORBIDDEN',403);
  if(!mongoose.isValidObjectId(id))throw plan.error('HUMAN_REVIEW_NOT_FOUND',404);
  const doc=await Submission.findById(id).session(session||null).lean();if(!doc)throw plan.error('HUMAN_REVIEW_NOT_FOUND',404);
  // Mongo sessions do not support concurrent operations within a transaction.
  const cls=await Class.findOne({_id:doc.class,teacher:user._id,isActive:true}).session(session||null).lean();
  const assignment=await Assignment.findOne({_id:doc.assignment,class:doc.class,teacher:user._id,isActive:true}).session(session||null).lean();
  if(!cls||!assignment)throw plan.error('HUMAN_REVIEW_FORBIDDEN',403);
  return doc;
}
function present(doc,review){const data=review?.payload;
  return {sourceFidelity:sf.payload(doc),revision:review?.revision||0,sourceHash:doc.sourceTranscriptSha256,
    unavailable:data?.unavailable||0,pages:data&&sf.isExact(doc)?(doc.ocrPages||[]).map((_,index)=>full.state(doc,review,index)).filter(p=>p.eligible).map(({provisionalTranscript,...p})=>p):[],items:(data?.items||[]).map(i=>({reviewItemId:i.id,pageNumber:i.pageNumber,reasonCodes:i.reasonCodes,
      provisionalText:i.provisionalText,verificationState:i.state,canConfirm:i.mapping.state==='UNIQUE_STRUCTURAL_SPAN',
      cropAvailable:i.rect.width>=100&&i.geometryWordIds.length>1}))};}
async function ensure(id,user){
  const first=await authorize(id,user);if(first.sourceFidelityMode==='gpt_vision_exact'||!sf.isExact(first)||sf.eligible(first))return present(first,null);
  if(sf.requiresWholePage(first))await require('./sourceFidelity/transactionSupport').requireTransactions();
  if(['pending','processing'].includes(first.ocrStatus))throw plan.error('SOURCE_VERSION_CONFLICT');
  const existing=first.sourceHumanReviewId?await Review.findOne({_id:first.sourceHumanReviewId,jobId:first.ocrJobId,submissionId:first._id}).select('+payload').lean():null;
  if(existing){if(existing.currentHash!==first.sourceTranscriptSha256)throw plan.error('SOURCE_VERSION_CONFLICT');return present(first,existing);}
  const rows=await Evidence.find({'identity.submissionId':String(first._id),'identity.runId':String(first.ocrJobId)}).select('+payload').limit(21).lean();
  if(rows.length>20)throw plan.error('HUMAN_REVIEW_REGION_UNAVAILABLE');const payload=plan.build(first,rows),summary=plan.summary(payload);
  // An uncertain page without a defensible source blocker can never become acceptable by an empty review.
  if(!summary.required){payload.unavailable++;const p=(first.ocrPages||[]).find(p=>!['MODEL_AGREED','HUMAN_VERIFIED'].includes(p.sourceFidelityStatus));
    if(p)payload.unavailableByPage[plan.key(p)]=(payload.unavailableByPage[plan.key(p)]||0)+1;Object.assign(summary,plan.summary(payload));}
  const reviewId=sf.sha(String(first._id)+':'+first.ocrJobId+':'+first.sourceFidelityInputIdentity),session=await mongoose.startSession();
  try{await session.withTransaction(async()=>{
    const doc=await authorize(id,user,session);
    if(doc.ocrJobId!==first.ocrJobId||doc.sourceTranscriptSha256!==first.sourceTranscriptSha256||doc.sourceFidelityInputIdentity!==first.sourceFidelityInputIdentity)throw plan.error('SOURCE_VERSION_CONFLICT');
    await Review.updateOne({_id:reviewId},{$setOnInsert:{submissionId:doc._id,jobId:doc.ocrJobId,currentHash:doc.sourceTranscriptSha256,revision:0,payload}}, {upsert:true,session});
    const changed=await Submission.updateOne({_id:doc._id,ocrJobId:doc.ocrJobId,sourceTranscriptSha256:doc.sourceTranscriptSha256},{$set:{
      sourceHumanReviewId:reviewId,sourceHumanReviewSummary:summary,sourceFidelityStatus:'HUMAN_REVIEW_REQUIRED'}},{session});
    if(!changed.matchedCount)throw plan.error('SOURCE_VERSION_CONFLICT');
  });}catch(e){
    if(e.code!==11000)throw e;
    const doc=await authorize(id,user),review=await Review.findOne({_id:reviewId,jobId:doc.ocrJobId,submissionId:doc._id}).select('+payload').lean();
    if(!review||review.currentHash!==doc.sourceTranscriptSha256)throw plan.error('SOURCE_VERSION_CONFLICT');return present(doc,review);
  }finally{await session.endSession();}
  logger.info({event:'source_human_review_created',submissionId:String(first._id),total:summary.total,unresolved:summary.unresolved});
  const doc=await authorize(id,user),review=await Review.findById(reviewId).select('+payload').lean();return present(doc,review);
}
async function context(id,itemId,user){
  const doc=await authorize(id,user),review=doc.sourceHumanReviewId?await Review.findOne({_id:doc.sourceHumanReviewId,jobId:doc.ocrJobId,submissionId:doc._id}).select('+payload').lean():null;
  const item=review?.payload.items.find(i=>i.id===itemId);
  if(!item||review.currentHash!==doc.sourceTranscriptSha256)throw plan.error('HUMAN_REVIEW_NOT_FOUND',404);
  return {doc,review,item};
}
async function imageBytes(doc,item,wholePage=false){
  const page=doc.ocrPages.find(p=>plan.key(p)===item.pageKey),linked=(doc.files?.length?doc.files:[doc.file]).some(f=>String(f)===item.fileId);
  if(!page||!linked||page.sourceInputSha256!==item.inputSha256)throw plan.error('HUMAN_REVIEW_REGION_UNAVAILABLE');
  const file=await File.findById(page.derivedImageFileId||page.fileId).lean();
  if(!file||page.derivedImageFileId&&(String(file.sourceFileId)!==item.fileId||file.pageNumber!==item.pageNumber))throw plan.error('HUMAN_REVIEW_REGION_UNAVAILABLE');
  const backend=path.resolve(__dirname,'../..'),root=path.resolve(backend,process.env.UPLOAD_BASE_PATH||'uploads'),filename=path.resolve(backend,file.path||'');
  if(!filename.startsWith(root+path.sep))throw plan.error('HUMAN_REVIEW_REGION_UNAVAILABLE');
  const real=await fs.realpath(filename);if(!real.startsWith(root+path.sep))throw plan.error('HUMAN_REVIEW_REGION_UNAVAILABLE');
  const stat=await fs.stat(real);if(stat.size>20*1024*1024)throw plan.error('HUMAN_REVIEW_REGION_UNAVAILABLE');
  const sharp=require('sharp'),raw=await fs.readFile(real),bytes=page.derivedImageFileId?raw:await sharp(raw,{failOn:'error',limitInputPixels:40000000}).rotate().toBuffer();
  if(sf.sha(bytes)!==item.inputSha256)throw plan.error('SOURCE_VERSION_CONFLICT');
  const metadata=await sharp(bytes,{limitInputPixels:40000000}).metadata(),b=item.rect;
  if(metadata.width!==page.width||metadata.height!==page.height)throw plan.error('HUMAN_REVIEW_REGION_UNAVAILABLE');
  if(wholePage)return sharp(bytes,{limitInputPixels:40000000}).png().toBuffer();
  if(metadata.width!==page.width||metadata.height!==page.height||!b||![b.left,b.top,b.width,b.height].every(Number.isInteger)
    ||b.left<0||b.top<0||b.width<100||b.height<=0||b.left+b.width>metadata.width||b.top+b.height>metadata.height
    ||b.width*b.height>metadata.width*metadata.height*.30||item.geometryWordIds.length<2)throw plan.error('HUMAN_REVIEW_REGION_UNAVAILABLE');
  return sharp(bytes,{limitInputPixels:40000000}).extract(b).png().toBuffer();
}
async function crop(id,itemId,user){const c=await context(id,itemId,user);return imageBytes(c.doc,c.item);}
async function resolve(id,itemId,body,user,wholePage=false){
  (wholePage?full:plan).decision(body);const first=wholePage?await pageContext(id,itemId,user):await context(id,itemId,user);
  // Idempotent replay does not depend on a still-present image after the committed decision.
  const same=wholePage?full.replay(first.doc,first.review,itemId,body):first.item.state==='HUMAN_VERIFIED'&&JSON.stringify(first.item.decision)===JSON.stringify(plan.decision(body))
    &&first.item.requestRevision===body.revision&&first.item.requestSourceHash===body.sourceHash;
  if(same)return present(first.doc,first.review);
  if(sf.requiresWholePage(first.doc)){
    if(!wholePage)throw plan.error('HUMAN_REVIEW_REGION_UNAVAILABLE');
    await require('./sourceFidelity/transactionSupport').requireTransactions();
  }
  await imageBytes(first.doc,first.item,wholePage);
  const session=await mongoose.startSession();let completed=false,out,superseded=0;
  try{await session.withTransaction(async()=>{
    completed=false;const doc=await authorize(id,user,session),review=await Review.findOne({_id:doc.sourceHumanReviewId,jobId:doc.ocrJobId,submissionId:doc._id}).select('+payload').session(session).lean();
    if(!review)throw plan.error('SOURCE_VERSION_CONFLICT');const result=(wholePage?full:plan).apply(doc,review,itemId,body,user);
    if(result.idempotent){out=present(doc,review);return;}
    if(wholePage&&doc.sourceFidelityInputIdentity!==first.doc.sourceFidelityInputIdentity)throw plan.error('SOURCE_VERSION_CONFLICT');
    superseded=result.receipt?.blockersSuperseded||0;
    const next={...doc,ocrPages:result.pages,sourceHumanReviewSummary:result.summary};Object.assign(next,sf.aggregate(next));
    completed=sf.eligible(next);
    const set={ocrPages:next.ocrPages,...sf.aggregate(next),sourceHumanReviewSummary:result.summary};
    if(completed)Object.assign(set,{ocrStatus:'completed',ocrErrorCode:null,ocrError:null,correctionStatus:'pending',semanticStatus:'pending',
      evaluationStatus:'pending',assessmentStatus:'started',assessmentErrorCode:null,semanticErrorCode:null,evaluationErrorCode:null,
      analysisAttempt:0,analysisNextRetryAt:new Date(),analysisErrorCode:null});
    const updated=await Submission.findOneAndUpdate({_id:doc._id,ocrJobId:doc.ocrJobId,sourceTranscriptSha256:body.sourceHash,sourceFidelityInputIdentity:doc.sourceFidelityInputIdentity},{$set:set},{returnDocument:'after',session}).lean();
    if(!updated)throw plan.error('SOURCE_VERSION_CONFLICT');
    const changed=await Review.updateOne({_id:review._id,revision:body.revision,currentHash:body.sourceHash},{$set:{payload:result.payload,currentHash:next.sourceTranscriptSha256},$inc:{revision:1}},{session});
    if(!changed.matchedCount)throw plan.error('SOURCE_VERSION_CONFLICT');
    out=present(updated,{...review,payload:result.payload,revision:review.revision+1});
  });}catch(e){logger.info({event:wholePage?'source_full_page_review_conflict':'source_human_review_conflict',submissionId:String(id),reviewItemId:itemId,errorCode:e.code&&typeof e.code==='string'?e.code:'SOURCE_VERSION_CONFLICT'});throw e;}
  finally{await session.endSession();}
  logger.info({event:wholePage?(body.classification==='CANNOT_DETERMINE'?'source_full_page_review_cannot_determine':'source_full_page_review_confirmed'):completed?'source_human_review_completed':body.classification==='CANNOT_DETERMINE'?'source_human_review_conflict':'source_human_review_resolved',
    submissionId:String(id),reviewItemId:itemId,reviewState:out.sourceFidelity.status,beforeChars:first.item.provisionalText.length,
    afterChars:wholePage?body.transcriptExact.length:body.classification==='ACTIVE_STUDENT_TEXT'?body.text.length:0,
    ...(wholePage?{pageNumber:first.item.pageNumber,reviewerRole:user.role,revision:out.revision,blockersSuperseded:superseded}:{})});
  if(completed){require('./assessmentRecovery.service').scheduleSubmissionAnalysis(id,first.doc.ocrJobId);
    logger.info({event:wholePage?'source_full_page_review_assessment_resumed':'source_assessment_resumed',submissionId:String(id)});}
  return out;
}
async function pageContext(id,index,user){
  const doc=await authorize(id,user),review=doc.sourceHumanReviewId?await Review.findOne({_id:doc.sourceHumanReviewId,jobId:doc.ocrJobId,submissionId:doc._id}).select('+payload').lean():null;
  if(!review||review.currentHash!==doc.sourceTranscriptSha256)throw plan.error('SOURCE_VERSION_CONFLICT');
  const p=full.page(doc,index);
  return {doc,review,item:{pageKey:plan.key(p),fileId:String(p.fileId),pageNumber:p.pageNumber,inputSha256:p.sourceInputSha256,provisionalText:p.sourceTextExact||''}};
}
async function pageReview(id,index,user,image=false){
  const c=await pageContext(id,index,user),state=full.state(c.doc,c.review,index);
  if(!state.eligible)throw plan.error('HUMAN_REVIEW_REGION_UNAVAILABLE');
  const bytes=await imageBytes(c.doc,c.item,true);
  if(image)return bytes;
  logger.info({event:'source_full_page_review_opened',submissionId:String(id),pageNumber:state.pageNumber,reviewerRole:user.role,revision:c.review.revision});
  return state;
}
module.exports={authorize,ensure,context,crop,imageBytes,resolve,present,pageReview};
