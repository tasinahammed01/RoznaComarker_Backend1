'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { root, home, localDirectory } = require('../local-shadow/config.cjs');
// Reuse the existing schema, strict validator and durable file writer; never call its provider runner.
const { schema, validate, writeExclusive } = require('../local-shadow/sol-verbatim.cjs');
const WORKSPACE = path.resolve(root, '..');
const DIRECTORY = path.join(home, 'private', 'astra-vs-fable-page01');
const SOURCE = path.join(WORKSPACE, 'staging-test-data', 'handwritten-page-01.jpeg');
const EXPECTED_SHA = 'dea93eca607e5b6a20c2d9362fe5c58a41c7e97a7d514459d8c031ee89375772';
const STRICT_FORENSIC_HANDWRITING_PROMPT = fs.readFileSync(path.join(__dirname, 'strict-forensic-prompt.txt'), 'utf8');
const USER_INSTRUCTION = 'Transcribe the original handwritten page under the shared forensic instruction and strict segment contract.';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const PROMPT_SHA = sha(STRICT_FORENSIC_HANDWRITING_PROMPT);
const MODEL_KEYS = Object.freeze({ 'gpt-astra': 'OCR_BENCHMARK_GPT_ASTRA_MODEL', 'claude-fable': 'OCR_BENCHMARK_CLAUDE_FABLE_MODEL' });
const SLOTS = Object.freeze(Object.keys(MODEL_KEYS));
const LIMITS = Object.freeze({ maxOutputTokens: 12000, temperature: 0, timeoutMs: 180000 });
const ROUTING = Object.freeze({ allow_fallbacks: false, require_parameters: true });
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const read = (directory, name) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
const save = (directory, name, value) => writeExclusive(path.join(directory, name), value);
const failure = code => Object.assign(Error(code), { code });
function source() {
  for (const p of [path.dirname(SOURCE), SOURCE]) {
    if (fs.lstatSync(p).isSymbolicLink() || fs.realpathSync(p) !== p) throw failure('SOURCE_PATH_REDIRECTED');
  }
  const stat = fs.lstatSync(SOURCE);
  if (!stat.isFile() || stat.size <= 0 || stat.size > 20*1024*1024) throw failure('SOURCE_NOT_REGULAR_NONEMPTY');
  const bytes = fs.readFileSync(SOURCE), jpeg = bytes[0]===255 && bytes[1]===216 && bytes[2]===255;
  const png = bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'));
  if (!jpeg && !png) throw failure('SOURCE_SIGNATURE_INVALID');
  if (sha(bytes) !== EXPECTED_SHA) throw failure('SOURCE_SHA_MISMATCH');
  const dimensions = require('image-size')(bytes);
  return { file: SOURCE, bytes, sha256: EXPECTED_SHA, mimeType: jpeg?'image/jpeg':'image/png', width:dimensions.width, height:dimensions.height };
}
function configuration(env) {
  const missing = Object.values(MODEL_KEYS).filter(k => !env[k]);
  if (!env.OPENROUTER_API_KEY) missing.push('OPENROUTER_API_KEY');
  if (missing.length) throw Object.assign(failure('MISSING_BENCHMARK_CONFIGURATION'), { missing });
  const models = Object.fromEntries(SLOTS.map(slot => [slot, env[MODEL_KEYS[slot]]]));
  for (const model of Object.values(models)) {
    if (typeof model !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:-]+$/.test(model) ||
        /latest|:free|gpt-5\.6-sol|gpt-4\.1-mini|^openrouter\//i.test(model)) throw failure('EXACT_MODEL_ID_REQUIRED');
  }
  if (models[SLOTS[0]] === models[SLOTS[1]]) throw failure('DISTINCT_MODELS_REQUIRED');
  return { models, key: env.OPENROUTER_API_KEY };
}
function loadConfiguration() {
  const parsed = require('dotenv').parse(fs.readFileSync(path.join(root,'.env')));
  // Only supported values, never application environment, are projected into the private runner.
  return configuration(Object.fromEntries([...Object.values(MODEL_KEYS),'OPENROUTER_API_KEY'].map(k=>[k,process.env[k] || parsed[k]])));
}
class Budget {
  constructor(directory) { this.directory = directory; }
  reserve(slot, kind, identity) {
    if (!SLOTS.includes(slot) || !['attempt','transport','network'].includes(kind)) throw failure('BUDGET_KIND_FORBIDDEN');
    const dir = path.join(this.directory, slot);
    try { save(dir,kind+'.json',{slot,kind,attempt:1,timestamp:new Date().toISOString(),...identity}); }
    catch(e) { if(e.code==='EEXIST') throw failure('BENCHMARK_ATTEMPT_CONSUMED'); throw e; }
  }
  unused() { return !fs.existsSync(path.join(this.directory,'run-once.lock')) && SLOTS.every(slot=>['attempt','transport','network'].every(k=>!fs.existsSync(path.join(this.directory,slot,k+'.json')))); }
}
function snapshot() {
  const files = new Set();
  const walk = dir => {
    if (!fs.existsSync(dir) || path.resolve(dir) === DIRECTORY) return;
    for (const entry of fs.readdirSync(dir,{withFileTypes:true})) {
      const f = path.join(dir,entry.name);
      if (entry.isSymbolicLink()) throw failure('PROTECTED_LINK_UNSUPPORTED');
      if(entry.isDirectory()) walk(f); else files.add(f);
    }
  };
  for (const d of [path.join(root,'src'),path.join(WORKSPACE,'RoznaComarker/src'),path.join(home,'private'),path.join(root,'scripts/local-shadow')]) walk(d);
  for(const f of ['backend/.env','backend/.env.example','backend/package.json','backend/package-lock.json','RoznaComarker/angular.json',
    'RoznaComarker/package.json','RoznaComarker/pnpm-lock.yaml','SOL_VERBATIM_HANDWRITING_PAGE01_REPORT.md','OCR_SOURCE_FIDELITY_CROP_VERIFICATION_PAGE01_REPORT.md'])
    if(fs.existsSync(path.join(WORKSPACE,f))) files.add(path.join(WORKSPACE,f));
  const frozen = JSON.parse(fs.readFileSync(path.join(WORKSPACE,'output/phase6-protected-hashes.json'),'utf8'));
  for(const [relative,hash] of Object.entries(frozen)) {
    const f=path.resolve(WORKSPACE,relative);
    // User explicitly added the two benchmark model variables. Freeze the current .env now;
    // never modify the historical baseline to disguise this authorized change.
    if(f!==path.join(root,'.env') && sha(fs.readFileSync(f))!==hash) throw failure('PRIOR_PROTECTED_FILE_CHANGED');
    files.add(f);
  }
  return Object.fromEntries([...files].sort().map(f=>[path.relative(WORKSPACE,f),sha(fs.readFileSync(f))]));
}
function assertSnapshot(before) {
  source(); const now=snapshot();
  if(JSON.stringify(before)!==JSON.stringify(now)) throw failure('BENCHMARK_PROTECTED_FILES_CHANGED');
  return Object.keys(now).length;
}
function requestSpec(slot, model, image) {
  if(!SLOTS.includes(slot)) throw failure('UNKNOWN_MODEL_SLOT');
  const messages=[{role:'system',content:STRICT_FORENSIC_HANDWRITING_PROMPT},{role:'user',content:[
    {type:'text',text:USER_INSTRUCTION},{type:'image_url',image_url:{url:`data:${image.mimeType};base64,${image.bytes.toString('base64')}`}}
  ]}];
  return {slot,model,messages,promptSha256:sha(messages[0].content),imageSha256:sha(image.bytes),messagesSha256:sha(JSON.stringify(messages)),schemaSha256:sha(JSON.stringify(schema)),
    maxOutputTokens:LIMITS.maxOutputTokens,temperature:LIMITS.temperature};
}
function parity(specs) {
  if(specs.length!==2 || ['promptSha256','imageSha256','messagesSha256','schemaSha256','maxOutputTokens','temperature'].some(k=>specs[0][k]!==specs[1][k]) ||
      specs.some(s=>s.promptSha256!==PROMPT_SHA || s.imageSha256!==EXPECTED_SHA)) throw failure('EXPERIMENT_PARITY_MISMATCH');
  return true;
}
function preflight() {
  const image=source(),config=loadConfiguration();
  localDirectory(DIRECTORY);
  for(const slot of [...SLOTS,'comparison']) localDirectory(path.join(DIRECTORY,slot));
  const budget=new Budget(DIRECTORY);
  if(!budget.unused()) throw failure('BENCHMARK_ATTEMPT_CONSUMED');
  const specs=SLOTS.map(slot=>requestSpec(slot,config.models[slot],image)); parity(specs);
  const current=snapshot();
  if(fs.existsSync(path.join(DIRECTORY,'protected-baseline.json'))) assertSnapshot(read(DIRECTORY,'protected-baseline.json'));
  else save(DIRECTORY,'protected-baseline.json',current);
  for(const [name,value] of [['shared-prompt.txt',STRICT_FORENSIC_HANDWRITING_PROMPT],['shared-prompt.sha256',PROMPT_SHA+'\n']]) {
    if(fs.existsSync(path.join(DIRECTORY,name))) {if(fs.readFileSync(path.join(DIRECTORY,name),'utf8')!==value) throw failure('SHARED_PROMPT_CHANGED');}
    else save(DIRECTORY,name,value);
  }
  return {image,config,specs,budget,summary:{status:'PREFLIGHT_PASS',sourcePath:image.file,sourceSha256:image.sha256,width:image.width,height:image.height,
    requestedModels:config.models,promptSha256:PROMPT_SHA,promptBytesIdentical:true,sourceImageBytesIdentical:true,keyPresent:true,
    gptCallsRemaining:1,claudeCallsRemaining:1,otherProviderCalls:0,generationCalls:0,protectedFiles:Object.keys(current).length}};
}
function safeUsage(usage) {
  if(!usage || typeof usage!=='object') return null;
  const number=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0?x:null;
  return {prompt_tokens:number(usage.prompt_tokens),completion_tokens:number(usage.completion_tokens),total_tokens:number(usage.total_tokens),
    reasoning_tokens:number(usage.completion_tokens_details?.reasoning_tokens??usage.thoughts_tokens),
    cost:number(usage.cost),cached_tokens:number(usage.prompt_tokens_details?.cached_tokens)};
}
function protectRaw(value,key) {
  if(value.includes(key) || /-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(value) || /"Authorization"\s*:\s*"Bearer /i.test(value)) throw failure('RAW_WITHHELD_SECRET_ECHO');
  return value;
}
async function deadline(work, ms, controller) {
  let timer;
  try {
    return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(failure('BENCHMARK_TIMEOUT'));},ms);})]);
  } finally { clearTimeout(timer); }
}
async function runModel({directory=DIRECTORY,spec,image,key,attempt,fetchImpl,scope=fn=>fn(),timeoutMs=LIMITS.timeoutMs,checkSource=()=>{}}) {
  const budget=new Budget(directory),dir=path.join(directory,spec.slot);
  const identity={requestedModel:spec.model,sourceSha256:spec.imageSha256,promptSha256:spec.promptSha256};
  checkSource();
  if(sha(image.bytes)!==spec.imageSha256 || spec.promptSha256!==sha(spec.messages[0].content)) throw failure('REQUEST_IDENTITY_CHANGED');
  budget.reserve(spec.slot,'attempt',identity);
  save(dir,'request-metadata.json',{...identity,messagesSha256:spec.messagesSha256,schemaSha256:spec.schemaSha256,endpoint:ENDPOINT,
    sharedPromptPath:'../shared-prompt.txt',userInstruction:USER_INSTRUCTION,schema,maxOutputTokens:spec.maxOutputTokens,temperature:spec.temperature,
    timeoutMs,provider:ROUTING,fullPage:true,preprocessing:'NONE',retries:0,fallbacks:0});
  const started=performance.now(),controller=new AbortController();
  const state={...identity,returnedModel:null,status:'FAILED',providerCalls:0,httpStatus:null,finishReason:null,usage:null,
    latencyMs:null,startedAt:new Date().toISOString(),failureStage:null,errorCode:null,retries:0,fallbacks:0,normalization:'NONE'};
  let finalized=false,transportInvoked=false;
  const store=(name,value)=>{if(finalized || controller.signal.aborted) throw failure('BENCHMARK_TIMEOUT');save(dir,name,value);};
  try {
    const request=scope(()=>attempt({entry:{provider:'openrouter',model:spec.model,fallbackIndex:0},messages:spec.messages,
      maxOutputTokens:spec.maxOutputTokens,temperature:spec.temperature,responseFormat:'json',responseSchema:schema,schemaName:'forensic_handwriting_comparison_v1',
      feature:'private_forensic_comparison',attemptTimeoutMs:timeoutMs,now:Date.now,
      env:{OPENROUTER_API_KEY:key,FRONTEND_URL:'http://localhost:4200'},
      onDiagnostic: d=>{if(!finalized) state.failureStage=/^[A-Z_]{1,80}$/.test(d.failureStage||'')?d.failureStage:null;},
      fetchImpl:async(url,options)=>{
        if(url!==ENDPOINT || options.method!=='POST' || transportInvoked) throw failure('BENCHMARK_TRANSPORT_FORBIDDEN');
        const body=JSON.parse(options.body);
        if(body.model!==spec.model || sha(JSON.stringify(body.messages))!==spec.messagesSha256 ||
           body.max_tokens!==spec.maxOutputTokens || body.temperature!==spec.temperature ||
           sha(JSON.stringify(body.response_format?.json_schema?.schema))!==spec.schemaSha256) throw failure('WIRE_PARITY_MISMATCH');
        // Isolated request-body extension only. Production aiGateway remains unchanged.
        body.provider=ROUTING;
        body.stream=false;
        budget.reserve(spec.slot,'transport',identity); transportInvoked=true; state.providerCalls=1;
        const signal=options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal;
        state.failureStage='TRANSPORT';
        const response=await fetchImpl(url,{...options,body:JSON.stringify(body),signal,redirect:'error'});
        if(finalized) throw failure('BENCHMARK_TIMEOUT');
        state.httpStatus=response.status;state.failureStage='RESPONSE_BODY';
        return {ok:response.ok,status:response.status,headers:response.headers,text:async()=>{
          const raw=protectRaw(await response.text(),key);
          store('raw-transport-response.txt',raw);
          state.failureStage='TRANSPORT_JSON_PARSE';
          const payload=JSON.parse(raw);
          state.returnedModel=typeof payload.model==='string'&&/^[A-Za-z0-9_.:/-]{1,160}$/.test(payload.model)?payload.model:null;
          state.usage=safeUsage(payload.usage);
          state.finishReason=typeof payload.choices?.[0]?.finish_reason==='string'?payload.choices[0].finish_reason:null;
          const content=payload.choices?.[0]?.message?.content;
          if(typeof content==='string') store('raw-response.txt',protectRaw(content,key));
          state.failureStage='PROVIDER_RESPONSE_VALIDATION';
          return raw;
        }};
      }}));
    const result=await deadline(request,timeoutMs,controller);
    state.failureStage='STRUCTURED_SCHEMA_VALIDATION';
    const parsed=validate(result.content);
    // Save exact structured evidence even if returned model identity is wrong; never call it successful.
    store('parsed-response.json',parsed);
    store('activeTranscript.txt',parsed.activeTranscript);
    store('segments.json',parsed.segments);
    store('uncertain-spans.json',parsed.uncertainSpans);
    if(state.returnedModel!==spec.model) throw failure('RETURNED_MODEL_MISMATCH');
    if(result.finishReason!=='stop') throw failure('PROVIDER_FINISH_NOT_STOP');
    state.status='COMPLETE';state.failureStage=null;
  } catch(error) {
    state.errorCode=controller.signal.aborted?'BENCHMARK_TIMEOUT':/^[A-Z0-9_]{1,100}$/.test(error.code||'')?error.code:/^[A-Z0-9_]{1,100}$/.test(error.message||'')?error.message:'BENCHMARK_PROVIDER_OR_SCHEMA_FAILURE';
  } finally {
    finalized=true;controller.abort();
    state.latencyMs=Math.round(performance.now()-started);state.finishedAt=new Date().toISOString();
    save(dir,'usage.json',state.usage);save(dir,'result.json',state);
  }
  return state;
}
module.exports={root,WORKSPACE,DIRECTORY,SOURCE,EXPECTED_SHA,STRICT_FORENSIC_HANDWRITING_PROMPT,PROMPT_SHA,USER_INSTRUCTION,MODEL_KEYS,SLOTS,LIMITS,ROUTING,ENDPOINT,
  sha,read,save,source,configuration,loadConfiguration,Budget,snapshot,assertSnapshot,requestSpec,parity,preflight,schema,validate,runModel,safeUsage};
