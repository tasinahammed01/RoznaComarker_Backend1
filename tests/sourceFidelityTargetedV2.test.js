'use strict';
const sharp=require('sharp');
const t=require('../src/services/sourceFidelity/targetedVerification');
const source=require('../src/services/sourceFidelityOcr.service');
const gate=require('../src/utils/sourceFidelity');
const gold=require('./fixtures/source-fidelity/golden-002.cjs');
const historical=require('./fixtures/source-fidelity/golden-002-readers.cjs');
const seg=(text,type='ACTIVE_STUDENT_TEXT')=>({text,type,confidence:.9,notes:''});
const reading=text=>({activeTranscript:text,segments:[seg(text)],uncertainSpans:[]});
const env={NODE_ENV:'test',OCR_SOURCE_MODE:'astra_verified',OCR_SOURCE_VERIFICATION_MODE:'targeted_v2',
  OCR_ASTRA_MODEL:'openai/gpt-6-astra',OCR_FABLE_MODEL:'anthropic/claude-fable-5.1',OPENROUTER_API_KEY:'mock-only'};
const page=(texts=['start','sence','end'])=>({width:600,height:200,words:texts.map((text,i)=>({id:'w'+i,text,paragraphIndex:0,symbols:[],
  polygon:[{x:30+i*120,y:70},{x:110+i*120,y:70},{x:110+i*120,y:100},{x:30+i*120,y:100}]}))});
let bytes;beforeAll(async()=>{bytes=await sharp({create:{width:600,height:200,channels:3,background:'white'}}).png().toBuffer();});
const ident=()=>({fileId:'fixture-file',pageNumber:1,inputSha256:t.sha(bytes)});
const plan=(a=reading('start sence end'),b=reading('start sense end'),g=page())=>t.discover({astra:a,fable:b,google:g,identity:ident()});
const readMock=(value=reading('start sence end'))=>jest.fn(async({model})=>({value,returnedModel:model,usage:{cost:.01,completion_tokens:12},durationMs:1}));
const verify=(overrides={})=>t.verify({bytes,identity:ident(),google:page(),astra:reading('start sence end'),fable:reading('start sense end'),
  firstPassStatus:'OCR_UNCERTAIN',env,read:readMock(),...overrides});
test('feature is default off; exact opt-in is local only and never applies to legacy',()=>{
  expect(t.enabled({})).toBe(false);expect(t.enabled(env)).toBe(true);
  for(const change of [{NODE_ENV:'production'},{NODE_ENV:'staging'},{OCR_SOURCE_MODE:'legacy'},{OCR_SOURCE_VERIFICATION_MODE:'typo'}])expect(()=>t.enabled({...env,...change})).toThrow();
});
test('frozen gold is exact input-specific human test authority and active be, without normalization',()=>{
  expect(gold.status).toBe('HUMAN_GOLD');expect(gold.humanReviewed).toBe(true);expect(gold.productionAuthority).toBe(false);
  expect(gold.pendingSpans).toEqual([]);expect(gold.text).toContain('context, marrid wemen');expect(gold.text).toContain('This self-nigleacting');
  expect(gold.reviewedSpans.find(s=>s.quote==='be').classification).toBe('ACTIVE_STUDENT_TEXT');
  const be=gold.reviewedSpans.find(s=>s.quote==='be');expect(gold.text.slice(be.start-3,be.end+7)).toBe('to be divote');
  expect(gold.inputSha256).toBe(historical.inputSha256);
});
test('lexical disagreement generates a geometry-bounded row, not a corrected word',()=>{
  const p=plan();expect(p.reasonCodes).toContain('ASTRA_FABLE_TEXT_DISAGREEMENT');expect(p.regions).toHaveLength(1);
  expect(p.regions[0].sourceGeometryWordIds).toEqual(['w0','w1','w2']);expect(p.regions[0].mapping.state).toBe('UNIQUE_STRUCTURAL_SPAN');
});
test('segment role conflict and active/deleted conflict both require review',()=>{
  const a=reading('start end');a.segments.push(seg('sence','CROSSED_OUT_OR_DELETED'));
  const p=plan(a,reading('start sence end'));expect(p.reasonCodes).toEqual(expect.arrayContaining(['ASTRA_FABLE_SEGMENT_ROLE_CONFLICT','ACTIVE_DELETED_CONFLICT']));
});
test('uncertain segments and explicit contexts are candidates without language plausibility',()=>{
  const a=reading('start sence end');a.segments.push(seg('sence','UNCERTAIN'));
  a.uncertainSpans.push({visibleContext:'start sence end',candidateReading:'not sent',reason:'strokes'});
  expect(plan(a,a).reasonCodes).toContain('READER_UNCERTAIN_SPAN');
});
test('physical middle box omission creates occupancy and possible omission signals',()=>{
  const p=plan(reading('start end'),reading('start end'));
  expect(p.reasonCodes).toEqual(expect.arrayContaining(['GEOMETRY_COVERAGE_GAP','POSSIBLE_READER_OMISSION']));
});
test('crop is padded, bounded, pixel-native and SHA deterministic',async()=>{
  const region=plan().regions[0],a=await t.crop(bytes,region,page()),b=await t.crop(bytes,region,page());
  expect(a.bytes.equals(b.bytes)).toBe(true);expect(a.cropSha256).toBe(t.sha(a.bytes));
  expect(a.cropDimensions.width).toBe(region.nativeCoordinates.width);expect(region.nativeCoordinates.left).toBeLessThan(30);
  expect(a.transform).toMatchObject({offsetX:region.nativeCoordinates.left,scaleX:1,inputWidth:600});
  await expect(t.crop(Buffer.from('wrong'),region,page())).rejects.toThrow('OCR_TARGETED_INPUT_HASH');
  await expect(t.crop(bytes,{...region,nativeCoordinates:{left:0,top:0,width:600,height:200}},page())).rejects.toThrow('OCR_TARGETED_AREA_LIMIT');
});
test('multiple signals on one row deduplicate to one crop deterministically',()=>{
  const a=reading('start sence end');a.uncertainSpans.push({visibleContext:a.activeTranscript,candidateReading:null,reason:'stroke'});
  expect(plan(a).regions).toHaveLength(1);expect(plan(a)).toEqual(plan(a));
});
test('candidate count is bounded; dropped regions remain unresolved',()=>{
  const g={width:600,height:4000,words:[]};let text='';
  for(let i=0;i<20;i++){g.words.push(...page(['start'+i,'middle'+i,'end'+i]).words.map(w=>({...w,id:w.id+'_'+i,paragraphIndex:i,polygon:w.polygon.map(p=>({...p,y:p.y+i*150}))})));text+=(i?'\n':'')+'start'+i+' end'+i;}
  const p=plan(reading(text),reading(text),g);expect(p.regions).toHaveLength(t.LIMITS.regionsPerPage);expect(p.omittedRegionCount).toBeGreaterThan(0);
});
test('same crop and generic prompt sent independently; no first-pass/Google/gold hints',async()=>{
  const read=readMock(),r=await verify({read});const args=read.mock.calls.map(c=>c[0]);expect(args).toHaveLength(2);
  expect(args[0].bytes.equals(args[1].bytes)).toBe(true);expect(t.sha(args[0].prompt)).toBe(t.sha(args[1].prompt));
  expect(args[0].prompt).toBe(t.PROMPT);for(const key of ['astra','fable','google','humanGold','candidateReading','identity','expectedText'])expect(args[0]).not.toHaveProperty(key);
  expect(r.results[0].status).toBe('TARGETED_MODEL_AGREED');expect(r.status).toBe('MODEL_AGREED');expect(r.stage).toBe('TARGETED_MODEL_AGREED');
  expect(r.text).toBe('start sence end');expect(r.summary.readers[0].usage.cost).toBe(.01);
});
test.each(['disagreement','failure','role','uncertainty','geometry','wrong-model'])('%s keeps original Astra and uncertain source',async kind=>{
  let calls=0;const read=jest.fn(async({model})=>{calls++;if(kind==='failure'&&calls===2)throw Error('private-secret');
    let value=reading(kind==='geometry'?'start end':'start sence end');
    if(kind==='disagreement'&&calls===2)value=reading('start sense end');
    if(kind==='role'&&calls===2)value.segments.push(seg('x','CROSSED_OUT_OR_DELETED'));
    if(kind==='uncertainty')value.uncertainSpans.push({visibleContext:'sence',candidateReading:null,reason:'stroke'});
    return {value,returnedModel:kind==='wrong-model'?'fallback-model':model};});
  const r=await verify({read});expect(r.status).toBe('OCR_UNCERTAIN');expect(r.text).toBe('start sence end');expect(read).toHaveBeenCalledTimes(2);
});
test('unique structural mapping permits a literal replacement without dictionary repair',async()=>{
  const r=await verify({read:readMock(reading('start sEnce end'))});expect(r.text).toBe('start sEnce end');
  expect(r.results[0].reconciliation).toMatchObject({originalFirstPassSpan:'start sence end',targetedTranscript:'start sEnce end',alignmentState:'UNIQUE_STRUCTURAL_SPAN',beforeOffsets:{start:0,end:15}});
});
test('ambiguous mapping refuses patch, never fuzzy matches a semantic phrase',()=>{
  const region=plan().regions[0];region.mapping={state:'MAPPING_WITHHELD'};
  expect(t.reconcile('start sence end',region,reading('start sense end')).alignmentState).toBe('MAPPING_WITHHELD');
  const p=plan(reading('start sence end\nstart sence end'),reading('start sense end\nstart sence end'));
  expect(p.regions.every(r=>r.mapping.state==='MAPPING_WITHHELD')).toBe(true);
});
test('whitespace, case and punctuation are never normalized by reconciliation',()=>{
  const r=plan().regions[0],s='start  sEnce,  end';const out=t.reconcile('start sence end',r,reading(s));expect(out.replacement).toBe(s);
  expect(t.reconcile('start sence end',r,reading('Start sense end')).alignmentState).toBe('MAPPING_WITHHELD');
});
test('submission budget bounds many pages and global call concurrency',async()=>{
  const budget=t.createBudget();let active=0,peak=0;
  const read=jest.fn(async({model})=>{active++;peak=Math.max(peak,active);await new Promise(r=>setImmediate(r));active--;return {value:reading('start sence end'),returnedModel:model};});
  const out=await Promise.all(Array.from({length:20},()=>verify({budget,read})));
  expect(read.mock.calls.length).toBeLessThanOrEqual(12);expect(budget.calls).toBe(12);expect(peak).toBeLessThanOrEqual(2);expect(out.some(r=>r.status==='OCR_UNCERTAIN')).toBe(true);
});
test('abort prevents calls; superseded jobs prevent evidence acceptance',async()=>{
  const c=new AbortController();c.abort();const read=readMock();
  await expect(verify({read,signal:c.signal})).rejects.toThrow('OCR_JOB_SUPERSEDED');expect(read).not.toHaveBeenCalled();
  await expect(verify({read,isCurrentJob:async()=>false})).rejects.toThrow('OCR_JOB_SUPERSEDED');
});
test('unresolved candidates block both correction and scoring eligibility even with a forged MODEL_AGREED',()=>{
  const text='start sence end',p={fileId:'f',fileOrder:0,pageIndex:0,sourceFidelityStatus:'MODEL_AGREED',sourceTextExact:text,sourceTextSha256:t.sha(text),
    sourceFidelityVersion:t.VERSION,sourceVerificationStage:'TARGETED_MODEL_AGREED',sourceVerificationSummary:{unresolvedTargetedCount:1}};
  const doc={file:'f',sourceFidelityMode:'astra_verified',sourceFidelityStatus:'MODEL_AGREED',sourceTranscriptExact:text,sourceTranscriptSha256:t.sha(text),ocrPages:[p]};
  expect(gate.eligible(doc)).toBe(false);expect(gate.blockedState()).toMatchObject({correctionStatus:'failed',assessmentStatus:'failed'});
  p.sourceVerificationSummary.unresolvedTargetedCount=0;expect(gate.eligible(doc)).toBe(true);
});
test('bounded public metadata excludes private transcripts, geometry and provider diagnostics',()=>{
  const doc={sourceFidelityMode:'astra_verified',ocrPages:[{sourceFidelityVersion:t.VERSION,sourceVerificationStage:'OCR_UNCERTAIN',
    sourceVerificationSummary:{candidateRegionCount:2,unresolvedTargetedCount:1,candidateReasons:['READER_UNCERTAIN_SPAN'],privateTranscript:'NEVER PUBLIC'}}]};
  const p=JSON.stringify(gate.payload(doc));expect(p).not.toContain('NEVER PUBLIC');expect(p).not.toContain('google');expect(p).toContain('candidateCount');
});
test('Golden 002 regions are discovered without human gold input; shared case blind spot remains',()=>{
  const p=t.discover({...historical,identity:historical});
  for(const id of ['word_1_35','word_1_46','word_1_101'])expect(p.regions.some(r=>r.sourceGeometryWordIds.includes(id))).toBe(true);
  const inSpan=gold.text.indexOf('because in')+'because '.length;
  const maps=t.tokenMap(gold.text,t.geometryWords(historical.google));const ids=maps.filter(m=>m.start<=inSpan&&m.end>inSpan).map(m=>m.id);
  expect(ids.length).toBeGreaterThan(0);expect(p.regions.some(r=>r.sourceGeometryWordIds.some(id=>ids.includes(id)))).toBe(false);
  expect(p.reasonCodes).toContain('ACTIVE_DELETED_CONFLICT');
});
test('opt-in integrates with readPage and private evidence; default path never invokes cropper',async()=>{
  const raw=page(),g={pages:[{words:[]}],words:raw.words.map(w=>({text:w.text,bbox:{x:0,y:0,w:1,h:1}}))};
  raw.dimensionsMatch=true;Object.defineProperty(g,require('../src/services/hybridSource/shadow').rawEvidence,{value:[raw]});
  const persist=jest.fn(),cropper=jest.fn(t.crop),read=jest.fn(async({model,targeted,role})=>({value:reading(targeted||role==='astra'?'start sence end':'start sense end'),returnedModel:model}));
  const run=e=>source.readPage({bytes,mimeType:'image/png',identity:ident(),google:async()=>g,env:e,reader:read,persistEvidence:persist,targetedCropper:cropper});
  const defaultRun=await run({...env,OCR_SOURCE_VERIFICATION_MODE:undefined});expect(defaultRun.source.sourceFidelityVersion).toBe(source.VERSION);expect(cropper).not.toHaveBeenCalled();
  const v2=await run(env);expect(v2.source.sourceFidelityVersion).toBe(t.VERSION);expect(v2.source.sourceVerificationStage).toBe('TARGETED_MODEL_AGREED');expect(cropper).toHaveBeenCalledTimes(1);
  expect(v2.source.sourceVerificationSummary).not.toHaveProperty('readers');
  expect(persist.mock.calls.at(-1)[0].payload.targeted.results).toHaveLength(1);
});
test('actual targeted source transport uses only the strict wire contract with identical crop/prompt/schema/budget',async()=>{
  const original=global.fetch,requests=[];
  global.fetch=jest.fn(async(_url,options)=>{
    const body=JSON.parse(options.body);requests.push(body);
    const targeted=body.messages[0].content===t.PROMPT;
    const value=reading(targeted||body.model===env.OCR_ASTRA_MODEL?'start sence end':'start sense end');
    return {ok:true,status:200,text:async()=>JSON.stringify({model:body.model,choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}],usage:{total_tokens:10}})};
  });
  try{
    const raw=page();raw.dimensionsMatch=true;
    const g={pages:[{words:[]}],words:raw.words.map(w=>({bbox:{x:1,y:1,w:2,h:2}}))};
    Object.defineProperty(g,require('../src/services/hybridSource/shadow').rawEvidence,{value:[raw]});
    const result=await source.readPage({bytes,mimeType:'image/png',identity:ident(),google:async()=>g,env,persistEvidence:async()=>{}});
    const cropRequests=requests.filter(r=>r.messages[0].content===t.PROMPT);expect(cropRequests).toHaveLength(2);
    for(const r of cropRequests){expect(Object.keys(r).sort()).toEqual(['model','messages','max_completion_tokens','response_format','provider'].sort());
      expect(r).not.toHaveProperty('temperature');expect(r).not.toHaveProperty('max_tokens');expect(r.max_completion_tokens).toBe(12000);
      expect(r.provider).toEqual({require_parameters:true,allow_fallbacks:false});}
    expect(cropRequests[0].messages).toEqual(cropRequests[1].messages);expect(cropRequests[0].response_format).toEqual(cropRequests[1].response_format);
    expect(requests).toHaveLength(4);expect(result.source.sourceVerificationStage).toBe('TARGETED_MODEL_AGREED');
  }finally{global.fetch=original;}
});
test('coverage evaluation reports every frozen gold difference and residual blind spots truthfully',()=>{
  const r=require('../scripts/targeted-v2-golden002-coverage.cjs').evaluate();
  expect(r.knownRegions).toBe(16);expect(r.detectedRegions+r.undetectableRegions).toBe(r.knownRegions);
  expect(r.matrix.find(f=>f.start===164).detectedBy).toBe('NOT_DETECTABLE_WITH_CURRENT_SIGNALS');
  expect(r.matrix.find(f=>f.start===551).detectedBy).toBe('NOT_DETECTABLE_WITH_CURRENT_SIGNALS');
  expect(r.matrix.find(f=>f.start===248).regionIds.length).toBeGreaterThan(0);
  expect(r.matrix.find(f=>f.start===503).regionIds.length).toBeGreaterThan(0);
  expect(r.providerCalls).toBe(0);
});
test('timeouts abort without retries or accepting a late provider result',async()=>{
  jest.useFakeTimers();const read=jest.fn(({signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('timeout-private')),{once:true})));
  try{const pending=verify({read,cropper:async()=>({bytes:Buffer.from('mock-crop'),mimeType:'image/png',cropSha256:'test',cropDimensions:{width:10,height:10},transform:{}})});
    await jest.advanceTimersByTimeAsync(t.LIMITS.timeoutMs+1);const r=await pending;
    expect(r.status).toBe('OCR_UNCERTAIN');expect(read).toHaveBeenCalledTimes(2);
  }finally{jest.useRealTimers();}
});
test('bounded telemetry contains no full reader text, Google lexical strings, image bytes or provider errors',async()=>{
  const r=await verify();const summary=JSON.stringify(r.summary);
  for(const secret of ['start sence end','start sense end','private-secret','base64','segments','activeTranscript'])expect(summary).not.toContain(secret);
});
test('unchanged first-pass agreement has its own model-only stage and zero rereads',async()=>{
  const read=readMock();const r=await verify({astra:reading('start sence end'),fable:reading('start sence end'),firstPassStatus:'MODEL_AGREED',read});
  expect(r.stage).toBe('FIRST_PASS_MODEL_AGREED');expect(read).not.toHaveBeenCalled();
  expect(JSON.stringify(r.summary)).not.toContain('HUMAN_VERIFIED');
});
test('single-box artifact candidates are withheld rather than cropped as individual characters',async()=>{
  const region=plan().regions[0];region.sourceGeometryWordIds=['w1'];
  await expect(t.crop(bytes,region,page())).rejects.toThrow('OCR_TARGETED_CONTEXT_INSUFFICIENT');
});
test('generic detector never sees frozen fixture strings or imports human-gold files',()=>{
  const fs=require('fs'),path=require('path');
  const code=fs.readFileSync(path.join(__dirname,'../src/services/sourceFidelity/targetedVerification.js'),'utf8');
  for(const forbidden of ['golden-002','6ad7bfaa7ee2b01125accf51','marrid','self-nigleacting','Judiment','human-gold','fixtures/'])expect(code).not.toContain(forbidden);
});
test('planning/resource failure preserves primary text, private failure code and assessment block',async()=>{
  const raw=page();raw.dimensionsMatch=true;const g={pages:[{words:[]}],words:[{bbox:{x:1,y:1,w:1,h:1}}]};
  Object.defineProperty(g,require('../src/services/hybridSource/shadow').rawEvidence,{value:[raw]});
  const spy=jest.spyOn(t,'verify').mockRejectedValue(Error('private planning details'));
  try{const r=await source.readPage({bytes,mimeType:'image/png',identity:ident(),google:async()=>g,env,
    reader:readMock(),persistEvidence:async()=>{}});
    expect(r.fullText).toBe('start sence end');expect(r.source.sourceFidelityStatus).toBe('OCR_UNCERTAIN');
    expect(r.source.sourceVerificationSummary.unresolvedTargetedCount).toBe(1);expect(JSON.stringify(r.source)).not.toContain('private planning details');
  }finally{spy.mockRestore();}
});
