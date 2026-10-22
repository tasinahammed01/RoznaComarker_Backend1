'use strict';
const fs=require('fs/promises');
const Evidence=require('../../models/SourceFidelityEvidence');
const {VERSION,PROMPT,sha,config,validate,fail}=require('./contract');
const {orientImage}=require('./imageInput');
const IMAGE_MESSAGE='Some handwriting could not be read confidently. Please upload a clearer image.';
const SERVICE_MESSAGE='Handwriting verification is temporarily unavailable. Please try again later.';
function binding(context,page,env=process.env){
  const {model}=config(env),assignmentId=String(context.assignment._id),ownerId=String(context.ownerId);
  const promptSha256=sha(PROMPT+JSON.stringify(require('../gptVisionExact.service').reference(context.assignment)));
  const identity={preSubmission:true,ownerId,assignmentId,sourceMode:'gpt_vision_exact',version:VERSION,model,promptSha256,
    sourceSha256:page.sourceSha256,inputSha256:sha(page.bytes),pageNumber:page.pageNumber,pageIndex:page.pageNumber-1};
  return {...identity,key:sha(JSON.stringify(identity)).slice(0,24)};
}
async function pagesFor(file){
  const bytes=file.buffer||await fs.readFile(file.path),sourceSha256=sha(bytes);
  if((file.detectedMime||file.mimetype)==='application/pdf'){
    if(bytes.length>10*1024*1024||bytes.subarray(0,5).toString()!=='%PDF-')throw fail('OCR_PDF_INVALID');
    const pages=await require('../pdfSubmissionPages.service').rasterize(bytes);
    return pages.map((p,i)=>({bytes:p.buffer,mimeType:'image/jpeg',pageNumber:i+1,sourceSha256}));
  }
  const normalized=await orientImage(bytes);
  return [{bytes:normalized.data,mimeType:normalized.info.format==='jpeg'?'image/jpeg':`image/${normalized.info.format}`,pageNumber:1,sourceSha256}];
}
async function find(key){return Evidence.findById(key).select('+payload').lean();}
const sameBinding=(a,b)=>a&&b&&Object.keys(b).every(k=>a[k]===b[k]);
function reservationFor(bound){return {
  async acquire(){
    try{await Evidence.create({_id:bound.key,identity:bound,status:'GPT_SOURCE_RESERVED',expiresAt:null});return {_id:bound.key,cached:false};}
    catch(e){if(e.code!==11000)throw fail('OCR_GPT_SOURCE_RESERVATION_FAILED');}
    const old=await find(bound.key);
    if(old?.status==='GPT_SOURCE_ACCEPTED'&&sameBinding(old.identity,bound)&&old.payload?.primary)return {_id:bound.key,cached:true,evidence:old};
    if(old?.status==='GPT_SOURCE_FAILED')throw Object.assign(fail(old.payload?.safeFailureCode||'OCR_GPT_PROVIDER_FAILED'),{sourceDiagnostic:require('../gptVisionExact.service').safeSourceDiagnostic(old.payload)});
    throw fail('OCR_GPT_SOURCE_CHECKING');
  },
  async complete(id,value){const r=await Evidence.updateOne({_id:id,status:'GPT_SOURCE_RESERVED'},{$set:value});if(!r.matchedCount)throw fail('OCR_GPT_SOURCE_RESERVATION_FAILED');}
};}
function ui(error){
  if(!error)return {sourceReadStatus:'PASSED',canSubmit:true,message:'The handwriting can be read for assessment.'};
  const code=/^OCR_[A-Z0-9_]{1,90}$/.test(error.code||'')?error.code:'OCR_GPT_PROVIDER_FAILED';
  if(code==='OCR_GPT_SOURCE_CHECKING')return {sourceReadStatus:'CHECKING',canSubmit:false,sourceReadErrorCode:code,message:'We are checking whether the handwriting can be read accurately.'};
  const image=['OCR_GPT_SOURCE_UNCERTAIN','OCR_GPT_SOURCE_EMPTY','OCR_PDF_INVALID','OCR_PDF_PASSWORD','OCR_PDF_LIMIT'].includes(code);
  return {sourceReadStatus:image?'FAILED_IMAGE':'FAILED_SERVICE',canSubmit:false,sourceReadErrorCode:code,message:image?IMAGE_MESSAGE:SERVICE_MESSAGE};
}
function withSourceCheck(basic,state){return {...basic,basicChecksPassed:basic.ready,sourceReadRequired:true,...state,ready:basic.ready&&state.canSubmit,
  checks:[...basic.checks,{id:'handwritingReadability',label:'Handwriting readability',required:true,
    status:state.sourceReadStatus==='PASSED'?'pass':state.sourceReadStatus==='CHECKING'?'checking':state.sourceReadStatus==='FAILED_IMAGE'?'fail':'unavailable',message:state.message}]};}
async function checkPages(pages,context,{run=false,env=process.env}={}){
  const bindings=[];
  for(const page of pages){
    const bound=binding(context,page,env);bindings.push(bound);
    if(run)await require('../gptVisionExact.service').readPage({bytes:page.bytes,mimeType:page.mimeType,assignment:context.assignment,
      identity:{submissionId:'preflight',fileId:page.sourceSha256,pageNumber:page.pageNumber,sourceSha256:page.sourceSha256},env,reservation:reservationFor(bound)});
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
      ||claim.sourceMode!=='gpt_vision_exact'||claim.version!==VERSION||claim.model!==bound.model||claim.promptSha256!==bound.promptSha256
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
module.exports={binding,pagesFor,reservationFor,checkPages,claimReservation,ui,withSourceCheck,IMAGE_MESSAGE,SERVICE_MESSAGE};
