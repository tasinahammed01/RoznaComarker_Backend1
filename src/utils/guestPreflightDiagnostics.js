'use strict';
const {randomUUID}=require('crypto');
const logger=require('./logger');
const requests=new WeakMap();
const STAGES=['guest_access','guest_context','image_input','image_signature','preflight','source_context',
  'basic_quality','image_preparation','source_verification','cache_validation','provider_request','source_validation'];
const VALIDATION=['PROVIDER_REQUEST','MODEL_IDENTITY_VALIDATION','JSON_OR_SCHEMA_VALIDATION','SOURCE_CONTRACT_VALIDATION',
  'SOURCE_AMBIGUITY_VALIDATION','CACHE_VALIDATION','ACCEPTED','REQUEST_BUILD_FAILURE','TRANSPORT_FAILURE','RESPONSE_BODY_READ_FAILURE',
  'HTTP_ERROR_RESPONSE','RESPONSE_JSON_PARSE_FAILURE','PROVIDER_RESPONSE_SHAPE_INVALID','REQUEST_ABORTED'];
const STATUSES=['CHECKING','PASSED','FAILED_IMAGE','FAILED_SERVICE'];
const code=value=>(typeof value==='string'&&/^(?:OCR_|AI_|IMAGE_|GUEST_|UPLOAD_|LIMIT_)[A-Z0-9_]{1,72}$/.test(value)
  ||['PAYLOAD_TOO_LARGE','INVALID_FILE_SIGNATURE','UNSUPPORTED_FILE_TYPE','RATE_LIMITED',
    'RESUBMISSION_NOT_ALLOWED','ADAPTIVE_PRACTICE_REQUIRED'].includes(value))?value:null;
function update(req,value={}){
  const c=requests.get(req);if(!c)return;
  if(STAGES.includes(value.stage))c.stage=value.stage;
  if(['basic','source'].includes(value.phase))c.phase=value.phase;
  if(VALIDATION.includes(value.validationStage))c.validationStage=value.validationStage;
  if(code(value.errorCode))c.errorCode=code(value.errorCode);
  for(const k of ['qwenInvoked','cacheUsed'])if(typeof value[k]==='boolean')c[k]=c[k]===true||value[k];
  if(typeof value.basicChecksPassed==='boolean')c.basicChecksPassed=value.basicChecksPassed;
  if(Number.isInteger(value.providerHttpStatus)&&value.providerHttpStatus>=100&&value.providerHttpStatus<=599)c.providerHttpStatus=value.providerHttpStatus;
  if(['local_attempt_timeout','shared_stage_deadline','source_preflight_deadline','caller_cancelled'].includes(value.timeoutOrigin))c.timeoutOrigin=value.timeoutOrigin;
}
function outcome(c,status){
  if(!c.responseCompleted)return 'unknown';
  if(c.sourceReadStatus==='FAILED_IMAGE')return 'image_rejected';
  if(c.sourceReadStatus==='FAILED_SERVICE')return 'service_unavailable';
  if(c.sourceReadStatus==='CHECKING')return 'unknown';
  if(status>=200&&status<300&&c.responseSuccess===true&&c.ready===true&&(!c.sourceReadRequired||c.sourceReadStatus==='PASSED'&&c.canSubmit===true))return 'passed';
  if(c.basicImageRejected)return 'image_rejected';
  if(c.basicUnavailable||status>=500||c.errorCode==='GUEST_SUBMISSION_UNAVAILABLE')return 'service_unavailable';
  if(['image_input','image_signature'].includes(c.stage)&&[400,413,415,422].includes(status))return 'image_rejected';
  return 'unknown';
}
function start(req,res,next){
  try{
    const c={requestId:randomUUID(),started:Date.now(),phase:null,stage:'guest_access',qwenInvoked:false,cacheUsed:null,
      responseSuccess:null,sourceReadStatus:null,sourceReadRequired:null,ready:null,canSubmit:null,validationStage:null,
      errorCode:null,providerHttpStatus:null,timeoutOrigin:null,responseCompleted:false};
    requests.set(req,c);res.set('X-Request-ID',c.requestId);
    const original=res.json;
    res.json=function(body){
      try{
        const data=body?.data;
        c.phase=req.body?.phase==='basic'?'basic':req.body&&Object.hasOwn(req.body,'phase')?'source':c.phase;
        c.responseSuccess=typeof body?.success==='boolean'?body.success:null;
        c.sourceReadStatus=STATUSES.includes(data?.sourceReadStatus)?data.sourceReadStatus:null;
        for(const k of ['ready','canSubmit','sourceReadRequired','basicChecksPassed'])if(typeof data?.[k]==='boolean')c[k]=data[k];
        c.errorCode=code(data?.sourceReadErrorCode)||code(body?.code)||c.errorCode;
        const checks=Array.isArray(data?.checks)?data.checks:[];
        c.basicImageRejected=checks.some(x=>x?.required===true&&x.status==='fail');
        c.basicUnavailable=checks.some(x=>x?.required===true&&x.status==='unavailable');
      }catch{/* Observation cannot alter response handling. */}
      return original.call(this,body);
    };
    let emitted=false;
    const emit=completed=>{
      if(emitted)return;emitted=true;c.responseCompleted=completed;
      try{
        const httpStatus=res.headersSent||completed?res.statusCode:null;
        const finalOutcome=outcome(c,httpStatus);
        const failed=['image_rejected','service_unavailable'].includes(finalOutcome)||c.responseSuccess===false;
        logger.metric({event:'guest_image_preflight_result',timestamp:new Date().toISOString(),correlationId:c.requestId,
          feature:'guest_image_preflight',phase:c.phase,stage:c.stage,httpStatus,responseCompleted:completed,
          responseSuccess:c.responseSuccess,sourceReadStatus:c.sourceReadStatus,sourceReadRequired:c.sourceReadRequired,
          ready:c.ready,canSubmit:c.canSubmit,basicChecksPassed:c.basicChecksPassed??null,
          finalOutcome,errorCode:c.errorCode,failureStage:failed?c.validationStage||c.stage:null,
          durationMs:Math.max(0,Date.now()-c.started),qwenInvoked:c.qwenInvoked,cacheUsed:c.cacheUsed,
          providerHttpStatus:c.providerHttpStatus,timeoutOrigin:c.timeoutOrigin,
          circuitOpen:c.errorCode==='OCR_GPT_CIRCUIT_OPEN'?true:null});
      }catch{/* Logging must never disrupt an upload, including logger failure. */}
    };
    res.once('finish',()=>emit(true));res.once('close',()=>emit(false));
  }catch{/* No diagnostic dependency can become an access/availability gate. */}
  next();
}
const stage=name=>(req,_res,next)=>{update(req,{stage:name});next();};
const requestId=req=>requests.get(req)?.requestId;
const observer=req=>requests.has(req)?value=>{try{update(req,value);}catch{/* Observer only. */}}:undefined;
module.exports={start,stage,update,requestId,observer};
