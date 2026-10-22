'use strict';
// Read-only parent evidence + one missing full-page reader. Never run the pair runner.
const fs=require('fs'),path=require('path'),{randomUUID}=require('crypto');
const source=require('../src/services/sourceFidelityOcr.service'),base=require('./ocr-benchmark-003-live.cjs');
const ROOT=path.resolve(__dirname,'../..'),[ASTRA,FABLE]=base.MODELS;
const PIN=Object.freeze({parentArtifact:'backend/tmp/ocr-benchmark-results/benchmark-003-2026-10-21T16-37-57-152Z-1dfc2079-ee46-4c5f-a2e0-0957ed596291.json',
  parentArtifactSha256:'b84c516be71870bd5f57fe1b5418321ab75a88f035bcb094ce005953e71d80ea',
  promptSha256:'9e41486cde8d8a6177124a43ee587af8acee72547040701f0b0825b4eac987e6',
  schemaSha256:'341df864f563f7362737b4620a1b225e9b418119f69ec0a443f62a1b8917b6e2'});
const fail=code=>Object.assign(Error(code),{code});
const safeCode=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(v)?v:null;
const safeModel=v=>typeof v==='string'&&v.length<=120&&/^[a-z0-9_.:-]+\/[a-z0-9_.:-]+$/i.test(v)?v:null;
function args(values){if(values.length>1||values.length===1&&values[0]!=='--allow-live')throw fail('FABLE_RESUME_USAGE');return {allowLive:values.length===1};}
function parseParent(bytes,pin=PIN,imageManifest=base.MANIFEST){
  if(!Buffer.isBuffer(bytes)||bytes.length>2*1024*1024||source.sha(bytes)!==pin.parentArtifactSha256)throw fail('FABLE_RESUME_PARENT_HASH');
  let p;try{p=JSON.parse(bytes);}catch{throw fail('FABLE_RESUME_PARENT_INVALID');}
  if(p.benchmarkId!=='003'||p.status!=='EVIDENCE_COLLECTION_COMPLETE'||p.providerCalls!==2||p.sourceMutation!==false||p.humanGoldUsed!==false||p.googleCalls!==0
    ||p.imagePathRelative!==imageManifest.imagePathRelative||p.originalSha256!==imageManifest.originalSha256||p.normalizedSha256!==imageManifest.normalizedSha256
    ||p.dimensions?.width!==imageManifest.dimensions.width||p.dimensions?.height!==imageManifest.dimensions.height||p.mimeType!==imageManifest.mimeType
    ||p.promptSha256!==pin.promptSha256||!Array.isArray(p.readers)||p.readers.length!==2)throw fail('FABLE_RESUME_PARENT_INVALID');
  const astra=p.readers.filter(r=>r.requestedModel===ASTRA),fable=p.readers.filter(r=>r.requestedModel===FABLE);
  if(astra.length!==1||fable.length!==1)throw fail('FABLE_RESUME_PARENT_INVALID');const a=astra[0],f=fable[0];
  if(a.returnedModel!==ASTRA||a.outcome!=='SUCCESS'||a.httpStatus!==200||a.schemaValid!==true||a.validationStage!=='SOURCE_CONTRACT_VALIDATED')throw fail('FABLE_RESUME_ASTRA_INVALID');
  try{source.validate(JSON.stringify({activeTranscript:a.activeTranscript,segments:a.segments,uncertainSpans:a.uncertainSpans}));}catch{throw fail('FABLE_RESUME_ASTRA_INVALID');}
  if(f.outcome!=='HTTP_FAILED'||f.httpStatus!==402||f.safeFailureCode!=='AI_PROVIDER_PAYMENT_REQUIRED'||f.schemaValid!==false||f.activeTranscript!==null)throw fail('FABLE_RESUME_HISTORICAL_FAILURE_INVALID');
  return {parent:p,astra:a};
}
async function readParent(){
  const filename=path.resolve(ROOT,PIN.parentArtifact),real=await fs.promises.realpath(filename);
  if(real!==filename)throw fail('FABLE_RESUME_PARENT_PATH');const stat=await fs.promises.stat(real);
  if(!stat.isFile()||stat.size>2*1024*1024)throw fail('FABLE_RESUME_PARENT_INVALID');
  const bytes=await fs.promises.readFile(real);parseParent(bytes);return bytes;
}
function verify(prepared,pin=PIN,imageManifest=base.MANIFEST){
  if(prepared.parentArtifact!==pin.parentArtifact)throw fail('FABLE_RESUME_PARENT_PATH');
  const parent=parseParent(prepared.parentBytes,pin,imageManifest);
  if(source.sha(source.PROMPT)!==pin.promptSha256)throw fail('FABLE_RESUME_PROMPT_CHANGED');
  if(source.sha(JSON.stringify(source.schema))!==pin.schemaSha256)throw fail('FABLE_RESUME_SCHEMA_CHANGED');base.verify(prepared.image,imageManifest);return parent;
}
async function prepare(){
  const parentBytes=await readParent(),image=await base.prepare(base.MANIFEST.imagePathRelative),prepared={parentBytes,image,parentArtifact:PIN.parentArtifact};verify(prepared);return prepared;
}
function pairComparison(a,f){
  if(!f.schemaValid)return null;
  return {activeTextExactEqual:a.activeTranscript===f.activeTranscript,
    segmentSignatureEqual:JSON.stringify(a.segments.map(s=>[s.type,s.text]))===JSON.stringify(f.segments.map(s=>[s.type,s.text])),
    hasUncertainty:[a,f].some(r=>r.uncertainSpans.length||r.segments.some(s=>s.type==='UNCERTAIN')),
    lineCountAstra:a.activeTranscript.length?a.activeTranscript.split('\n').length:0,lineCountFable:f.activeTranscript.length?f.activeTranscript.split('\n').length:0,
    characterLengthAstra:a.activeTranscript.length,characterLengthFable:f.activeTranscript.length};
}
async function runResume(prepared,{allowLive=false,env=process.env,fetchImpl=global.fetch,pin=PIN,imageManifest=base.MANIFEST}={}){
  if(!['development','test',undefined,''].includes(env.NODE_ENV))throw fail('FABLE_RESUME_LOCAL_ONLY');
  const {astra}=verify(prepared,pin,imageManifest),image=prepared.image;
  const result={benchmarkId:'003',resumeType:'FABLE_ONLY',parentArtifact:pin.parentArtifact,parentArtifactSha256:pin.parentArtifactSha256,
    imagePathRelative:image.imagePathRelative,originalSha256:image.originalSha256,normalizedSha256:image.normalizedSha256,dimensions:image.dimensions,mimeType:image.mimeType,
    promptSha256:pin.promptSha256,schemaSha256:pin.schemaSha256,providerCallLimit:1,fableCallLimit:1,providerCalls:0,astraProviderCallsThisRun:0,fableProviderCallsThisRun:0,
    originalAstraReused:true,sourceMutation:false,humanGoldUsed:false,googleCalls:0,liveAuthorized:allowLive,combinedDiagnostic:null};
  if(!allowLive)return {...result,status:'PREFLIGHT_ONLY'};
  const readerEnv={...env,OCR_ASTRA_MODEL:ASTRA,OCR_FABLE_MODEL:FABLE};source.config(readerEnv);
  // Validate endpoint configuration before reader/network admission; never probe balance.
  if((readerEnv.OPENROUTER_BASE_URL||'https://openrouter.ai/api/v1').replace(/\/$/u,'')!=='https://openrouter.ai/api/v1')throw fail('FABLE_RESUME_CONFIGURATION_INVALID');
  const trace={},started=Date.now();let value=null,error=null;
  const boundedFetch=async(url,options)=>{
    verify(prepared,pin,imageManifest);base.strictRequest(url,options,FABLE,image);
    if(result.providerCalls>=1||result.fableProviderCallsThisRun>=1)throw fail('FABLE_RESUME_CALL_LIMIT');
    result.providerCalls++;result.fableProviderCallsThisRun++;
    const response=await fetchImpl(url,options);trace.httpStatus=Number.isInteger(response.status)?response.status:null;
    const text=response.text.bind(response);response.text=async()=>{const raw=await text();try{if(Buffer.byteLength(raw)<=500000){const envelope=JSON.parse(raw);trace.returnedModel=safeModel(envelope.model);trace.usage=source.safeUsage(envelope.usage);}}catch{}return raw;};return response;
  };
  try{value=await source.reader({model:FABLE,bytes:image.bytes,mimeType:image.mimeType,prompt:source.PROMPT,targeted:false,env:readerEnv,fetchImpl:boundedFetch,
    onDiagnostic:d=>{trace.failureStage=safeCode(d.failureStage);trace.httpStatus=d.httpStatus??trace.httpStatus;}});
    if(value.returnedModel!==FABLE)throw fail('OCR_SOURCE_MODEL_IDENTITY');
  }catch(e){error=e;value=null;}
  const usage=source.safeUsage(value?.usage||trace.usage),fable={requestedModel:FABLE,returnedModel:value?.returnedModel||trace.returnedModel||null,
    outcome:error?base.failureOutcome(error,trace):'SUCCESS',httpStatus:trace.httpStatus??null,
    transportOutcome:trace.httpStatus?(trace.httpStatus>=200&&trace.httpStatus<300?'HTTP_SUCCESS':'HTTP_FAILED'):'TRANSPORT_FAILED',
    validationStage:!error?'SOURCE_CONTRACT_VALIDATED':error.code==='OCR_SOURCE_MODEL_IDENTITY'?'MODEL_IDENTITY':error.code==='OCR_SOURCE_SCHEMA'?'SOURCE_SCHEMA':error.code==='OCR_SOURCE_TRANSCRIPT_MISMATCH'?'SOURCE_CONTRACT':trace.failureStage||'TRANSPORT',
    safeFailureCode:error?safeCode(error.code)||'SOURCE_READER_REJECTED':null,durationMs:value?.durationMs??Date.now()-started,usage,reportedCost:usage.cost??null,schemaValid:Boolean(value),
    activeTranscript:value?.value.activeTranscript??null,segments:value?.value.segments??null,uncertainSpans:value?.value.uncertainSpans??null,
    ...(value?base.deletionAudit(value.value):{activeSegmentCount:null,deletedSegmentCount:null,artifactSegmentCount:null,uncertainSegmentCount:null,deletedTextPresentInActiveTranscriptCheck:{status:'NOT_EVALUABLE',segments:[]}})};
  // Provenance lives outside the untouched reader objects, so the Astra copy is exact.
  result.combinedDiagnostic={readers:[{evidenceOrigin:'ORIGINAL_BENCHMARK_003_LIVE_ARTIFACT',reader:astra},{evidenceOrigin:'FABLE_RESUME_LIVE_CALL',reader:fable}],pair:pairComparison(astra,fable)};
  return {...result,status:value?'FABLE_RESUME_COMPLETE':'FABLE_RESUME_FAILED'};
}
async function reserveResult(){
  const directory=path.resolve(__dirname,'../tmp/ocr-benchmark-results');await fs.promises.mkdir(directory,{recursive:true,mode:0o700});
  if(await fs.promises.realpath(directory)!==directory)throw fail('FABLE_RESUME_OUTPUT_REDIRECTED');
  const filename=path.join(directory,'benchmark-003-fable-resume-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID()+'.json'),handle=await fs.promises.open(filename,'wx',0o600);
  return {filename,handle,async write(result){const bytes=Buffer.from(JSON.stringify(result,null,2)+'\n');let offset=0;
    while(offset<bytes.length){const {bytesWritten}=await handle.write(bytes,offset,bytes.length-offset,offset);if(!bytesWritten)throw fail('FABLE_RESUME_OUTPUT_WRITE_FAILED');offset+=bytesWritten;}
    await handle.truncate(bytes.length);await handle.sync();}};
}
async function main(){
  const options=args(process.argv.slice(2));require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
  if(!['development','test',undefined,''].includes(process.env.NODE_ENV))throw fail('FABLE_RESUME_LOCAL_ONLY');
  const prepared=await prepare();
  if(options.allowLive){source.config({...process.env,OCR_ASTRA_MODEL:ASTRA,OCR_FABLE_MODEL:FABLE});if((process.env.OPENROUTER_BASE_URL||'https://openrouter.ai/api/v1').replace(/\/$/u,'')!=='https://openrouter.ai/api/v1')throw fail('FABLE_RESUME_CONFIGURATION_INVALID');}
  const output=await reserveResult();try{
    await output.write({benchmarkId:'003',resumeType:'FABLE_ONLY',parentArtifact:PIN.parentArtifact,parentArtifactSha256:PIN.parentArtifactSha256,status:'PREFLIGHT_VERIFIED',providerCalls:0,sourceMutation:false});
    console.log(`BENCHMARK=003\nRESUME_READER=FABLE_ONLY\nIMAGE_VERIFIED=true\nNORMALIZED_IMAGE_SHA256=${prepared.image.normalizedSha256}\nORIGINAL_ASTRA_REUSED=true\nASTRA_PROVIDER_CALLS_PLANNED=0\nFABLE_PROVIDER_CALLS_PLANNED=1\nTOTAL_PROVIDER_CALLS_PLANNED=1\nFABLE_MODEL=${FABLE}\nHUMAN_GOLD_USED=false\nGOOGLE_CALLS=0\nSOURCE_MUTATION=false`);
    const current=await prepare(),result=await runResume(current,{allowLive:options.allowLive});
    try{result.parentArtifactUnchanged=source.sha(await readParent())===PIN.parentArtifactSha256;}catch{result.parentArtifactUnchanged=null;result.parentCheckStatus='READ_FAILED_OR_CHANGED';}
    await output.write(result);const f=result.combinedDiagnostic?.readers[1].reader;
    console.log(JSON.stringify({status:result.status,output:path.relative(ROOT,output.filename).split(path.sep).join('/'),providerCalls:result.providerCalls,astraProviderCallsThisRun:0,parentArtifactUnchanged:result.parentArtifactUnchanged,
      fableOutcome:f?.outcome||null,safeFailureCode:f?.safeFailureCode||null}));
    if(result.status==='FABLE_RESUME_FAILED'||result.parentArtifactUnchanged!==true)process.exitCode=1;
  }finally{await output.handle.close();}
}
if(require.main===module)main().catch(e=>{console.error(safeCode(e.code)||'FABLE_RESUME_PREFLIGHT_FAILED');process.exitCode=1;});
module.exports={PIN,ASTRA,FABLE,args,parseParent,verify,prepare,pairComparison,runResume,reserveResult};
