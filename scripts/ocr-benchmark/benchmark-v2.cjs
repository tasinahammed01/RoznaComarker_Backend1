'use strict';
// V2 transport compatibility only. V1 implementation, ledgers and raw evidence remain read-only.
const fs=require('fs'),path=require('path'),{performance}=require('perf_hooks');
const v1=require('./benchmark-core.cjs');
const {home,localDirectory}=require('../local-shadow/config.cjs');
const DIRECTORY=path.join(home,'private','astra-vs-fable-page01-v2');
const MODELS=Object.freeze({'gpt-astra':'openai/gpt-6-astra','claude-fable':'anthropic/claude-fable-5.1'});
const KEYS=Object.freeze(['model','messages','max_completion_tokens','response_format','provider']);
const EXPECTED_PROMPT_SHA='9e41486cde8d8a6177124a43ee587af8acee72547040701f0b0825b4eac987e6';
const schema=JSON.parse(JSON.stringify(v1.schema));
schema.properties.segments.items.properties.confidence={type:'number',description:'Visual reading confidence from 0 to 1. Confidence does not establish source truth.'};
const {sha,read,save,SLOTS,Budget}=v1;
const fail=code=>Object.assign(Error(code),{code});
function promptIdentity() {
  const archived=fs.readFileSync(path.join(v1.DIRECTORY,'shared-prompt.txt'));
  if(v1.PROMPT_SHA!==EXPECTED_PROMPT_SHA||sha(archived)!==EXPECTED_PROMPT_SHA||!archived.equals(Buffer.from(v1.STRICT_FORENSIC_HANDWRITING_PROMPT))) throw fail('V1_PROMPT_IDENTITY_MISMATCH');
  return EXPECTED_PROMPT_SHA;
}
function spec(slot,model,image) {
  if(!SLOTS.includes(slot)||MODELS[slot]!==model) throw fail('V2_EXACT_MODEL_REQUIRED');
  const previous=v1.requestSpec(slot,model,image);
  const body={model,messages:previous.messages,max_completion_tokens:12000,
    response_format:{type:'json_schema',json_schema:{name:'forensic_handwriting_comparison_v2',strict:true,schema}},provider:v1.ROUTING};
  return {slot,model,body,promptSha256:sha(body.messages[0].content),imageSha256:sha(image.bytes),messagesSha256:sha(JSON.stringify(body.messages)),
    schemaSha256:sha(JSON.stringify(schema)),semanticBodySha256:sha(JSON.stringify({...body,model:null})),wireKeys:Object.keys(body)};
}
function assertWire(body,request) {
  if(Object.keys(body).sort().join('|')!==[...KEYS].sort().join('|')||body.model!==request.model||body.max_completion_tokens!==12000||
    JSON.stringify(body.provider)!==JSON.stringify(v1.ROUTING)||sha(JSON.stringify({...body,model:null}))!==request.semanticBodySha256) throw fail('V2_WIRE_CONTRACT_MISMATCH');
}
function parity(specs) {
  if(specs.length!==2||specs.some(s=>s.promptSha256!==EXPECTED_PROMPT_SHA||s.imageSha256!==v1.EXPECTED_SHA)||
    ['promptSha256','imageSha256','messagesSha256','schemaSha256','semanticBodySha256'].some(k=>specs[0][k]!==specs[1][k])) throw fail('V2_PARITY_MISMATCH');
  specs.forEach(s=>assertWire(s.body,s));return true;
}
function walk(dir,files) {
  if(!fs.existsSync(dir)||path.resolve(dir)===DIRECTORY)return;
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
    const file=path.join(dir,entry.name);if(entry.isSymbolicLink())throw fail('PROTECTED_PATH_REDIRECTED');
    if(entry.isDirectory())walk(file,files);else files.add(file);
  }
}
function snapshot() {
  const files=new Set(),v1Baseline=read(v1.DIRECTORY,'protected-baseline.json');
  for(const [relative,hash]of Object.entries(v1Baseline)) {
    const file=path.resolve(v1.WORKSPACE,relative);
    if(sha(fs.readFileSync(file))!==hash) throw fail('V1_PROTECTED_FILE_CHANGED');
    files.add(file);
  }
  for(const dir of [path.join(v1.root,'src'),path.join(v1.WORKSPACE,'RoznaComarker/src'),path.join(home,'private')])walk(dir,files);
  for(const name of ['benchmark-core.cjs','astra-vs-fable-page01.cjs','comparison.cjs','strict-forensic-prompt.txt'])files.add(path.join(__dirname,name));
  files.add(path.join(v1.root,'tests/astraFableBenchmark.test.js'));
  files.add(path.join(v1.WORKSPACE,'OCR_ASTRA_VS_FABLE_PAGE01_REPORT.md'));
  return Object.fromEntries([...files].sort().map(file=>[path.relative(v1.WORKSPACE,file),sha(fs.readFileSync(file))]));
}
function assertSnapshot(before) {
  v1.source();const current=snapshot();
  if(JSON.stringify(current)!==JSON.stringify(before))throw fail('V2_PROTECTED_FILES_CHANGED');
  return Object.keys(current).length;
}
function inspectV1(image) {
  return SLOTS.map(slot=>{
    const metadata=read(path.join(v1.DIRECTORY,slot),'request-metadata.json');
    const request=v1.requestSpec(slot,MODELS[slot],image);
    if(metadata.messagesSha256!==request.messagesSha256||metadata.promptSha256!==EXPECTED_PROMPT_SHA||metadata.sourceSha256!==image.sha256)throw fail('V1_REQUEST_RECONSTRUCTION_MISMATCH');
    return {slot,requestedModel:metadata.requestedModel,evidence:'Reconstructed from unchanged V1 request builder and saved metadata; V1 did not save a full image-bearing outbound body.',
      wireKeys:['model','messages','temperature','max_tokens','response_format','provider','stream'],temperature:metadata.temperature,max_tokens:metadata.maxOutputTokens,
      provider:metadata.provider,stream:false,confidenceSchema:metadata.schema.properties.segments.items.properties.confidence,
      messagesSha256:metadata.messagesSha256,promptSha256:metadata.promptSha256,imageSha256:metadata.sourceSha256,
      failure:JSON.parse(fs.readFileSync(path.join(v1.DIRECTORY,slot,'raw-transport-response.txt'),'utf8')).error};
  });
}
function sanitized(request) {
  return {...request.body,messages:[{role:'system',content:{omitted:'Exact unchanged prompt saved in shared-prompt.txt',sha256:request.promptSha256}},
    {role:'user',content:[{type:'text',text:v1.USER_INSTRUCTION},{type:'image_url',image_url:{omitted:'Original image bytes only',sha256:request.imageSha256}}]}]};
}
function preflight() {
  const image=v1.source(),config=v1.loadConfiguration();promptIdentity();
  for(const slot of SLOTS)if(config.models[slot]!==MODELS[slot])throw fail('V2_EXACT_MODEL_REQUIRED');
  localDirectory(DIRECTORY);for(const slot of [...SLOTS,'comparison'])localDirectory(path.join(DIRECTORY,slot));
  const budget=new Budget(DIRECTORY);if(!budget.unused())throw fail('V2_BUDGET_CONSUMED');
  const specs=SLOTS.map(slot=>spec(slot,config.models[slot],image));parity(specs);
  const before=snapshot();
  for(const [name,value]of [['protected-baseline.json',before],['shared-prompt.txt',v1.STRICT_FORENSIC_HANDWRITING_PROMPT],['shared-prompt.sha256',EXPECTED_PROMPT_SHA+'\n'],['v1-request-audit.json',inspectV1(image)]]) {
    const expected=typeof value==='string'?value:JSON.stringify(value,null,2)+'\n';
    if(fs.existsSync(path.join(DIRECTORY,name))) {if(fs.readFileSync(path.join(DIRECTORY,name),'utf8')!==expected)throw fail('V2_PREFLIGHT_EVIDENCE_CHANGED');}
    else save(DIRECTORY,name,value);
  }
  const summary={STATUS:'V2_PREFLIGHT_PASS',GPT_MODEL:MODELS['gpt-astra'],CLAUDE_MODEL:MODELS['claude-fable'],SOURCE_SHA:image.sha256,
    PROMPT_SHA_GPT:specs[0].promptSha256,PROMPT_SHA_CLAUDE:specs[1].promptSha256,IMAGE_SHA_GPT:specs[0].imageSha256,IMAGE_SHA_CLAUDE:specs[1].imageSha256,
    PROMPT_HASHES_IDENTICAL:true,IMAGE_HASHES_IDENTICAL:true,V2_LEDGER_UNUSED:true,OPENROUTER_KEY_PRESENT:true,GENERATION_REQUESTS:0,
    SANITIZED_PARAMETER_KEYS:KEYS,MAX_COMPLETION_TOKENS:12000,TEMPERATURE_OMITTED:true,MAX_TOKENS_OMITTED:true,PROVIDER:v1.ROUTING,
    schemaSha256:specs[0].schemaSha256,protectedFiles:Object.keys(before).length};
  fs.writeFileSync(path.join(DIRECTORY,'preflight.json'),JSON.stringify(summary,null,2)+'\n',{mode:0o600});
  return {image,config,specs,budget,summary};
}
async function runModel({directory=DIRECTORY,request,image,key,attempt,fetchImpl,scope=fn=>fn(),timeoutMs=v1.LIMITS.timeoutMs,checkSource=()=>{}}) {
  const dir=path.join(directory,request.slot),budget=new Budget(directory),controller=new AbortController();
  checkSource();assertWire(request.body,request);
  if(sha(image.bytes)!==request.imageSha256)throw fail('V2_SOURCE_CHANGED');
  const identity={requestedModel:request.model,sourceSha256:request.imageSha256,promptSha256:request.promptSha256};
  budget.reserve(request.slot,'attempt',identity);
  save(dir,'request-metadata.json',{...identity,messagesSha256:request.messagesSha256,schemaSha256:request.schemaSha256,semanticBodySha256:request.semanticBodySha256,
    wireParameterKeys:KEYS,schema,max_completion_tokens:12000,provider:v1.ROUTING,timeoutMs,retries:0,fallbacks:0,temperatureOmitted:true,preprocessing:'NONE'});
  save(dir,'outbound-request-sanitized.json',sanitized(request));
  const state={...identity,status:'FAILED',returnedModel:null,providerCalls:0,httpStatus:null,finishReason:null,usage:null,errorCode:null,
    failureStage:null,providerError:null,routingCompatibilityFailure:false,latencyMs:null,retries:0,fallbacks:0,normalization:'NONE',startedAt:new Date().toISOString()};
  const start=performance.now();let finalized=false,dispatched=false,timer;
  const store=(name,value)=>{if(finalized||controller.signal.aborted)throw fail('V2_TIMEOUT');save(dir,name,value);};
  const rawSafe=text=>{if(text.includes(key)||/-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(text)||/"Authorization"\s*:\s*"Bearer /i.test(text))throw fail('V2_SECRET_ECHO_WITHHELD');return text;};
  try {
    const work=scope(()=>attempt({entry:{provider:'openrouter',model:request.model,fallbackIndex:0},messages:request.body.messages,
      maxOutputTokens:12000,responseFormat:'json',responseSchema:schema,schemaName:'forensic_handwriting_comparison_v2',feature:'private_forensic_comparison_v2',
      attemptTimeoutMs:timeoutMs,now:Date.now,env:{OPENROUTER_API_KEY:key,FRONTEND_URL:'http://localhost:4200'},
      onDiagnostic:d=>{if(!finalized&&/^[A-Z_]{1,80}$/.test(d.failureStage||''))state.failureStage=d.failureStage;},
      fetchImpl:async(url,options)=>{
        if(url!==v1.ENDPOINT||options.method!=='POST'||dispatched)throw fail('V2_TRANSPORT_FORBIDDEN');
        const gatewayBody=JSON.parse(options.body);
        // Existing gateway uses max_tokens internally. Convert only this private HTTP envelope.
        if(gatewayBody.model!==request.model||gatewayBody.max_tokens!==12000||'temperature'in gatewayBody||
          sha(JSON.stringify(gatewayBody.messages))!==request.messagesSha256||sha(JSON.stringify(gatewayBody.response_format))!==sha(JSON.stringify(request.body.response_format)))throw fail('V2_GATEWAY_INPUT_MISMATCH');
        const wire={model:gatewayBody.model,messages:gatewayBody.messages,max_completion_tokens:gatewayBody.max_tokens,
          response_format:gatewayBody.response_format,provider:v1.ROUTING};
        assertWire(wire,request);
        budget.reserve(request.slot,'transport',identity);dispatched=true;state.providerCalls=1;state.failureStage='TRANSPORT';
        const signal=options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal;
        const response=await fetchImpl(url,{...options,body:JSON.stringify(wire),signal,redirect:'error'});
        if(finalized)throw fail('V2_TIMEOUT');state.httpStatus=response.status;state.failureStage='RESPONSE_BODY';
        return {ok:response.ok,status:response.status,headers:response.headers,text:async()=>{
          const raw=rawSafe(await response.text());store('raw-transport-response.txt',raw);state.failureStage='TRANSPORT_JSON';
          const payload=JSON.parse(raw);
          state.returnedModel=typeof payload.model==='string'&&/^[A-Za-z0-9_.:/-]{1,160}$/.test(payload.model)?payload.model:null;
          state.usage=v1.safeUsage(payload.usage);state.finishReason=typeof payload.choices?.[0]?.finish_reason==='string'?payload.choices[0].finish_reason:null;
          if(payload.error)state.providerError={code:payload.error.code??null,message:typeof payload.error.message==='string'?payload.error.message:null,
            failedRoutingStep:payload.error.metadata?.failed_routing_step??null};
          state.routingCompatibilityFailure=state.providerError?.failedRoutingStep==='Filter by Parameters';
          if(typeof payload.choices?.[0]?.message?.content==='string')store('raw-response.txt',rawSafe(payload.choices[0].message.content));
          state.failureStage='PROVIDER_RESPONSE';return raw;
        }};
      }}));
    const result=await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(fail('V2_TIMEOUT'));},timeoutMs);})]);
    state.failureStage='SCHEMA_VALIDATION';const value=v1.validate(result.content);
    store('parsed-response.json',value);store('activeTranscript.txt',value.activeTranscript);store('segments.json',value.segments);store('uncertain-spans.json',value.uncertainSpans);
    if(state.returnedModel!==request.model)throw fail('V2_RETURNED_MODEL_MISMATCH');
    if(result.finishReason!=='stop')throw fail('V2_FINISH_NOT_STOP');
    state.status='COMPLETE';state.failureStage=null;
  } catch(e) {
    state.errorCode=controller.signal.aborted?'V2_TIMEOUT':/^[A-Z0-9_]{1,100}$/.test(e.code||'')?e.code:/^[A-Z0-9_]{1,100}$/.test(e.message||'')?e.message:'V2_PROVIDER_OR_SCHEMA_FAILED';
  } finally {
    clearTimeout(timer);finalized=true;controller.abort();state.latencyMs=Math.round(performance.now()-start);state.finishedAt=new Date().toISOString();
    save(dir,'usage.json',state.usage);save(dir,'result.json',state);
  }
  return state;
}
async function runSlots(specs,run) {
  const states=[];for(const request of specs) {const state=await run(request);states.push(state);if(state.routingCompatibilityFailure)break;}return states;
}
module.exports={...v1,DIRECTORY,MODELS,KEYS,EXPECTED_PROMPT_SHA,schema,spec,assertWire,parity,promptIdentity,snapshot,assertSnapshot,preflight,sanitized,runModel,runSlots};
