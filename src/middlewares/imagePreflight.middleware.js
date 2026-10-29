'use strict';

const fs = require('fs/promises');
const { evaluateImage } = require('../services/imagePreflight.service');
const {withPreflightProgress}=require('../services/submissionProgress.service');
const guestDiagnostic=require('../utils/guestPreflightDiagnostics');
const exact=()=>require('../services/hybridSource/contract').mode()==='gpt_vision_exact';
async function sourceContext(req){
  if(req.guestContext){
    const access=require('../services/guestAccess.service'),guest=access.identity(req.body);
    if(!/^[\w-]{32,128}$/.test(req.get('Idempotency-Key')||''))throw access.fail(400,'A valid submission reference is required.');
    return {assignment:req.guestContext.assignment,ownerId:'guest:'+require('../services/gptVisionExact/contract').sha(guest.normalizedEmail),uploaderId:String(req.guestContext.owner._id)};
  }
  const Assignment=require('../models/assignment.model'),Class=require('../models/class.model'),Membership=require('../models/membership.model');
  const id=req.params?.assignmentId||req.body?.assignmentId;
  const qrToken=req.params?.qrToken||req.body?.qrToken;
  const forbidden=()=>Object.assign(Error('Assignment access is required for handwriting verification.'),{status:403,code:'OCR_GPT_SOURCE_CONTEXT_REQUIRED'});
  if(!req.user?._id||!id&&!qrToken||id&&!require('mongoose').isValidObjectId(id))throw forbidden();
  const assignment=await Assignment.findOne(id?{_id:id,isActive:true}:{qrToken,isActive:true}).lean();
  if(!assignment||!await Class.exists({_id:assignment.class,isActive:true})||!await Membership.exists({student:req.user._id,class:assignment.class,status:'active'}))throw forbidden();
  return {assignment,ownerId:String(req.user._id),uploaderId:String(req.user._id)};
}
async function basicFor(file,userId,sourceRequired){
  const pdf=(file.detectedMime||file.mimetype)==='application/pdf';
  if(!pdf)return {result:await evaluateImage(file.buffer||file.path,userId)};
  if(!sourceRequired)return {result:{ready:true,checks:[]}};
  const pages=await require('../services/gptVisionExact/preflight').pagesFor(file),results=[];
  for(const page of pages)results.push(await evaluateImage(page.bytes,userId));
  return {pages,result:{ready:results.length>0&&results.every(r=>r.ready),checks:(results.find(r=>!r.ready)||results[0])?.checks||[]}};
}

function requestFiles(req) {
  return [req.file, ...(Array.isArray(req.files) ? req.files : Object.values(req.files || {}).flat())].filter(Boolean);
}

async function cleanup(files) {
  // Only server-created Multer paths; never accept a client-provided path.
  await Promise.all(files.filter(file => file.path).map(file => fs.unlink(file.path).catch(() => {})));
}

async function preflightImage(req, res) {
  const requestId=guestDiagnostic.requestId(req)||require('crypto').randomUUID(),started=Date.now();
  res.set('X-Request-ID',requestId);
  const files = requestFiles(req);
  const controller=new AbortController();
  const cancelled=()=>{if(!res.writableEnded)controller.abort('source_user_cancelled');};
  req.on('aborted',cancelled);res.on('close',cancelled);
  const deadline=setTimeout(()=>controller.abort('source_preflight_deadline'),require('../services/gptVisionExact/contract').PREFLIGHT_TIMEOUT_MS);
  try {
    guestDiagnostic.update(req,{phase:req.body?.phase==='basic'?'basic':'source',stage:'image_input'});
    const file = files[0];
    if (files.length !== 1 || !(file?.detectedMime?.startsWith('image/')||file?.detectedMime==='application/pdf')) {
      return res.status(400).json({ success: false, message: 'Choose one JPG, PNG or WEBP image.' });
    }
    guestDiagnostic.update(req,{stage:'source_context'});
    const required=exact(),context=required?await sourceContext(req):null;
    guestDiagnostic.update(req,{stage:'basic_quality'});
    const basic=await basicFor(file,req.user?._id,required);
    if(!required||!basic.result.ready)return res.json({success:true,data:withPreflightProgress({...basic.result,...(required?{basicChecksPassed:basic.result.ready,sourceReadRequired:true,canSubmit:false}:{})})});
    const source=require('../services/gptVisionExact/preflight');let state;
    if(req.body?.phase==='basic')state=source.ui({code:'OCR_GPT_SOURCE_CHECKING'});
    else try{guestDiagnostic.update(req,{stage:'image_preparation'});
      const pages=basic.pages||await source.pagesFor(file);guestDiagnostic.update(req,{stage:'source_verification'});
      await source.checkPages(pages,context,{run:true,signal:controller.signal,onObservation:guestDiagnostic.observer(req),
      deadlineAt:started+require('../services/gptVisionExact/contract').PREFLIGHT_TIMEOUT_MS});state=source.ui();}
    catch(error){guestDiagnostic.update(req,{errorCode:error.code});state=source.ui(error);}
    if(controller.signal.reason==='source_user_cancelled'||res.destroyed)return;
    return res.json({success:true,data:withPreflightProgress(source.withSourceCheck(basic.result,state))});
  } catch(error){
    guestDiagnostic.update(req,{errorCode:error.code});
    if(error.status===403)return res.status(403).json({success:false,code:error.code,message:'Assignment access is required for handwriting verification.'});
    const source=require('../services/gptVisionExact/preflight');
    return res.json({success:true,data:withPreflightProgress(source.withSourceCheck({ready:false,checks:[]},source.ui(error)))});
  } finally {
    clearTimeout(deadline);req.removeListener('aborted',cancelled);res.removeListener('close',cancelled);
    if(!guestDiagnostic.requestId(req))try{require('../utils/logger').info({event:'source_preflight_request',requestId,phase:req.body?.phase==='basic'?'basic':'source',
      route:req.guestContext?'anonymous':'authenticated',httpStatus:res.statusCode,latencyMs:Date.now()-started});}catch{/* Logging only. */}
    await cleanup(files);
  }
}

async function enforceImagePreflight(req, res, next) {
  const files = requestFiles(req);
  const results = [];
  const required=exact();
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    // PDFs retain their existing validation and processing behavior.
    if (!(file.detectedMime || file.mimetype || '').startsWith('image/')&&!required) continue;
    try{const basic=await basicFor(file,req.user?._id,required);results.push({index,...basic.result,pages:basic.pages});}
    catch(error){results.push({index,ready:false,checks:[],...require('../services/gptVisionExact/preflight').ui(error)});}
  }
  if (results.some(result => !result.ready)) {
    await cleanup(files);
    const failed = results.some(result => result.checks.some(check => check.required && check.status === 'fail'));
    const unavailable = !failed && results.some(result => result.checks.some(check => check.required && check.status === 'unavailable'));
    return res.status(unavailable ? 503 : 422).json({ success: false,
      code: unavailable ? 'IMAGE_PREFLIGHT_UNAVAILABLE' : 'IMAGE_PREFLIGHT_FAILED',
      message: unavailable ? 'We could not check an image. Please retry or choose another photo.'
        : 'An image needs attention. Please check its orientation, resolution and lighting before uploading.',
      data: { images: results.map(({pages,...r})=>r) } });
  }
  if(required){
    const source=require('../services/gptVisionExact/preflight');let pageCount=0;
    try{
      const context=await sourceContext(req);
      for(const entry of results){
        const pages=entry.pages||await source.pagesFor(files[entry.index]);pageCount+=pages.length;
        if(pageCount>20)throw require('../services/gptVisionExact/contract').fail('OCR_PDF_LIMIT');
        files[entry.index].gptSourcePreflight=await source.checkPages(pages,context,{run:Boolean(req.guestContext)});
      }
    }catch(error){
      await cleanup(files);
      if([400,403].includes(error.statusCode||error.status))return res.status(error.statusCode||error.status).json({success:false,message:error.message,code:error.code});
      const state=source.ui(error);
      return res.status(error.status===403?403:state.sourceReadStatus==='FAILED_IMAGE'?422:503).json({success:false,code:state.sourceReadErrorCode,
        message:state.message,data:{...state,ready:false,images:results.map(({pages,...r})=>r)}});
    }
  }
  return next();
}

module.exports = { preflightImage, enforceImagePreflight };
