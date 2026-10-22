'use strict';
// Developer-only two-view diagnostic. No application pipeline or persistence imports.
const fs=require('fs'),path=require('path');
const source=require('../src/services/sourceFidelityOcr.service');
const targeted=require('../src/services/sourceFidelity/targetedVerification');
const {retrieve}=require('./targeted-v2-failure-audit.cjs');
const {PIN}=require('./targeted-v2-live-smoke.cjs');
const visual=require('../src/services/sourceFidelity/visualContextV3');
const MANIFEST=require('./lib/targetedV3Manifest.cjs');
const fail=code=>Object.assign(Error(code),{code});
const safeCode=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(v)?v:null;
const safeModel=v=>typeof v==='string'&&v.length<=120&&/^[a-z0-9_.:-]+\/[a-z0-9_.:-]+$/i.test(v)?v:null;
let preflightVerified=false;
function args(values){
  if(values.length!==4&&values.length!==5||values[0]!=='--submission'||values[1]!==PIN.submissionId
    ||values[2]!=='--slot'||values[3]!=='8'||values.length===5&&values[4]!=='--allow-live')throw fail('SMOKE_USAGE');
  return {submissionId:values[1],slot:8,allowLive:values.includes('--allow-live')};
}
async function prepare(evidence,readFile=fs.promises.readFile){
  if(evidence.submissionId!==PIN.submissionId||evidence.ocrJobId!==PIN.jobId)throw fail('SMOKE_JOB_IDENTITY');
  const pages=evidence.pages.filter(p=>p.inputSha256===PIN.inputSha256&&p.pageNumber===1);
  if(pages.length!==1)throw fail('SMOKE_INPUT_IDENTITY');const page=pages[0],region=page.targeted?.results?.[7]?.region;
  if(!region||region.id!==PIN.regionId||region.inputSha256!==PIN.inputSha256||region.fileId!==page.fileId||region.pageNumber!==1
    ||region.cropSha256!==PIN.cropSha256||region.cropDimensions?.width!==PIN.width||region.cropDimensions?.height!==PIN.height)throw fail('SMOKE_REGION_IDENTITY');
  if(source.sha(page.astra.activeTranscript)!==page.exactTextSha256||page.exactText!==page.astra.activeTranscript
    ||source.sha(evidence.sourceTranscriptExact)!==evidence.sourceTranscriptSha256)throw fail('SMOKE_SOURCE_HASH');
  const root=path.resolve(__dirname,'..'),stored=evidence.localFiles.find(f=>f.fileId===page.fileId)?.path;
  const filename=stored?path.resolve(root,stored):null;if(!filename||!filename.startsWith(path.join(root,'uploads')+path.sep))throw fail('SMOKE_LOCAL_IMAGE_PATH');
  const real=await fs.promises.realpath(filename);if(!real.startsWith(path.join(root,'uploads')+path.sep))throw fail('SMOKE_LOCAL_IMAGE_PATH');
  const normalized=await require('sharp')(await readFile(real),{failOn:'error',limitInputPixels:40000000}).rotate().toBuffer();
  if(source.sha(normalized)!==PIN.inputSha256)throw fail('SMOKE_INPUT_SHA');
  const crop=await targeted.crop(normalized,region,page.google.nativePages[0]);
  if(crop.cropSha256!==PIN.cropSha256||crop.cropDimensions.width!==PIN.width||crop.cropDimensions.height!==PIN.height)throw fail('SMOKE_CROP_SHA');
  const plan=targeted.discover({astra:page.astra,fable:page.fable,google:page.google.nativePages[0],identity:{fileId:page.fileId,pageNumber:page.pageNumber,inputSha256:page.inputSha256}});
  const bundle=await visual.bundle(normalized,region,page.google.nativePages[0],plan.signals);
  const prepared={page,region,crop:bundle,evidence,historicalCrop:{cropSha256:crop.cropSha256,cropDimensions:crop.cropDimensions}};
  verifyBundle(prepared);return prepared;
}
function verifyBundle(prepared,manifest=MANIFEST){
  const {page,region,crop,evidence}=prepared;
  if(evidence?.submissionId!==PIN.submissionId||evidence?.ocrJobId!==PIN.jobId||evidence?.sourceTranscriptSha256!==manifest.sourceTranscriptSha256
    ||source.sha(evidence.sourceTranscriptExact)!==manifest.sourceTranscriptSha256||page.inputSha256!==manifest.inputSha256
    ||region.id!==PIN.regionId||region.fileId!==page.fileId||region.pageNumber!==page.pageNumber||region.inputSha256!==manifest.inputSha256
    ||!crop.images||crop.images.length!==2||crop.audit?.inputSha256!==manifest.inputSha256)throw fail('SMOKE_V3_IDENTITY');
  for(const [i,view] of crop.images.entries()){
    const hash=i?manifest.focusSha256:manifest.contextSha256,d=i?manifest.focusDimensions:manifest.contextDimensions;
    if(source.sha(view.bytes)!==hash||view.sha256!==hash||view.dimensions.width!==d.width||view.dimensions.height!==d.height)throw fail('SMOKE_V3_BUNDLE_SHA');
  }
  if(!crop.bytes.equals(crop.images[0].bytes)||crop.cropSha256!==manifest.contextSha256)throw fail('SMOKE_V3_BUNDLE_SHA');
}
function failureOutcome(error,trace){
  const code=error?.sourceReaderDiagnostic?.failureCode||error?.code;
  if(code==='AI_ATTEMPT_TIMEOUT'||trace.failureStage==='REQUEST_ABORTED')return 'TIMEOUT';
  if(code==='OCR_SOURCE_MODEL_IDENTITY')return 'MODEL_ID_MISMATCH';
  if(code==='OCR_SOURCE_TRANSCRIPT_MISMATCH')return 'SOURCE_CONTRACT_VALIDATION_FAILED';
  if(code==='OCR_SOURCE_SCHEMA'||['RESPONSE_JSON_PARSE_FAILURE','PROVIDER_RESPONSE_SHAPE_INVALID','MODEL_STRUCTURED_OUTPUT_INVALID'].includes(trace.failureStage))return 'SCHEMA_VALIDATION_FAILED';
  if(trace.httpStatus&&!(trace.httpStatus>=200&&trace.httpStatus<300))return 'HTTP_FAILED';
  return 'TRANSPORT_FAILED';
}
function strictRequest(url,options,model,crop){
  if(url!=='https://openrouter.ai/api/v1/chat/completions'||options.method!=='POST')throw fail('SMOKE_WIRE_CONTRACT');
  let b;try{b=JSON.parse(options.body);}catch{throw fail('SMOKE_WIRE_CONTRACT');}
  const keys=['model','messages','max_completion_tokens','response_format','provider'];
  if(Object.keys(b).sort().join('|')!==keys.sort().join('|')||b.model!==model||b.max_completion_tokens!==12000
    ||JSON.stringify(b.provider)!==JSON.stringify({require_parameters:true,allow_fallbacks:false})
    ||JSON.stringify(b.response_format?.json_schema?.schema)!==JSON.stringify(source.schema)||b.response_format?.json_schema?.strict!==true
    ||JSON.stringify(b.messages)!==JSON.stringify(source.readerMessages({bytes:crop.bytes,mimeType:'image/png',prompt:visual.PROMPT,targeted:true,images:crop.images})))throw fail('SMOKE_WIRE_CONTRACT');
}
async function runPair(prepared,{allowLive=false,env=process.env,fetchImpl=global.fetch,manifest=MANIFEST}={}){
  if(!['development','test'].includes(env.NODE_ENV))throw fail('SMOKE_LOCAL_ONLY');
  const models=source.config(env),{page,region,crop}=prepared;
  // Verify the supplied prepared object again before the only reachable network path.
  verifyBundle(prepared,manifest);
  const result={submissionId:PIN.submissionId,jobId:PIN.jobId,slot:8,regionId:region.id,inputSha256:PIN.inputSha256,
    cropSha256:crop.cropSha256,cropDimensions:crop.cropDimensions,visualAudit:crop.audit,promptSha256:source.sha(visual.PROMPT),
    sourceMutation:false,providerCallLimit:2,providerCalls:0,readers:[],liveAuthorized:allowLive};
  if(!allowLive)return {...result,status:'PREFLIGHT_ONLY'};
  const counts=new Map();
  for(const model of [models.astra,models.fable]){
    const trace={},started=Date.now();let value=null,error=null;
    const boundedFetch=async(url,options)=>{
      strictRequest(url,options,model,crop);
      if(result.providerCalls>=2||(counts.get(model)||0)>=1)throw fail('SMOKE_CALL_LIMIT');
      counts.set(model,1);result.providerCalls++;
      const response=await fetchImpl(url,options);trace.httpStatus=Number.isInteger(response.status)?response.status:null;
      const text=response.text.bind(response);
      response.text=async()=>{const body=await text();try{if(Buffer.byteLength(body)<=500000){const p=JSON.parse(body);
        trace.returnedModel=safeModel(p.model);trace.usage=source.safeUsage(p.usage);
        trace.providerCode=Number.isInteger(p.error?.code)?p.error.code:safeCode(p.error?.code);}}catch{}return body;};
      return response;
    };
    try{value=await source.reader({model,bytes:crop.bytes,mimeType:'image/png',prompt:visual.PROMPT,targeted:true,images:crop.images,env,fetchImpl:boundedFetch,
      onDiagnostic:d=>{trace.failureStage=safeCode(d.failureStage);trace.httpStatus=d.httpStatus??trace.httpStatus;}});}
    catch(e){error=e;}
    const diag=error?.sourceReaderDiagnostic,usage=source.safeUsage(value?.usage||diag?.usage||trace.usage);
    result.readers.push({requestedModel:model,returnedModel:value?.returnedModel||diag?.returnedModel||trace.returnedModel||null,
      outcome:error?failureOutcome(error,trace):'SUCCESS',httpStatus:trace.httpStatus??null,providerCode:trace.providerCode??null,
      transportOutcome:trace.httpStatus?(trace.httpStatus>=200&&trace.httpStatus<300?'HTTP_SUCCESS':'HTTP_FAILED'):'TRANSPORT_FAILED',
      validationStage:error?(diag?.validationStatus==='FAILED'?'SOURCE_VALIDATION':trace.failureStage||'TRANSPORT'):'SOURCE_CONTRACT_VALIDATED',
      safeFailureCode:error?safeCode(diag?.failureCode||error.code)||'SOURCE_READER_REJECTED':null,
      durationMs:value?.durationMs??diag?.durationMs??Date.now()-started,usage,reportedCost:usage.cost??null,schemaValid:Boolean(value),
      activeTranscript:value?.value.activeTranscript??null,segments:value?.value.segments??null,uncertainSpans:value?.value.uncertainSpans??null});
  }
  const [a,b]=result.readers,complete=a.schemaValid&&b.schemaValid;
  const asValue=r=>({activeTranscript:r.activeTranscript,segments:r.segments,uncertainSpans:r.uncertainSpans});
  const av=complete?asValue(a):null,bv=complete?asValue(b):null;
  const agrees=complete&&targeted.compatible(av,bv),geometry=complete?targeted.accounted(region,av,targeted.geometryWords(page.google.nativePages[0])):null;
  result.pair={activeTextExactEqual:complete?a.activeTranscript===b.activeTranscript:null,
    segmentSignatureEqual:complete?JSON.stringify(a.segments.map(s=>[s.type,s.text]))===JSON.stringify(b.segments.map(s=>[s.type,s.text])):null,
    hasUncertainty:complete?[a,b].some(r=>r.uncertainSpans.length||r.segments.some(s=>s.type==='UNCERTAIN')):null,
    geometryAccountedFor:geometry,targetedPairState:agrees&&geometry?'TARGETED_MODEL_AGREED':'TARGETED_OCR_UNCERTAIN'};
  const mapping=region.mapping,reconciled=agrees&&geometry?targeted.reconcile(page.astra.activeTranscript,region,av):null;
  result.reconciliation={dryRun:true,patchApplied:false,mappingState:reconciled?.alignmentState||mapping.state,
    mappedStart:mapping.start??null,mappedEnd:mapping.end??null,boundaryStatus:complete&&mapping.leftAnchor&&mapping.rightAnchor
      ?(a.activeTranscript.startsWith(mapping.leftAnchor)&&a.activeTranscript.endsWith(mapping.rightAnchor)?'EXACT':'ANCHOR_MISMATCH'):'NOT_EVALUABLE',
    originalHashMatch:source.sha(page.astra.activeTranscript)===mapping.sourceTranscriptSha256,
    patchEligible:Boolean(agrees&&geometry&&reconciled?.alignmentState==='UNIQUE_STRUCTURAL_SPAN')};
  // Gold is loaded strictly AFTER both live results; never reaches source.reader or its requests.
  try{const gold=require('../tests/fixtures/source-fidelity/golden-002.cjs');
    if(gold.inputSha256!==PIN.inputSha256||gold.status!=='HUMAN_GOLD')throw fail('SMOKE_GOLD_IDENTITY');
    const maps=targeted.tokenMap(gold.text,targeted.geometryWords(page.google.nativePages[0])).filter(m=>region.sourceGeometryWordIds.includes(m.id));
    const expected=gold.text.slice(Math.min(...maps.map(m=>m.start)),Math.max(...maps.map(m=>m.end)));
    result.humanGoldComparison={authority:'TEST_ONLY_POST_RESULT',expectedText:expected,
      readers:result.readers.map(r=>({requestedModel:r.requestedModel,exactEqual:r.schemaValid?r.activeTranscript===expected:null}))};
    let historical;try{historical=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../tmp/targeted-v2-live-smoke/2026-10-20T21-35-05-260Z.json'),'utf8'));
      if(historical.inputSha256!==PIN.inputSha256||historical.regionId!==PIN.regionId)historical=null;}catch{}
    result.evaluationQuestions=require('./lib/targetedV3Evaluation.cjs').evaluate(result,expected,historical);
  }catch{result.humanGoldComparison={status:'UNAVAILABLE',safeFailureCode:'SMOKE_GOLD_COMPARISON_FAILED'};}
  return {...result,status:'DIAGNOSTIC_COMPLETE'};
}
async function main(){
  const options=args(process.argv.slice(2));require('../src/config/env');
  if(!['development','test'].includes(process.env.NODE_ENV))throw fail('SMOKE_LOCAL_ONLY');
  const mongoose=require('mongoose');let connection;
  try{connection=await mongoose.createConnection(process.env.MONGO_URI,{autoIndex:false,autoCreate:false,serverSelectionTimeoutMS:15000,connectTimeoutMS:15000,socketTimeoutMS:20000,maxPoolSize:1}).asPromise();
    const evidence=await retrieve(connection,options.submissionId),prepared=await prepare(evidence);
    source.config();
    const dir=path.resolve(__dirname,'../tmp/targeted-v3-live-smoke');fs.mkdirSync(dir,{recursive:true,mode:0o700});
    if(fs.realpathSync(dir)!==dir)throw fail('SMOKE_OUTPUT_REDIRECTED');
    const output=path.join(dir,new Date().toISOString().replace(/[:.]/g,'-')+'.json');
    fs.writeFileSync(output,JSON.stringify({status:'PREFLIGHT_VERIFIED',providerCalls:0,sourceMutation:false})+'\n',{flag:'wx',mode:0o600});
    preflightVerified=true;
    console.log('LIVE_SMOKE_REGION=slot_8\nV3_CONTEXT_CROP_VERIFIED=true\nV3_FOCUS_CROP_VERIFIED=true\nPLANNED_PROVIDER_CALLS=2\nASTRA_MODEL=openai/gpt-6-astra\nFABLE_MODEL=anthropic/claude-fable-5.1\nSOURCE_MUTATION=false');
    // Before live spending, ensure the current source still matches the read-only snapshot.
    const current=await retrieve(connection,options.submissionId);if(JSON.stringify(current)!==JSON.stringify(evidence))throw fail('SMOKE_EVIDENCE_CHANGED');
    const result=await runPair(prepared,{allowLive:options.allowLive});
    try{const after=await retrieve(connection,options.submissionId);result.sourceUnchanged=JSON.stringify(after)===JSON.stringify(evidence);}
    catch{result.sourceUnchanged=null;result.sourceCheckStatus='READ_FAILED';}
    fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n',{mode:0o600});
    console.log(JSON.stringify({status:result.status,output,providerCalls:result.providerCalls,sourceMutation:false,sourceUnchanged:result.sourceUnchanged,
      readers:result.readers.map(r=>({requestedModel:r.requestedModel,outcome:r.outcome,safeFailureCode:r.safeFailureCode}))}));
    if(!result.sourceUnchanged)process.exitCode=1;
  }finally{await connection?.close();}
}
if(require.main===module)main().catch(e=>{
  if(!preflightVerified)console.log('LIVE_SMOKE_REGION=slot_8\nV3_CONTEXT_CROP_VERIFIED=false\nV3_FOCUS_CROP_VERIFIED=false\nPLANNED_PROVIDER_CALLS=0\nSOURCE_MUTATION=false');
  console.error(/^SMOKE_[A-Z_]+$/.test(e.code||'')?e.code:'SMOKE_PREFLIGHT_FAILED');process.exitCode=1;
});
module.exports={PIN,args,prepare,runPair,failureOutcome,strictRequest,verifyBundle,MANIFEST};
