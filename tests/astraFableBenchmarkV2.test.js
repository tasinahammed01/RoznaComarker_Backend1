'use strict';
const fs=require('fs'),os=require('os'),path=require('path');
const v2=require('../scripts/ocr-benchmark/benchmark-v2.cjs');
const v1=require('../scripts/ocr-benchmark/benchmark-core.cjs');
const gateway=require('../src/services/aiGateway.service');
const {compare}=require('../scripts/ocr-benchmark/comparison.cjs');
const dirs=[];
const image={file:'/synthetic/original.jpeg',bytes:Buffer.from('identical original image bytes'),mimeType:'image/jpeg'};
const key='v2-unit-key-not-a-real-credential';
function directory(){const d=fs.mkdtempSync(path.join(os.tmpdir(),'astra-fable-v2-'));dirs.push(d);for(const s of v2.SLOTS)fs.mkdirSync(path.join(d,s));return d;}
const output=text=>({activeTranscript:text,segments:text.split('\n').map(t=>({type:'ACTIVE_STUDENT_TEXT',text:t,confidence:.99,notes:'Visible strokes.'})),uncertainSpans:[]});
function response(model,value,extra={}){return{ok:extra.ok??true,status:extra.status??200,headers:{get:()=>null},text:async()=>JSON.stringify({model,
  choices:[{finish_reason:extra.finishReason??'stop',message:{content:typeof value==='string'?value:JSON.stringify(value)}}],usage:{prompt_tokens:100,completion_tokens:80,total_tokens:180,cost:.004,completion_tokens_details:{reasoning_tokens:20}}})};}
function run(d,slot,fetchImpl,extra={}){const request=v2.spec(slot,v2.MODELS[slot],image);return v2.runModel({directory:d,request,image,key,attempt:gateway.providerAttempt,fetchImpl,...extra});}
afterAll(()=>{for(const d of dirs)fs.rmSync(d,{recursive:true,force:true});});
test('V2 wire has exactly the five required keys, equivalent schema and no sampling parameters',()=>{
  const requests=v2.SLOTS.map(slot=>v2.spec(slot,v2.MODELS[slot],image));
  for(const r of requests){expect(Object.keys(r.body)).toEqual(v2.KEYS);expect(r.body.max_completion_tokens).toBe(12000);
    expect(r.body.provider).toEqual({require_parameters:true,allow_fallbacks:false});
    for(const k of ['temperature','max_tokens','top_p','top_k','seed','frequency_penalty','presence_penalty','stream','models'])expect(r.body).not.toHaveProperty(k);}
  expect({...requests[0].body,model:null}).toEqual({...requests[1].body,model:null});
  expect(()=>v2.assertWire({...requests[0].body,temperature:0},requests[0])).toThrow('WIRE');
  expect(()=>v2.assertWire({...requests[0].body,max_tokens:12000},requests[0])).toThrow('WIRE');
});
test('V2 schema has no minimum/maximum while runtime keeps confidence bounds and all exact segment semantics',()=>{
  const text=JSON.stringify(v2.schema);expect(text).not.toContain('"minimum"');expect(text).not.toContain('"maximum"');
  expect(v2.schema.properties.segments.items.properties.confidence).toEqual({type:'number',description:expect.stringContaining('0 to 1')});
  const withoutConfidence=s=>{const copy=JSON.parse(JSON.stringify(s));delete copy.properties.segments.items.properties.confidence;return copy;};
  expect(withoutConfidence(v2.schema)).toEqual(withoutConfidence(v1.schema));
  const value=output('sence');value.segments[0].confidence=1.1;expect(()=>v2.validate(JSON.stringify(value))).toThrow();
});
test('V1 prompt bytes are reused exactly for both models without expected source answers',()=>{
  expect(v2.EXPECTED_PROMPT_SHA).toBe(v1.PROMPT_SHA);
  for(const slot of v2.SLOTS){const r=v2.spec(slot,v2.MODELS[slot],image);expect(r.body.messages[0].content).toBe(v1.STRICT_FORENSIC_HANDWRITING_PROMPT);
    expect(r.promptSha256).toBe(v2.EXPECTED_PROMPT_SHA);expect(r.messagesSha256).toBe(v1.requestSpec(slot,v2.MODELS[slot],image).messagesSha256);}
  expect(v2.promptIdentity()).toBe(v2.EXPECTED_PROMPT_SHA);
  for(const word of ['sence','relize','relizing','cultural','Vivid','Louise'])expect(v2.STRICT_FORENSIC_HANDWRITING_PROMPT.match(new RegExp('\\b'+word+'\\b','u'))).toBeNull();
});
test('exact model IDs are enforced without aliases or substitutions',()=>{
  expect(()=>v2.spec('gpt-astra','openai/gpt-5.6-sol',image)).toThrow('EXACT_MODEL');
  expect(()=>v2.spec('claude-fable','anthropic/claude-latest',image)).toThrow('EXACT_MODEL');
});
test('pair parity rejects mismatched prompt, schema, messages or source hash',()=>{
  const requests=v2.SLOTS.map(slot=>({...v2.spec(slot,v2.MODELS[slot],image),imageSha256:v2.EXPECTED_SHA}));
  expect(v2.parity(requests)).toBe(true);
  for(const field of ['promptSha256','imageSha256','schemaSha256','messagesSha256','semanticBodySha256'])
    expect(()=>v2.parity([requests[0],{...requests[1],[field]:'different'}])).toThrow('PARITY');
});
test.each(['sence','sense','people','People','cultural','Cultural','Vivid','vivid','relize','relizing','got rid off','got rid of',' a  gap, “quotes”?! ','word word'])('response preserves exact characters: %s',text=>{
  expect(v2.validate(JSON.stringify(output(text))).activeTranscript).toBe(text);
});
test('case, spelling, punctuation, repetition and whitespace remain distinct in the reused diff',()=>{
  for(const [a,b]of [['sence','sense'],['people','People'],['cultural','Cultural'],['Vivid','vivid'],['off','of'],['word?','word!'],['word word','word'],['a  gap','a gap']]){
    const d=compare(a,b);expect(d.counts.total).toBeGreaterThan(0);expect(d.operations.map(o=>o.left?.text??'').join('')).toBe(a);expect(d.operations.map(o=>o.right?.text??'').join('')).toBe(b);}
});
test('real shared gateway is adapted at the HTTP boundary for both models, exactly once each',async()=>{
  const d=directory(),bodies=[];
  const fetchImpl=jest.fn(async(url,opts)=>{
    expect(url).toBe(v2.ENDPOINT);expect(opts.redirect).toBe('error');const body=JSON.parse(opts.body);bodies.push(body);
    expect(Object.keys(body)).toEqual(v2.KEYS);expect(body.max_completion_tokens).toBe(12000);expect(body).not.toHaveProperty('temperature');expect(body).not.toHaveProperty('max_tokens');
    const slot=v2.SLOTS.find(s=>v2.MODELS[s]===body.model);for(const kind of ['attempt','transport'])expect(fs.existsSync(path.join(d,slot,kind+'.json'))).toBe(true);
    expect(body.messages[1].content[1].image_url.url).toBe('data:image/jpeg;base64,'+image.bytes.toString('base64'));
    return response(body.model,output('sence\nVivid\ngot rid off'));
  });
  for(const slot of v2.SLOTS){const state=await run(d,slot,fetchImpl);expect(state.status).toBe('COMPLETE');expect(state.providerCalls).toBe(1);
    expect(fs.readFileSync(path.join(d,slot,'activeTranscript.txt'),'utf8')).toBe('sence\nVivid\ngot rid off');
    await expect(run(d,slot,fetchImpl)).rejects.toThrow('CONSUMED');}
  expect(fetchImpl).toHaveBeenCalledTimes(2);expect({...bodies[0],model:null}).toEqual({...bodies[1],model:null});
  for(const slot of v2.SLOTS)for(const f of fs.readdirSync(path.join(d,slot)))expect(fs.readFileSync(path.join(d,slot,f),'utf8')).not.toContain(key);
});
test.each(['http','malformed','schema','returned-model','truncated'])('%s failure consumes its V2 slot with no retry or fallback',async(kind)=>{
  const d=directory(),slot='gpt-astra',fetchImpl=jest.fn(async()=>{
    if(kind==='http')return{ok:false,status:503,headers:{get:()=>null},text:async()=>JSON.stringify({error:{code:503,message:'Unavailable'}})};
    if(kind==='malformed')return response(v2.MODELS[slot],'{"activeTranscript":');
    if(kind==='schema')return response(v2.MODELS[slot],{...output('sence'),correctedText:'sense'});
    if(kind==='returned-model')return response('other/unrequested',output('sence'));
    return response(v2.MODELS[slot],output('sence'),{finishReason:'length'});
  });
  expect((await run(d,slot,fetchImpl)).status).toBe('FAILED');expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(fs.existsSync(path.join(d,slot,'raw-transport-response.txt'))).toBe(true);
  await expect(run(d,slot,fetchImpl)).rejects.toThrow('CONSUMED');expect(fetchImpl).toHaveBeenCalledTimes(1);
});
test('Filter by Parameters stops the remaining model and never changes the envelope',async()=>{
  const d=directory(),fetchImpl=jest.fn(async()=>({ok:false,status:404,headers:{get:()=>null},text:async()=>JSON.stringify({error:{code:404,message:'No endpoints found that can handle the requested parameters',metadata:{failed_routing_step:'Filter by Parameters'}}})}));
  const requests=v2.SLOTS.map(slot=>v2.spec(slot,v2.MODELS[slot],image));
  const results=await v2.runSlots(requests,r=>run(d,r.slot,fetchImpl));
  expect(results).toHaveLength(1);expect(results[0].routingCompatibilityFailure).toBe(true);expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(fs.existsSync(path.join(d,'claude-fable','attempt.json'))).toBe(false);
  expect(v2.read(path.join(d,'gpt-astra'),'outbound-request-sanitized.json').provider).toEqual({require_parameters:true,allow_fallbacks:false});
});
test('failed non-routing model leaves the independent second model eligible',async()=>{
  const d=directory(),requests=v2.SLOTS.map(slot=>v2.spec(slot,v2.MODELS[slot],image));
  const results=await v2.runSlots(requests,r=>run(d,r.slot,jest.fn(async()=>{if(r.slot==='gpt-astra')throw Error('network failure');return response(r.model,output('sence'));})));
  expect(results.map(r=>r.status)).toEqual(['FAILED','COMPLETE']);
});
test('body timeout remains consumed and secret echoes are never saved',async()=>{
  const d=directory(),fetchImpl=jest.fn(async()=>({ok:true,status:200,headers:{get:()=>null},text:()=>new Promise(()=>{})}));
  expect((await run(d,'gpt-astra',fetchImpl,{timeoutMs:30})).errorCode).toBe('V2_TIMEOUT');
  await expect(run(d,'gpt-astra',fetchImpl)).rejects.toThrow('CONSUMED');
  const state=await run(d,'claude-fable',jest.fn(async()=>response(v2.MODELS['claude-fable'],output(key))));expect(state.errorCode).toBe('V2_SECRET_ECHO_WITHHELD');
  for(const slot of v2.SLOTS)for(const f of fs.readdirSync(path.join(d,slot)))expect(fs.readFileSync(path.join(d,slot,f),'utf8')).not.toContain(key);
});
test('deleted, uncertain and artifact segments cannot be concatenated into active text',()=>{
  const value=output('visible');value.segments.push({type:'CROSSED_OUT_OR_DELETED',text:'deleted',confidence:.9,notes:'Strike'},
    {type:'UNCERTAIN',text:null,confidence:.1,notes:'Overlap'},{type:'NON_STUDENT_ARTIFACT',text:'brand',confidence:.9,notes:'Artifact'});
  value.uncertainSpans.push({visibleContext:'visible',candidateReading:null,reason:'Unclear stroke'});
  expect(v2.validate(JSON.stringify(value))).toEqual(value);
  expect(()=>v2.validate(JSON.stringify({...value,activeTranscript:'visible\ndeleted'}))).toThrow();
});
test('new ledger location cannot consume V1 or correction real-one budgets',()=>{
  expect(v2.DIRECTORY).not.toBe(v1.DIRECTORY);expect(v2.DIRECTORY).not.toContain('real-one');
  const d=directory(),budget=new v2.Budget(d);for(const slot of v2.SLOTS){budget.reserve(slot,'attempt',{});expect(()=>new v2.Budget(d).reserve(slot,'attempt',{})).toThrow('CONSUMED');}
  expect(()=>budget.reserve('google','attempt',{})).toThrow();
});
test('V2 imports no production OCR/correction/scoring/DB/publication clients and never runs V1',()=>{
  const code=['benchmark-v2.cjs','astra-vs-fable-page01-v2.cjs','comparison-v2.cjs'].map(n=>fs.readFileSync(path.join(__dirname,'../scripts/ocr-benchmark',n),'utf8')).join('\n');
  expect(code).not.toMatch(/require\([^)]*(?:visionOcr|google-cloud|canonicalEvaluation|scoring|rubric|firebase-admin|mongoose|publication|server\.js|app\.js)/i);
  expect(code).not.toContain('gateway.generate(');expect(code).toContain('gateway.providerAttempt');expect(code).toContain('writeRoot:false');
});
