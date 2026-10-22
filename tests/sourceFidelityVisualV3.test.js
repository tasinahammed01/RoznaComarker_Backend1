'use strict';
const sharp=require('sharp'),fs=require('fs'),path=require('path');
const v=require('../src/services/sourceFidelity/visualContextV3'),t=require('../src/services/sourceFidelity/targetedVerification'),source=require('../src/services/sourceFidelityOcr.service'),gate=require('../src/utils/sourceFidelity');
const smoke=require('../scripts/targeted-v3-live-smoke.cjs'),history=require('./fixtures/source-fidelity/targeted-failed-run.cjs');
const env={NODE_ENV:'test',OCR_SOURCE_MODE:'astra_verified',OCR_SOURCE_VERIFICATION_MODE:'targeted_v3',OCR_ASTRA_MODEL:'openai/gpt-6-astra',OCR_FABLE_MODEL:'anthropic/claude-fable-5.1',OPENROUTER_API_KEY:'mock-secret'};
const reading=text=>({activeTranscript:text,segments:[{type:'ACTIVE_STUDENT_TEXT',text,confidence:.8,notes:''}],uncertainSpans:[]});
const native=()=>({width:600,height:400,dimensionsMatch:true,words:['aa','bb','cc','dd','ee'].map((text,i)=>({id:'w'+i,text,paragraphIndex:0,symbols:[],polygon:[{x:30+i*100,y:150},{x:90+i*100,y:150},{x:90+i*100,y:180},{x:30+i*100,y:180}]}))});
let bytes,g,region,bundle;
const signals=[{ids:['w2'],reason:'GEOMETRY_COVERAGE_GAP'}];
beforeAll(async()=>{g=native();bytes=await sharp({create:{width:600,height:400,channels:3,background:'#ffffff'}}).composite([{input:Buffer.from('<svg width="600" height="400"><path d="M40 170 L470 160" stroke="black" stroke-width="3"/></svg>')}]).png().toBuffer();
  region=t.discover({astra:reading('aa bb cc dd ee'),fable:reading('aa bb xx dd ee'),google:g,identity:{fileId:'f',pageNumber:1,inputSha256:v.sha(bytes)}}).regions[0];bundle=await v.bundle(bytes,region,g,signals);});
const verify=(changes={})=>t.verify({bytes,identity:{fileId:'f',pageNumber:1,inputSha256:v.sha(bytes)},google:g,astra:reading('aa bb cc dd ee'),fable:reading('aa bb xx dd ee'),firstPassStatus:'OCR_UNCERTAIN',env,
  read:jest.fn(async({model})=>({value:reading('aa bb cc dd ee'),returnedModel:model})),...changes});
const response=(value,status=200)=>({ok:status>=200&&status<300,status,text:async()=>JSON.stringify(value)});
const fetchOK=(text='aa bb cc dd ee')=>jest.fn(async(_u,o)=>response({model:JSON.parse(o.body).model,choices:[{finish_reason:'stop',message:{content:JSON.stringify(reading(text))}}],usage:{cost:.01,total_tokens:20}}));

test('relative margins scale with geometry; candidate, row anchors and complete stroke envelope are preserved',()=>{
  const a=v.geometry(g,region,signals);expect(a.candidateBoxCoverage).toBe(1);expect(a.leftAnchorIncluded&&a.rightAnchorIncluded).toBe(true);
  expect(a.topMarginPixels).toBe(21);expect(a.bottomMarginPixels).toBe(21);expect(a.contextRect.height).not.toBe(80);
  const doubled={...g,width:1200,height:800,words:g.words.map(w=>({...w,polygon:w.polygon.map(p=>({x:p.x*2,y:p.y*2}))}))};
  const b=v.geometry(doubled,region,signals);expect(b.topMarginPixels).toBe(a.topMarginPixels*2);expect(b.contextRect.height).toBe(a.contextRect.height*2);
});
test('focus is contextual with immediate anchors and cannot isolate a letter; full context retains all candidates',()=>{
  const a=v.geometry(g,region,signals);expect(a.focusIds).toEqual(['w1','w2','w3']);expect(a.focusLeftAnchorIncluded&&a.focusRightAnchorIncluded).toBe(true);
  expect(a.focusRect.width).toBeLessThan(a.contextRect.width);expect(a.focusRect.width).toBeGreaterThan(a.medianWordHeight*2);
  expect(()=>v.geometry(g,{...region,sourceGeometryWordIds:['w2']})).toThrow('OCR_V3_CONTEXT_INSUFFICIENT');
});
test('bounds clamp deterministically, retain candidate boxes and report unavailable margin at page edges',()=>{
  const edge={...g,words:g.words.map(w=>({...w,polygon:w.polygon.map(p=>({...p,y:p.y-150}))}))};
  const a=v.geometry(edge,region,signals);expect(a.contextRect.top).toBe(0);expect(a.candidateBoxCoverage).toBe(1);expect(a.imageBoundsLimited).toBe(true);expect(a.topMarginPixels).toBe(0);
  const bottom={...g,words:g.words.map(w=>({...w,polygon:w.polygon.map(p=>({...p,y:p.y+220}))}))};const b=v.geometry(bottom,region,signals);expect(b.contextRect.top+b.contextRect.height).toBe(400);
});
test('nearby-row noise is bounded and reported; margins never collapse around overlapping slanted rows',()=>{
  expect(v.geometry(g,region,signals).neighborRowInkRisk).toBe(false);
  const near={...g,words:[...g.words,...g.words.map(w=>({...w,id:w.id+'n',polygon:w.polygon.map(p=>({...p,y:p.y+40}))}))]};
  const a=v.geometry(near,region,signals);expect(a.neighborRowInkRisk).toBe(true);expect(a.focusTopMarginPixels).toBe(21);expect(a.focusBottomMarginPixels).toBe(21);
  expect(a.contextNeighborRows).toBeLessThanOrEqual(2);expect(a.contextRect.height).toBeLessThan(5*a.medianWordHeight);
});
test('duplicate/overlapping candidate IDs do not expand context nondeterministically; missing geometry fails closed',()=>{
  expect(v.geometry(g,{...region,sourceGeometryWordIds:[...region.sourceGeometryWordIds,'w1']},signals)).toEqual(v.geometry(g,region,signals));
  expect(()=>v.geometry(g,{...region,sourceGeometryWordIds:['missing','w1']})).toThrow('OCR_V3_CONTEXT_INSUFFICIENT');
  const poisoned={...g,words:g.words.map(w=>({...w,text:'DO NOT USE EXPECTED SPELLING',symbols:[{text:'ignored'}]}))};
  expect(v.geometry(poisoned,region,signals)).toEqual(v.geometry(g,region,signals));
});
test('deterministic hashes, dimensions, input SHA and original decoded pixel equality for both unenhanced views',async()=>{
  const again=await v.bundle(bytes,region,g,signals);expect(again.audit).toEqual(bundle.audit);expect(bundle.audit.enhancementApplied).toBe(false);
  for(const view of bundle.images){expect(v.sha(view.bytes)).toBe(view.sha256);const raw=await sharp(view.bytes).raw().toBuffer(),expected=await sharp(bytes).extract(view.rect).raw().toBuffer();expect(raw.equals(expected)).toBe(true);}
  await expect(v.bundle(Buffer.from('wrong'),region,g,signals)).rejects.toThrow('OCR_TARGETED_INPUT_HASH');
  await expect(v.bundle(bytes,region,{...g,width:601},signals)).rejects.toThrow('OCR_TARGETED_DIMENSIONS');
});
test('pixel audit detects clipped ink and does not classify a blank boundary or full-width rule as letter clipping',async()=>{
  const rect={left:0,top:0,width:600,height:100};
  const ink=await sharp({create:{width:600,height:100,channels:3,background:'white'}}).composite([{input:Buffer.from('<svg width="600" height="100"><path d="M100 0 L100 99" stroke="black" stroke-width="10"/></svg>')}]).png().toBuffer();
  expect((await v.edgeMetrics(ink,rect,30)).topBoundaryInkRisk).toBe(true);expect((await v.edgeMetrics(bytes,rect,30)).topBoundaryInkRisk).toBe(false);
  const rule=await sharp({create:{width:600,height:100,channels:3,background:'white'}}).composite([{input:Buffer.from('<svg width="600" height="100"><path d="M0 1 L600 1" stroke="black" stroke-width="3"/></svg>')}]).png().toBuffer();
  expect((await v.edgeMetrics(rule,rect,30)).topBoundaryInkRisk).toBe(false);
});
test('V3 is explicit development/test exact-source opt-in; V2/default behavior and production/staging restrictions remain',()=>{
  expect(t.enabled({})).toBe(false);expect(t.enabled(env)).toBe(true);expect(t.enabled({...env,OCR_SOURCE_VERIFICATION_MODE:'targeted_v2'})).toBe(true);
  for(const change of [{NODE_ENV:'production'},{NODE_ENV:'staging'},{NODE_ENV:undefined},{OCR_SOURCE_MODE:'legacy'}])expect(()=>t.enabled({...env,...change})).toThrow('OCR_SOURCE_TARGETED_LOCAL_ONLY');
});
test('same two original views, prompt, schema and strict five-key wire profile are sent independently without lexical hints',async()=>{
  const fetchImpl=fetchOK();for(const model of [env.OCR_ASTRA_MODEL,env.OCR_FABLE_MODEL])await source.reader({model,bytes:bundle.bytes,mimeType:'image/png',images:bundle.images,targeted:true,prompt:v.PROMPT,env,fetchImpl});
  const bodies=fetchImpl.mock.calls.map(c=>JSON.parse(c[1].body));expect(bodies[0].messages).toEqual(bodies[1].messages);expect(bodies[0].response_format).toEqual(bodies[1].response_format);
  for(const b of bodies){expect(Object.keys(b).sort()).toEqual(['model','messages','max_completion_tokens','response_format','provider'].sort());expect(b.provider).toEqual({require_parameters:true,allow_fallbacks:false});
    expect(b.max_completion_tokens).toBe(12000);expect(b.messages[1].content.filter(p=>p.type==='image_url')).toHaveLength(2);
    expect(b.messages).toEqual(source.readerMessages({bytes:bundle.bytes,mimeType:'image/png',images:bundle.images,targeted:true,prompt:v.PROMPT}));}
  for(const banned of ['Judiment','wemen','marrid','Google','aa bb','human'])expect(v.PROMPT).not.toContain(banned);
});
test('shared verifier retains conservative acceptance and structural mapping for V3',async()=>{
  const read=jest.fn(async({model,images,prompt})=>{expect(images).toHaveLength(2);expect(prompt).toBe(v.PROMPT);return {value:reading('aa bb cc dd ee'),returnedModel:model};});
  const result=await verify({read});expect(result.status).toBe('MODEL_AGREED');expect(result.version).toBe('targeted-source-v3');expect(result.results[0].reconciliation.alignmentState).toBe('UNIQUE_STRUCTURAL_SPAN');
  expect(read).toHaveBeenCalledTimes(2);expect(read.mock.calls[0][0].images.map(i=>i.sha256)).toEqual(read.mock.calls[1][0].images.map(i=>i.sha256));
});
test.each(['disagreement','uncertainty','role','model','unmapped'])('V3 %s stays uncertain and preserves original primary without semantic repair',async kind=>{
  const read=jest.fn(async({model,role})=>{const value=reading(kind==='disagreement'&&role==='fable'?'aa bb repaired dd ee':'aa bb cc dd ee');
    if(kind==='uncertainty')value.uncertainSpans.push({visibleContext:'bb cc',candidateReading:null,reason:'unreadable'});
    if(kind==='role'&&role==='fable')value.segments.push({type:'NON_STUDENT_ARTIFACT',text:null,confidence:.7,notes:''});
    return {value,returnedModel:kind==='model'?'other/model':model};});
  const result=await verify({read,...(kind==='unmapped'?{astra:reading('prefix aa bb cc dd ee')}:{})});expect(result.status).toBe('OCR_UNCERTAIN');expect(result.text).toBe(kind==='unmapped'?'prefix aa bb cc dd ee':'aa bb cc dd ee');
});
test('V3 source gate requires zero targeted blockers and valid verification stage',()=>{
  const page={fileId:'f',fileOrder:0,pageIndex:0,pageNumber:1,sourceTextExact:'aa',sourceTextSha256:v.sha('aa'),sourceFidelityVersion:'targeted-source-v3',sourceFidelityStatus:'MODEL_AGREED',sourceVerificationStage:'TARGETED_MODEL_AGREED',sourceVerificationSummary:{unresolvedTargetedCount:1}};
  const doc={file:'f',ocrPages:[page]};Object.assign(doc,gate.aggregate(doc));expect(gate.eligible(doc)).toBe(false);
  page.sourceVerificationSummary.unresolvedTargetedCount=0;Object.assign(doc,gate.aggregate(doc));expect(gate.eligible(doc)).toBe(true);
});
test('page integration uses unchanged first-pass inputs, then V3 two-view readers, with versioned bounded evidence',async()=>{
  const raw=require('../src/services/hybridSource/shadow').rawEvidence;
  const google={pages:[{pageNumber:1}],words:[{bbox:{x:0,y:0,w:1,h:1}}],[raw]:[g]},persistEvidence=jest.fn();
  const read=jest.fn(async({model,targeted,images})=>{expect(Boolean(images)).toBe(Boolean(targeted));return {value:reading(model===env.OCR_FABLE_MODEL&&!targeted?'aa bb xx dd ee':'aa bb cc dd ee'),returnedModel:model};});
  const r=await source.readPage({bytes,mimeType:'image/png',identity:{submissionId:'s',runId:'j',fileId:'f',pageNumber:1},google:async()=>google,reader:read,persistEvidence,env});
  expect(read).toHaveBeenCalledTimes(4);expect(r.source.sourceFidelityVersion).toBe('targeted-source-v3');expect(r.source.sourceVerificationSummary.unresolvedTargetedCount).toBe(0);
  const saved=persistEvidence.mock.calls[0][0];expect(saved.payload.targeted.results[0].region.visualContext.originalPixelsOnly).toBe(true);
  expect(JSON.stringify(saved)).not.toContain('base64');expect(saved.payload.targeted.version).toBe('targeted-source-v3');
});
test('preflight rejects changed stored job/source before local image or provider work',async()=>{
  await expect(smoke.prepare({submissionId:'other',ocrJobId:smoke.PIN.jobId})).rejects.toThrow('SMOKE_JOB_IDENTITY');
  const e={...structuredClone(history),sourceTranscriptExact:history.pages[0].exactText,sourceTranscriptSha256:'bad'};
  await expect(smoke.prepare(e)).rejects.toThrow('SMOKE_SOURCE_HASH');
});
test('post-result evaluation remains honest about distance improvement without source eligibility',()=>{
  const evaluation=require('../scripts/lib/targetedV3Evaluation.cjs'),old={readers:[{schemaValid:true,activeTranscript:'a c'},{schemaValid:true,activeTranscript:'a x c'}]},result={readers:[{requestedModel:'a',schemaValid:true,activeTranscript:'a b c',uncertainSpans:[],segments:[]},{requestedModel:'b',schemaValid:true,activeTranscript:'a b c',uncertainSpans:[],segments:[]}],pair:{activeTextExactEqual:true,segmentSignatureEqual:true,hasUncertainty:false,geometryAccountedFor:false},reconciliation:{patchEligible:false}};
  const r=evaluation.evaluate(result,'a b c',old);expect(r.astraNowContainsPreviouslyMissingExactTokens).toBe(true);expect(r.readers[0].characterDistanceImproved).toBe(true);expect(r.automaticSourceImproved).toBe(false);
});

function prepared(){
  const p=structuredClone(history.pages[0]),r=structuredClone(p.targeted.results[7].region);p.inputSha256=v.sha(bytes);r.inputSha256=p.inputSha256;
  const evidence={submissionId:smoke.PIN.submissionId,ocrJobId:smoke.PIN.jobId,sourceTranscriptExact:p.exactText,sourceTranscriptSha256:v.sha(p.exactText)};
  const c={...bundle,images:bundle.images.map(i=>({...i})),audit:{...bundle.audit,inputSha256:p.inputSha256}};
  const manifest={inputSha256:p.inputSha256,sourceTranscriptSha256:evidence.sourceTranscriptSha256,contextSha256:bundle.images[0].sha256,focusSha256:bundle.images[1].sha256,contextDimensions:bundle.images[0].dimensions,focusDimensions:bundle.images[1].dimensions};
  return {value:{page:p,region:r,crop:c,evidence},manifest};
}
test('V3 smoke without flag makes zero calls and never loads gold or mutates source',async()=>{
  const p=prepared(),fetchImpl=fetchOK(),before=JSON.stringify(p.value),r=await smoke.runPair(p.value,{env,manifest:p.manifest,fetchImpl});
  expect(r.status).toBe('PREFLIGHT_ONLY');expect(fetchImpl).not.toHaveBeenCalled();expect(r).not.toHaveProperty('humanGoldComparison');expect(JSON.stringify(p.value)).toBe(before);
});
test('future smoke is capped at two no-retry original-bundle attempts and stores diagnostics with patchApplied false',async()=>{
  const p=prepared(),fetchImpl=fetchOK(),r=await smoke.runPair(p.value,{env,manifest:p.manifest,fetchImpl,allowLive:true});
  expect(r.providerCalls).toBe(2);expect(fetchImpl).toHaveBeenCalledTimes(2);expect(r.readers.every(x=>x.outcome==='SUCCESS')).toBe(true);expect(r.reconciliation.patchApplied).toBe(false);expect(r.sourceMutation).toBe(false);
  const bodies=fetchImpl.mock.calls.map(c=>JSON.parse(c[1].body));expect(bodies[0].messages).toEqual(bodies[1].messages);expect(r.readers[0].reportedCost).toBe(.01);
});
test.each(['failure','model','schema'])('future smoke %s has no retries/fallback and no secret error messages',async kind=>{
  const p=prepared(),fetchImpl=jest.fn(async(_u,o)=>{if(kind==='failure')throw Error('private secret error body');return response({model:kind==='model'?'other/model':JSON.parse(o.body).model,choices:[{finish_reason:'stop',message:{content:'{}'}}]});});
  const r=await smoke.runPair(p.value,{env,manifest:p.manifest,fetchImpl,allowLive:true});expect(fetchImpl).toHaveBeenCalledTimes(2);expect(r.providerCalls).toBe(2);expect(JSON.stringify(r)).not.toContain('private secret error body');expect(r.pair.targetedPairState).toBe('TARGETED_OCR_UNCERTAIN');
});
test('smoke rejects tampered hashes, identity or dimensions before spending',async()=>{
  for(const change of [p=>p.value.crop.images[1]={...p.value.crop.images[1],bytes:Buffer.from('tampered')},p=>p.value.evidence={...p.value.evidence,ocrJobId:'foreign'},p=>p.manifest={...p.manifest,focusDimensions:{width:1,height:1}}]){
    const p=prepared(),fetchImpl=fetchOK();change(p);await expect(smoke.runPair(p.value,{env,manifest:p.manifest,fetchImpl,allowLive:true})).rejects.toThrow(/^SMOKE_/);expect(fetchImpl).not.toHaveBeenCalled();}
});
test('diagnostic flags/production blocked; no persistence or whole-page/provider pipeline imports',()=>{
  expect(smoke.args(['--submission',smoke.PIN.submissionId,'--slot','8']).allowLive).toBe(false);
  for(const args of [[],['--submission',smoke.PIN.submissionId,'--slot','9'],['--submission',smoke.PIN.submissionId,'--slot','8','--allow-live','--allow-live']])expect(()=>smoke.args(args)).toThrow();
  const code=fs.readFileSync(path.join(__dirname,'../scripts/targeted-v3-live-smoke.cjs'),'utf8');for(const banned of ['readPage(','updateOne(','findOneAndUpdate(','persistEvidence(','google()'])expect(code).not.toContain(banned);
  const runtime=fs.readFileSync(path.join(__dirname,'../src/services/sourceFidelity/visualContextV3.js'),'utf8');for(const banned of ['golden','Judiment','wemen','1364','779'])expect(runtime).not.toContain(banned);
});
test.each(['production','staging',undefined])('future smoke rejects environment %s before any transport',async nodeEnv=>{
  const p=prepared(),fetchImpl=fetchOK();await expect(smoke.runPair(p.value,{env:{...env,NODE_ENV:nodeEnv},manifest:p.manifest,fetchImpl,allowLive:true})).rejects.toThrow('SMOKE_LOCAL_ONLY');expect(fetchImpl).not.toHaveBeenCalled();
});
