'use strict';
// File-only blind evidence collection. No application jobs, source state or database.
const fs=require('fs'),path=require('path'),{randomUUID}=require('crypto');
const source=require('../src/services/sourceFidelityOcr.service'),MANIFEST=require('./lib/ocrBenchmark003Manifest.cjs');
const MODELS=Object.freeze(['openai/gpt-6-astra','anthropic/claude-fable-5.1']);
const ROOT=path.resolve(__dirname,'../..');
const fail=code=>Object.assign(Error(code),{code});
const safeCode=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(v)?v:null;
const safeModel=v=>typeof v==='string'&&v.length<=120&&/^[a-z0-9_.:-]+\/[a-z0-9_.:-]+$/i.test(v)?v:null;
function args(values){
  if(![2,3].includes(values.length)||values[0]!=='--image'||values[1]!==MANIFEST.imagePathRelative
    ||values.length===3&&values[2]!=='--allow-live')throw fail('BENCHMARK_USAGE');
  return {imagePathRelative:values[1],allowLive:values.length===3};
}
async function normalize(original,manifest=MANIFEST){
  if(!Buffer.isBuffer(original)||!original.length||original.length>20*1024*1024||source.sha(original)!==manifest.originalSha256
    ||original[0]!==255||original[1]!==216||original[2]!==255)throw fail('BENCHMARK_ORIGINAL_IDENTITY');
  const sharp=require('sharp'),image=sharp(original,{failOn:'error',limitInputPixels:40000000}),before=await image.metadata();
  if(before.format!=='jpeg'||(before.pages||1)!==1)throw fail('BENCHMARK_IMAGE_INVALID');
  // Match existing OCR normalization exactly. No resize, crop, enhancement or OCR.
  const bytes=await image.rotate().toBuffer(),meta=await sharp(bytes,{limitInputPixels:40000000}).metadata();
  const prepared={imagePathRelative:manifest.imagePathRelative,originalSha256:source.sha(original),normalizedSha256:source.sha(bytes),
    dimensions:{width:meta.width,height:meta.height},mimeType:'image/jpeg',bytes};
  if(meta.format!=='jpeg')throw fail('BENCHMARK_IMAGE_INVALID');verify(prepared,manifest);return prepared;
}
async function prepare(imagePathRelative){
  if(imagePathRelative!==MANIFEST.imagePathRelative)throw fail('BENCHMARK_IMAGE_PATH');
  const filename=path.resolve(ROOT,imagePathRelative),real=await fs.promises.realpath(filename);
  if(real!==filename)throw fail('BENCHMARK_IMAGE_PATH');
  const stat=await fs.promises.stat(real);if(!stat.isFile()||stat.size>20*1024*1024)throw fail('BENCHMARK_IMAGE_INVALID');
  return normalize(await fs.promises.readFile(real));
}
function verify(p,m=MANIFEST){
  if(p.imagePathRelative!==m.imagePathRelative||p.originalSha256!==m.originalSha256||p.normalizedSha256!==m.normalizedSha256
    ||!Buffer.isBuffer(p.bytes)||!p.bytes.length||p.bytes.length>20*1024*1024||source.sha(p.bytes)!==m.normalizedSha256
    ||p.dimensions?.width!==m.dimensions.width||p.dimensions?.height!==m.dimensions.height||p.mimeType!==m.mimeType)throw fail('BENCHMARK_NORMALIZED_IDENTITY');
}
function deletionAudit(value){
  const segments=value.segments,deleted=segments.map((s,index)=>({s,index})).filter(({s})=>s.type==='CROSSED_OUT_OR_DELETED');
  const checks=deleted.map(({s,index})=>({segmentIndex:index,status:typeof s.text!=='string'||s.text.length===0?'NOT_EVALUABLE':
    value.activeTranscript.includes(s.text)?'LITERAL_OVERLAP_FLAGGED':'NO_LITERAL_OVERLAP_FOUND'}));
  const status=checks.some(c=>c.status==='LITERAL_OVERLAP_FLAGGED')?'LITERAL_OVERLAP_FLAGGED':checks.some(c=>c.status==='NOT_EVALUABLE')?'NOT_EVALUABLE':checks.length?'NO_LITERAL_OVERLAP_FOUND':'NO_DELETED_SEGMENTS';
  return {activeSegmentCount:segments.filter(s=>s.type==='ACTIVE_STUDENT_TEXT').length,deletedSegmentCount:deleted.length,
    artifactSegmentCount:segments.filter(s=>s.type==='NON_STUDENT_ARTIFACT').length,uncertainSegmentCount:segments.filter(s=>s.type==='UNCERTAIN').length,
    deletedTextPresentInActiveTranscriptCheck:{status,segments:checks,interpretation:'Literal returned-text overlap only; not proof of the same physical occurrence or source leakage. Unknown/empty deleted text is not evaluable.'}};
}
function failureOutcome(error,trace){
  if(error?.code==='AI_ATTEMPT_TIMEOUT'||trace.failureStage==='REQUEST_ABORTED')return 'TIMEOUT';
  if(error?.code==='OCR_SOURCE_MODEL_IDENTITY')return 'MODEL_ID_MISMATCH';
  if(error?.code==='OCR_SOURCE_TRANSCRIPT_MISMATCH')return 'SOURCE_CONTRACT_VALIDATION_FAILED';
  if(error?.code==='OCR_SOURCE_SCHEMA'||['RESPONSE_JSON_PARSE_FAILURE','PROVIDER_RESPONSE_SHAPE_INVALID','MODEL_STRUCTURED_OUTPUT_INVALID'].includes(trace.failureStage))return 'SCHEMA_VALIDATION_FAILED';
  if(trace.httpStatus&&!(trace.httpStatus>=200&&trace.httpStatus<300)||trace.failureStage==='HTTP_ERROR_RESPONSE')return 'HTTP_FAILED';
  return 'TRANSPORT_FAILED';
}
function strictRequest(url,options,model,p){
  if(url!=='https://openrouter.ai/api/v1/chat/completions'||options.method!=='POST'||options.redirect!=='error')throw fail('BENCHMARK_WIRE_CONTRACT');
  let body;try{body=JSON.parse(options.body);}catch{throw fail('BENCHMARK_WIRE_CONTRACT');}
  if(Object.keys(body).sort().join('|')!==['model','messages','max_completion_tokens','response_format','provider'].sort().join('|')
    ||body.model!==model||body.max_completion_tokens!==12000||JSON.stringify(body.provider)!==JSON.stringify({require_parameters:true,allow_fallbacks:false})
    ||body.response_format?.type!=='json_schema'||body.response_format?.json_schema?.strict!==true
    ||JSON.stringify(body.response_format.json_schema.schema)!==JSON.stringify(source.schema)
    ||JSON.stringify(body.messages)!==JSON.stringify(source.readerMessages({bytes:p.bytes,mimeType:p.mimeType,prompt:source.PROMPT,targeted:false})))throw fail('BENCHMARK_WIRE_CONTRACT');
}
async function runPair(prepared,{allowLive=false,env=process.env,fetchImpl=global.fetch,manifest=MANIFEST}={}){
  if(!['development','test',undefined,''].includes(env.NODE_ENV))throw fail('BENCHMARK_LOCAL_ONLY');
  verify(prepared,manifest);
  const result={benchmarkId:'003',imagePathRelative:prepared.imagePathRelative,originalSha256:prepared.originalSha256,
    normalizedSha256:prepared.normalizedSha256,dimensions:prepared.dimensions,mimeType:prepared.mimeType,promptSha256:source.sha(source.PROMPT),
    providerCallLimit:2,astraCallLimit:1,fableCallLimit:1,providerCalls:0,sourceMutation:false,humanGoldUsed:false,googleCalls:0,liveAuthorized:allowLive,readers:[]};
  if(!allowLive)return {...result,status:'PREFLIGHT_ONLY'};
  // Benchmark identities are explicit, not inherited from another feature's model configuration.
  const readerEnv={...env,OCR_ASTRA_MODEL:MODELS[0],OCR_FABLE_MODEL:MODELS[1]};source.config(readerEnv);
  const counts=new Map();
  for(const model of MODELS){
    const trace={},started=Date.now();let value=null,error=null;
    const boundedFetch=async(url,options)=>{
      verify(prepared,manifest);strictRequest(url,options,model,prepared);
      if(result.providerCalls>=2||(counts.get(model)||0)>=1)throw fail('BENCHMARK_CALL_LIMIT');
      counts.set(model,1);result.providerCalls++;
      const response=await fetchImpl(url,options);trace.httpStatus=Number.isInteger(response.status)?response.status:null;
      const text=response.text.bind(response);
      response.text=async()=>{const raw=await text();try{if(Buffer.byteLength(raw)<=500000){const envelope=JSON.parse(raw);
        trace.returnedModel=safeModel(envelope.model);trace.usage=source.safeUsage(envelope.usage);}}catch{}return raw;};
      return response;
    };
    try{value=await source.reader({model,bytes:prepared.bytes,mimeType:prepared.mimeType,prompt:source.PROMPT,targeted:false,env:readerEnv,fetchImpl:boundedFetch,
      onDiagnostic:d=>{trace.failureStage=safeCode(d.failureStage);trace.httpStatus=d.httpStatus??trace.httpStatus;}});
      if(value.returnedModel!==model)throw fail('OCR_SOURCE_MODEL_IDENTITY');
    }catch(e){error=e;value=null;}
    const usage=source.safeUsage(value?.usage||trace.usage),outcome=error?failureOutcome(error,trace):'SUCCESS';
    const validationStage=!error?'SOURCE_CONTRACT_VALIDATED':error.code==='OCR_SOURCE_MODEL_IDENTITY'?'MODEL_IDENTITY':error.code==='OCR_SOURCE_SCHEMA'?'SOURCE_SCHEMA':error.code==='OCR_SOURCE_TRANSCRIPT_MISMATCH'?'SOURCE_CONTRACT':trace.failureStage||'TRANSPORT';
    result.readers.push({requestedModel:model,returnedModel:value?.returnedModel||trace.returnedModel||null,outcome,httpStatus:trace.httpStatus??null,
      transportOutcome:trace.httpStatus?(trace.httpStatus>=200&&trace.httpStatus<300?'HTTP_SUCCESS':'HTTP_FAILED'):'TRANSPORT_FAILED',validationStage,
      safeFailureCode:error?safeCode(error.code)||'SOURCE_READER_REJECTED':null,durationMs:value?.durationMs??Date.now()-started,usage,reportedCost:usage.cost??null,schemaValid:Boolean(value),
      activeTranscript:value?.value.activeTranscript??null,segments:value?.value.segments??null,uncertainSpans:value?.value.uncertainSpans??null,
      ...(value?deletionAudit(value.value):{activeSegmentCount:null,deletedSegmentCount:null,artifactSegmentCount:null,uncertainSegmentCount:null,deletedTextPresentInActiveTranscriptCheck:{status:'NOT_EVALUABLE',segments:[]}})});
  }
  const [a,b]=result.readers,complete=a.schemaValid&&b.schemaValid;
  result.pair={activeTextExactEqual:complete?a.activeTranscript===b.activeTranscript:null,
    segmentSignatureEqual:complete?JSON.stringify(a.segments.map(s=>[s.type,s.text]))===JSON.stringify(b.segments.map(s=>[s.type,s.text])):null,
    hasUncertainty:complete?[a,b].some(r=>r.uncertainSpans.length||r.segments.some(s=>s.type==='UNCERTAIN')):null};
  return {...result,status:'EVIDENCE_COLLECTION_COMPLETE'};
}
async function reserveResult(){
  const directory=path.resolve(__dirname,'../tmp/ocr-benchmark-results');await fs.promises.mkdir(directory,{recursive:true,mode:0o700});
  if(await fs.promises.realpath(directory)!==directory)throw fail('BENCHMARK_OUTPUT_REDIRECTED');
  const filename=path.join(directory,'benchmark-003-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID()+'.json');
  const handle=await fs.promises.open(filename,'wx',0o600);
  return {filename,handle,async write(result){const bytes=Buffer.from(JSON.stringify(result,null,2)+'\n');let offset=0;
    while(offset<bytes.length){const {bytesWritten}=await handle.write(bytes,offset,bytes.length-offset,offset);if(!bytesWritten)throw fail('BENCHMARK_OUTPUT_WRITE_FAILED');offset+=bytesWritten;}
    await handle.truncate(bytes.length);await handle.sync();}};
}
async function main(){
  const options=args(process.argv.slice(2));require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
  if(!['development','test',undefined,''].includes(process.env.NODE_ENV))throw fail('BENCHMARK_LOCAL_ONLY');
  const prepared=await prepare(options.imagePathRelative),output=await reserveResult();
  try{
    await output.write({benchmarkId:'003',status:'PREFLIGHT_VERIFIED',originalSha256:prepared.originalSha256,normalizedSha256:prepared.normalizedSha256,providerCalls:0,sourceMutation:false});
    console.log(`BENCHMARK=003\nIMAGE_VERIFIED=true\nNORMALIZED_IMAGE_SHA256=${prepared.normalizedSha256}\nIMAGE_WIDTH=${prepared.dimensions.width}\nIMAGE_HEIGHT=${prepared.dimensions.height}\nPLANNED_PROVIDER_CALLS=2\nASTRA_MODEL=${MODELS[0]}\nFABLE_MODEL=${MODELS[1]}\nSOURCE_MUTATION=false`);
    const current=await prepare(options.imagePathRelative),result=await runPair(current,{allowLive:options.allowLive});await output.write(result);
    console.log(JSON.stringify({benchmarkId:'003',status:result.status,output:path.relative(ROOT,output.filename).split(path.sep).join('/'),providerCalls:result.providerCalls,sourceMutation:false,
      readers:result.readers.map(r=>({requestedModel:r.requestedModel,outcome:r.outcome,safeFailureCode:r.safeFailureCode}))}));
  }finally{await output.handle.close();}
}
if(require.main===module)main().catch(e=>{console.error(safeCode(e.code)?.startsWith('BENCHMARK_')?e.code:'BENCHMARK_PREFLIGHT_FAILED');process.exitCode=1;});
module.exports={MANIFEST,MODELS,args,normalize,prepare,verify,deletionAudit,failureOutcome,strictRequest,runPair,reserveResult};
