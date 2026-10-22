'use strict';
const fs=require('fs'),os=require('os'),path=require('path');
const core=require('../scripts/ocr-benchmark/benchmark-core.cjs');
const {compare,exactTokens}=require('../scripts/ocr-benchmark/comparison.cjs');
const gateway=require('../src/services/aiGateway.service');
const dirs=[];
function directory() {
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'astra-fable-test-'));dirs.push(d);
  for(const slot of core.SLOTS)fs.mkdirSync(path.join(d,slot));
  return d;
}
const source={file:'/synthetic/page.jpeg',bytes:Buffer.from('synthetic original bytes'),mimeType:'image/jpeg'};
const models={'gpt-astra':'test/gpt-astra-exact','claude-fable':'test/claude-fable-exact'};
const config={OPENROUTER_API_KEY:'unit-secret-not-for-artifacts',OCR_BENCHMARK_GPT_ASTRA_MODEL:models['gpt-astra'],OCR_BENCHMARK_CLAUDE_FABLE_MODEL:models['claude-fable']};
const output=text=>({activeTranscript:text,segments:text.split('\n').map(line=>({type:'ACTIVE_STUDENT_TEXT',text:line,confidence:.99,notes:'Visible glyphs.'})),uncertainSpans:[]});
function response(model,value,options={}) {
  return {ok:options.ok??true,status:options.status??200,headers:{get:()=>null},
    text:async()=>JSON.stringify({model,choices:[{finish_reason:options.finishReason??'stop',message:{content:typeof value==='string'?value:JSON.stringify(value)}}],
      usage:{prompt_tokens:100,completion_tokens:80,total_tokens:180,cost:.003,completion_tokens_details:{reasoning_tokens:20}}})};
}
function run(d,slot,fetchImpl,options={}) {
  const spec=core.requestSpec(slot,models[slot],source);
  return core.runModel({directory:d,spec,image:source,key:config.OPENROUTER_API_KEY,attempt:gateway.providerAttempt,fetchImpl,...options});
}
afterAll(()=>{for(const dir of dirs)fs.rmSync(dir,{recursive:true,force:true});});
test('both configured IDs must be present, distinct and explicit',()=>{
  expect(core.configuration(config).models).toEqual(models);
  expect(()=>core.configuration({...config,OCR_BENCHMARK_GPT_ASTRA_MODEL:''})).toThrow('MISSING');
  expect(()=>core.configuration({...config,OCR_BENCHMARK_CLAUDE_FABLE_MODEL:models['gpt-astra']})).toThrow('DISTINCT');
  for(const id of ['openai/gpt-5.6-sol','openai/gpt-4.1-mini','anthropic/claude-latest','other/model:free',' arbitrary/model','openrouter/auto'])
    expect(()=>core.configuration({...config,OCR_BENCHMARK_GPT_ASTRA_MODEL:id})).toThrow('EXACT_MODEL');
});
test('both specs contain byte-identical prompt, messages, image and schema',()=>{
  const specs=core.SLOTS.map(slot=>core.requestSpec(slot,models[slot],source));
  for(const k of ['promptSha256','imageSha256','schemaSha256','messagesSha256','maxOutputTokens','temperature'])expect(specs[0][k]).toBe(specs[1][k]);
  expect(specs[0].messages).toEqual(specs[1].messages);
  expect(specs[0].messages[0].content).toBe(core.STRICT_FORENSIC_HANDWRITING_PROMPT);
  expect(specs[0].messages[1].content[1].image_url.url).toBe('data:image/jpeg;base64,'+source.bytes.toString('base64'));
  expect(()=>core.parity(specs)).toThrow('PARITY'); // synthetic bytes are intentionally not the real page SHA.
  const exact=specs.map(s=>({...s,imageSha256:core.EXPECTED_SHA}));
  expect(core.parity(exact)).toBe(true);
  expect(()=>core.parity([exact[0],{...exact[1],promptSha256:'bad'}])).toThrow('PARITY');
});
test('shared prompt contains full strict rules and no historical target answers',()=>{
  for(const fragment of ['FORENSIC VISUAL TRANSCRIPTION','THE IMAGE PIXELS ARE THE ONLY AUTHORITY.','DO NOT GUESS.','DO NOT remove repeated words.','Do not use confidence as permission to autocorrect.'])
    expect(core.STRICT_FORENSIC_HANDWRITING_PROMPT).toContain(fragment);
  for(const token of ['sence','sense','relize','relizing','people','People','cultural','Cultural','Vivid','vivid','got rid off','Louise','Mallard'])
    expect(core.STRICT_FORENSIC_HANDWRITING_PROMPT.match(new RegExp('\\b'+token+'\\b','u'))).toBeNull();
});
test.each(['sence','sense','people','People','cultural','Cultural','Vivid','vivid','relize','realize','relizing','got rid off','got rid of','  odd  spacing , “quotes”?!  ','word word'])('validator preserves exact source %s',text=>{
  expect(core.validate(JSON.stringify(output(text))).activeTranscript).toBe(text);
});
test.each([['sence','sense'],['people','People'],['cultural','Cultural'],['Vivid','vivid'],['relize','realize'],['off','of'],['Crying','crying'],['Can','can'],['See','see'],['x?','x!'],['x x','x'],['x  x','x x']])('diagnostic diff distinguishes %s from %s without normalization',(left,right)=>{
  const d=compare(left,right);
  expect(d.counts.total).toBeGreaterThan(0);
  expect(d.operations.map(o=>o.left?.text??'').join('')).toBe(left);
  expect(d.operations.map(o=>o.right?.text??'').join('')).toBe(right);
});
test('diff classifies source-sensitive differences and retains all whitespace',()=>{
  expect(compare('people','People').counts.capitalizationOnly).toBe(1);
  expect(compare('sence','sense').counts.spellingLexical).toBe(1);
  expect(compare('word?','word!').counts.punctuation).toBe(1);
  expect(compare('word','word word').counts.insertionDeletion).toBeGreaterThan(0);
  const text=' \tAlpha\r\nBeta \n';expect(exactTokens(text).map(t=>t.text).join('')).toBe(text);
});
test('deleted, artifact and uncertain segments never enter active text through postprocessing',()=>{
  const value=output('visible');
  value.segments.push({type:'CROSSED_OUT_OR_DELETED',text:'deleted',confidence:.99,notes:'Strike'},
    {type:'UNCERTAIN',text:null,confidence:.1,notes:'Overlap'},
    {type:'NON_STUDENT_ARTIFACT',text:'camera',confidence:.99,notes:'Brand'});
  value.uncertainSpans.push({visibleContext:'near visible',candidateReading:null,reason:'Cannot distinguish strokes'});
  expect(core.validate(JSON.stringify(value))).toEqual(value);
  expect(()=>core.validate(JSON.stringify({...value,activeTranscript:'visible\ndeleted'}))).toThrow('ACTIVE_SEGMENT');
  expect(()=>core.validate(JSON.stringify({...value,correctedText:'Visible'}))).toThrow('SCHEMA');
});
test('both real gateway calls use identical experiments, one transport each, exact output and no fallback',async()=>{
  const d=directory(),bodies=[];
  const fetchImpl=jest.fn(async(url,options)=>{
    expect(url).toBe(core.ENDPOINT);expect(options.redirect).toBe('error');
    const body=JSON.parse(options.body);bodies.push(body);
    const slot=core.SLOTS.find(s=>models[s]===body.model);
    expect(fs.existsSync(path.join(d,slot,'attempt.json'))).toBe(true);
    expect(fs.existsSync(path.join(d,slot,'transport.json'))).toBe(true);
    expect(body.provider).toEqual({allow_fallbacks:false,require_parameters:true});
    expect(body.models).toBeUndefined();
    return response(body.model,output('sence\nPeople\nVivid\ngot rid off'));
  });
  for(const slot of core.SLOTS) {
    const state=await run(d,slot,fetchImpl);
    expect(state.status).toBe('COMPLETE');expect(state.providerCalls).toBe(1);
    expect(fs.readFileSync(path.join(d,slot,'activeTranscript.txt'),'utf8')).toBe('sence\nPeople\nVivid\ngot rid off');
    await expect(run(d,slot,fetchImpl)).rejects.toThrow('CONSUMED');
  }
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect({...bodies[0],model:null}).toEqual({...bodies[1],model:null});
  for(const slot of core.SLOTS)for(const f of fs.readdirSync(path.join(d,slot)))expect(fs.readFileSync(path.join(d,slot,f),'utf8')).not.toContain(config.OPENROUTER_API_KEY);
});
test.each(['http','malformed','schema','wrong-model','truncated'])('%s failure remains consumed, does not retry, and preserves raw evidence',async(kind)=>{
  const d=directory(),slot='gpt-astra';
  const fetchImpl=jest.fn(async()=>{
    if(kind==='http')return {ok:false,status:503,headers:{get:()=>null},text:async()=>JSON.stringify({error:{message:'Unavailable'}})};
    if(kind==='malformed')return response(models[slot],'{"activeTranscript":');
    if(kind==='schema')return response(models[slot],{...output('sence'),correctedText:'sense'});
    if(kind==='wrong-model')return response('test/not-requested',output('sence'));
    return response(models[slot],output('sence'),{finishReason:'length'});
  });
  const state=await run(d,slot,fetchImpl);
  expect(state.status).toBe('FAILED');expect(state.providerCalls).toBe(1);expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(fs.existsSync(path.join(d,slot,'raw-transport-response.txt'))).toBe(true);
  await expect(run(d,slot,fetchImpl)).rejects.toThrow('CONSUMED');expect(fetchImpl).toHaveBeenCalledTimes(1);
});
test('failed first model does not consume or prevent the independent second model',async()=>{
  const d=directory();
  const a=await run(d,'gpt-astra',jest.fn(async()=>{throw Error('network failure');}));
  const b=await run(d,'claude-fable',jest.fn(async()=>response(models['claude-fable'],output('sence'))));
  expect(a.status).toBe('FAILED');expect(b.status).toBe('COMPLETE');
});
test('response-body stall is bounded, consumes attempt and never retries',async()=>{
  const d=directory();
  const fetchImpl=jest.fn(async()=>({ok:true,status:200,headers:{get:()=>null},text:()=>new Promise(()=>{})}));
  const state=await run(d,'gpt-astra',fetchImpl,{timeoutMs:30});
  expect(state.status).toBe('FAILED');expect(state.errorCode).toBe('BENCHMARK_TIMEOUT');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  await expect(run(d,'gpt-astra',fetchImpl)).rejects.toThrow('CONSUMED');
});
test('provider echo of API credential is withheld, not persisted',async()=>{
  const d=directory();
  const state=await run(d,'gpt-astra',jest.fn(async()=>response(models['gpt-astra'],output(config.OPENROUTER_API_KEY))));
  expect(state.status).toBe('FAILED');expect(state.errorCode).toBe('RAW_WITHHELD_SECRET_ECHO');
  for(const f of fs.readdirSync(path.join(d,'gpt-astra')))expect(fs.readFileSync(path.join(d,'gpt-astra',f),'utf8')).not.toContain(config.OPENROUTER_API_KEY);
});
test('budget has exactly two slots and cannot reuse failed reservations after reloading',()=>{
  const d=directory(),b=new core.Budget(d);
  for(const slot of core.SLOTS) {b.reserve(slot,'attempt',{});expect(()=>new core.Budget(d).reserve(slot,'attempt',{})).toThrow('CONSUMED');}
  expect(()=>b.reserve('google','attempt',{})).toThrow('FORBIDDEN');
  expect(()=>b.reserve('gpt-sol','attempt',{})).toThrow('FORBIDDEN');
  expect(b.unused()).toBe(false);
});
test('comparison is diagnostic only and does not treat confidence or agreement as gold',()=>{
  expect(compare('same','same').counts.total).toBe(0);
  expect(compare('same','same').providerAgreementIsNotGold).toBe(true);
  const script=fs.readFileSync(path.join(__dirname,'../scripts/ocr-benchmark/comparison.cjs'),'utf8');
  expect(script).toContain("ACCURACY_WINNER:'UNDETERMINED_PENDING_HUMAN_REVIEW'");
});
test('entry points invoke no correction/scoring/Google/publication clients or production app',()=>{
  const text=['benchmark-core.cjs','astra-vs-fable-page01.cjs','comparison.cjs'].map(n=>fs.readFileSync(path.join(__dirname,'../scripts/ocr-benchmark',n),'utf8')).join('\n');
  expect(text).not.toMatch(/require\([^)]*(?:visionOcr|google-cloud|correctionCanonical|canonicalEvaluation|scoring|rubric|firebase-admin|mongoose|publication|server\.js|app\.js)/i);
  expect(text).not.toContain('gateway.generate(');
  expect(text).toContain('gateway.providerAttempt');
});
const baselinePath=path.join(core.DIRECTORY,'protected-baseline.json');
(fs.existsSync(baselinePath)?test:test.skip)('all prior benchmark ledgers/evidence and protected production files match the preflight baseline',()=>{
  const baseline=core.read(core.DIRECTORY,'protected-baseline.json');
  for(const name of ['real-one','sol-verbatim-page01','source-fidelity-crop-v2-page01'])
    expect(Object.keys(baseline).some(p=>p.includes(name))).toBe(true);
  expect(core.assertSnapshot(baseline)).toBe(Object.keys(baseline).length);
});
