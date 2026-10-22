'use strict';
const mockGoldAccess=[];let mockCompletedReaders=0;
jest.mock('./fixtures/source-fidelity/golden-002.cjs',()=>{mockGoldAccess.push(mockCompletedReaders);return jest.requireActual('./fixtures/source-fidelity/golden-002.cjs');});
const sharp=require('sharp'),fs=require('fs'),path=require('path');
const v3=require('../src/services/sourceFidelity/visualContextV3'),v4=require('../src/services/sourceFidelity/magnifiedFocusV4'),t=require('../src/services/sourceFidelity/targetedVerification');
const source=require('../src/services/sourceFidelityOcr.service'),gate=require('../src/utils/sourceFidelity'),smoke=require('../scripts/targeted-v4-live-smoke.cjs');
const history=require('./fixtures/source-fidelity/targeted-failed-run.cjs'),evaluation=require('../scripts/lib/targetedV4Evaluation.cjs');
const env={NODE_ENV:'test',OCR_SOURCE_MODE:'astra_verified',OCR_SOURCE_VERIFICATION_MODE:'targeted_v4',OCR_ASTRA_MODEL:'openai/gpt-6-astra',OCR_FABLE_MODEL:'anthropic/claude-fable-5.1',OPENROUTER_API_KEY:'mock-only'};
const reading=text=>({activeTranscript:text,segments:[{type:'ACTIVE_STUDENT_TEXT',text,confidence:.8,notes:''}],uncertainSpans:[]});
let bytes,g,region,base,bundle;
const a=reading('aa bb cc dd ee'),b=reading('aa bb xx dd ee'),signals=[{ids:['w2']}];
beforeAll(async()=>{
  g={width:600,height:400,dimensionsMatch:true,words:['aa','bb','cc','dd','ee'].map((text,i)=>({id:'w'+i,text,paragraphIndex:0,symbols:[],polygon:[{x:30+i*100,y:150},{x:90+i*100,y:150},{x:90+i*100,y:180},{x:30+i*100,y:180}]}))};
  bytes=await sharp({create:{width:600,height:400,channels:3,background:'white'}}).composite([{input:Buffer.from('<svg width="600" height="400"><path d="M40 170 L470 160" stroke="black" stroke-width="3"/></svg>')}]).png().toBuffer();
  region=t.discover({astra:a,fable:b,google:g,identity:{fileId:'f',pageNumber:1,inputSha256:v3.sha(bytes)}}).regions[0];
  base=await v3.bundle(bytes,region,g,signals);bundle=await v4.fromV3(base);
});
const response=body=>({ok:true,status:200,text:async()=>JSON.stringify(body)});
const fetchOK=()=>jest.fn(async(_u,o)=>response({model:JSON.parse(o.body).model,choices:[{finish_reason:'stop',message:{content:JSON.stringify(reading('aa bb cc dd ee'))}}],usage:{cost:.02,total_tokens:20}}));
const verify=(changes={})=>t.verify({bytes,identity:{fileId:'f',pageNumber:1,inputSha256:v3.sha(bytes)},google:g,astra:a,fable:b,firstPassStatus:'OCR_UNCERTAIN',env,
  read:jest.fn(async({model})=>({value:reading('aa bb cc dd ee'),returnedModel:model})),...changes});
function prepared(){
  const page=structuredClone(history.pages[0]),r=structuredClone(page.targeted.results[7].region);page.inputSha256=v3.sha(bytes);r.inputSha256=page.inputSha256;
  const evidence={submissionId:smoke.PIN.submissionId,ocrJobId:smoke.PIN.jobId,sourceTranscriptExact:page.exactText,sourceTranscriptSha256:v3.sha(page.exactText)};
  const originalV3Crop={...base,audit:{...base.audit,inputSha256:page.inputSha256}},crop={...bundle,images:bundle.images.map(i=>({...i})),audit:{...bundle.audit,inputSha256:page.inputSha256,magnification:{...bundle.audit.magnification}}};
  const manifest={inputSha256:page.inputSha256,sourceTranscriptSha256:evidence.sourceTranscriptSha256,contextSha256:base.images[0].sha256,focusSha256:base.images[1].sha256,contextDimensions:base.images[0].dimensions,focusDimensions:base.images[1].dimensions,
    magnifiedFocusSha256:bundle.images[1].sha256,magnifiedFocusDimensions:bundle.images[1].dimensions,scaleFactor:3,resizeKernel:'cubic'};
  return {value:{page,region:r,crop,originalV3Crop,evidence},manifest};
}
test('deterministic 3x cubic rendering matches independent resize exactly, with unchanged context and original focus identity',async()=>{
  const original=Buffer.from(base.images[1].bytes),again=await v4.fromV3(base),m=bundle.audit.magnification;
  expect(m).toMatchObject({scaleFactor:3,resizeKernel:'cubic',supplementaryOnly:true,generativeEnhancementUsed:false,brightnessContrastChanged:false});
  expect(bundle.images[0].bytes.equals(base.images[0].bytes)).toBe(true);expect(base.images[1].bytes.equals(original)).toBe(true);
  expect(m.originalFocusSha256).toBe(v3.sha(original));expect(again.images[1].bytes.equals(bundle.images[1].bytes)).toBe(true);
  const w=base.images[1].dimensions.width*3,h=base.images[1].dimensions.height*3;
  const expected=await sharp(original).resize({width:w,height:h,fit:'fill',kernel:sharp.kernel.cubic}).png({compressionLevel:9,adaptiveFiltering:false}).toBuffer();
  expect(bundle.images[1].bytes.equals(expected)).toBe(true);expect((await sharp(bundle.images[1].bytes).metadata()).width).toBe(w);expect(m.magnifiedFocusDimensions).toEqual({width:w,height:h});
  expect(bundle.images.map(i=>i.name)).toEqual(['LINE_CONTEXT_IMAGE','MAGNIFIED_FOCUS_IMAGE']);
});
test.each(['bytes','hash','dimensions','context'])('changed V3 %s fails closed before enlargement',async kind=>{
  const fake={...base,images:base.images.map(i=>({...i,dimensions:{...i.dimensions}})),audit:{...base.audit}};
  if(kind==='bytes')fake.images[1].bytes=Buffer.from('substituted');if(kind==='hash')fake.audit.focusCropSha256='f'.repeat(64);
  if(kind==='dimensions')fake.images[1].dimensions.width++;if(kind==='context')fake.images[0].bytes=Buffer.from('substituted');
  await expect(v4.fromV3(fake)).rejects.toThrow(/^OCR_V4_/);
});
test('only resize/PNG encoding is used; no language, cleanup, enhancement or fixture enters runtime generation',()=>{
  const code=fs.readFileSync(path.join(__dirname,'../src/services/sourceFidelity/magnifiedFocusV4.js'),'utf8');
  for(const banned of ['.sharpen(','.threshold(','.normalise(','.normalize(','.gamma(','.linear(','.median(','.convolve(','.modulate(','golden-002','Judiment','judime','753','2259'])expect(code).not.toContain(banned);
  for(const banned of ['Judiment','judime','judimeyt','human gold','Google','expected spelling'])expect(v4.PROMPT).not.toContain(banned);
  expect(v4.PROMPT).toContain('no new or corrected information');
});
test('V4 opt-in is development/test exact-source only; V2/V3/default remain supported',()=>{
  expect(t.enabled(env)).toBe(true);expect(t.enabled({})).toBe(false);
  for(const mode of ['targeted_v2','targeted_v3'])expect(t.enabled({...env,OCR_SOURCE_VERIFICATION_MODE:mode})).toBe(true);
  for(const change of [{NODE_ENV:'production'},{NODE_ENV:'staging'},{NODE_ENV:undefined},{OCR_SOURCE_MODE:'legacy'}])expect(()=>t.enabled({...env,...change})).toThrow('OCR_SOURCE_TARGETED_LOCAL_ONLY');
});
test('runtime readers receive identical ordered bundle, generic V4 prompt and magnification receipt',async()=>{
  const read=jest.fn(async({model,images,magnifiedFocus,prompt})=>{expect(magnifiedFocus).toBe(true);expect(prompt).toBe(v4.PROMPT);expect(images.map(i=>i.name)).toEqual(['LINE_CONTEXT_IMAGE','MAGNIFIED_FOCUS_IMAGE']);return {value:reading(a.activeTranscript),returnedModel:model};});
  const r=await verify({read});expect(r.version).toBe('targeted-source-v4');expect(r.status).toBe('MODEL_AGREED');expect(read).toHaveBeenCalledTimes(2);
  expect(read.mock.calls[0][0].images.map(i=>i.sha256)).toEqual(read.mock.calls[1][0].images.map(i=>i.sha256));expect(r.results[0].region.visualContext.magnification.scaleFactor).toBe(3);
  expect(r.results[0].reconciliation.provenance.stage).toBe('targeted-source-v4');
});
test.each(['disagreement','uncertainty','role','model','mapping'])('V4 %s cannot publish a partial or guessed source',async kind=>{
  const read=jest.fn(async({model,role})=>{const value=reading(kind==='disagreement'&&role==='fable'?'aa bb fixed dd ee':a.activeTranscript);
    if(kind==='uncertainty')value.uncertainSpans.push({visibleContext:'bb cc',candidateReading:null,reason:'glyph ambiguous'});
    if(kind==='role'&&role==='fable')value.segments.push({type:'NON_STUDENT_ARTIFACT',text:null,confidence:.5,notes:''});
    return {value,returnedModel:kind==='model'?'other/model':model};});
  const primary=kind==='mapping'?reading('prefix '+a.activeTranscript):a,r=await verify({read,astra:primary});expect(r.status).toBe('OCR_UNCERTAIN');expect(r.text).toBe(primary.activeTranscript);
});
test('V4 source gate enforces unresolved count and stage rather than trusting magnification',()=>{
  const p={fileId:'f',fileOrder:0,pageIndex:0,pageNumber:1,sourceTextExact:'aa',sourceTextSha256:v3.sha('aa'),sourceFidelityVersion:'targeted-source-v4',sourceFidelityStatus:'MODEL_AGREED',sourceVerificationStage:'TARGETED_MODEL_AGREED',sourceVerificationSummary:{unresolvedTargetedCount:1}};
  const doc={file:'f',ocrPages:[p]};Object.assign(doc,gate.aggregate(doc));expect(gate.eligible(doc)).toBe(false);p.sourceVerificationSummary.unresolvedTargetedCount=0;Object.assign(doc,gate.aggregate(doc));expect(gate.eligible(doc)).toBe(true);
});
test('V4 page integration preserves first pass, emits V4 version and stores only bounded image provenance',async()=>{
  const raw=require('../src/services/hybridSource/shadow').rawEvidence,persistEvidence=jest.fn(),read=jest.fn(async({model,targeted,magnifiedFocus})=>{
    expect(Boolean(magnifiedFocus)).toBe(Boolean(targeted));return {value:reading(model===env.OCR_FABLE_MODEL&&!targeted?b.activeTranscript:a.activeTranscript),returnedModel:model};});
  const r=await source.readPage({bytes,mimeType:'image/png',identity:{submissionId:'s',runId:'j',fileId:'f',pageNumber:1},google:async()=>({pages:[{pageNumber:1}],words:[{bbox:{x:0,y:0,w:1,h:1}}],[raw]:[g]}),reader:read,persistEvidence,env});
  expect(r.source.sourceFidelityVersion).toBe('targeted-source-v4');expect(read).toHaveBeenCalledTimes(4);expect(JSON.stringify(persistEvidence.mock.calls)).not.toContain('base64');
});
test('future smoke without flag has no reader/fetch/gold or source mutation',async()=>{
  const p=prepared(),fetchImpl=fetchOK(),snapshot=JSON.stringify(p.value),spy=jest.spyOn(source,'reader');try{
    const r=await smoke.runPair(p.value,{env,manifest:p.manifest,fetchImpl});expect(r.providerCalls).toBe(0);expect(fetchImpl).not.toHaveBeenCalled();expect(spy).not.toHaveBeenCalled();expect(r).not.toHaveProperty('humanGoldComparison');expect(JSON.stringify(p.value)).toBe(snapshot);expect(mockGoldAccess).toHaveLength(0);
  }finally{spy.mockRestore();}
});
test('two mocked future requests preserve five-key wire, models/schema/order and delay gold until both completed',async()=>{
  const p=prepared(),fetchImpl=fetchOK(),original=source.reader;mockCompletedReaders=0;
  const spy=jest.spyOn(source,'reader').mockImplementation(async args=>{const r=await original(args);mockCompletedReaders++;return r;});
  try{const r=await smoke.runPair(p.value,{env,manifest:p.manifest,fetchImpl,allowLive:true});expect(fetchImpl).toHaveBeenCalledTimes(2);expect(r.providerCalls).toBe(2);expect(mockGoldAccess).toEqual([2]);
    const bodies=fetchImpl.mock.calls.map(c=>JSON.parse(c[1].body));expect(bodies.map(b=>b.model)).toEqual([env.OCR_ASTRA_MODEL,env.OCR_FABLE_MODEL]);expect(bodies[0].messages).toEqual(bodies[1].messages);expect(bodies[0].response_format).toEqual(bodies[1].response_format);
    for(const body of bodies){expect(Object.keys(body).sort()).toEqual(['model','messages','max_completion_tokens','response_format','provider'].sort());expect(body.max_completion_tokens).toBe(12000);expect(body.provider).toEqual({require_parameters:true,allow_fallbacks:false});
      expect(body.messages[1].content.filter(p=>p.type==='image_url')).toHaveLength(2);expect(body.messages).toEqual(source.readerMessages({bytes:bundle.bytes,mimeType:'image/png',images:bundle.images,prompt:v4.PROMPT,targeted:true,magnifiedFocus:true}));}
    expect(r.reconciliation.patchApplied).toBe(false);expect(r.sourceMutation).toBe(false);expect(r.magnification.scaleFactor).toBe(3);
  }finally{spy.mockRestore();}
});
test.each(['failure','model','schema'])('future %s attempts are never retried or substituted and do not retain secrets',async kind=>{
  const p=prepared(),fetchImpl=jest.fn(async(_u,o)=>{if(kind==='failure')throw Error('secret token and private text');return response({model:kind==='model'?'other/model':JSON.parse(o.body).model,choices:[{finish_reason:'stop',message:{content:'{}'}}]});});
  const r=await smoke.runPair(p.value,{env,manifest:p.manifest,fetchImpl,allowLive:true});expect(fetchImpl).toHaveBeenCalledTimes(2);expect(r.providerCalls).toBe(2);expect(r.pair.targetedPairState).toBe('TARGETED_OCR_UNCERTAIN');expect(JSON.stringify(r)).not.toContain('secret token and private text');
});
test('attempt cap refuses extra internal transport attempts even if a reader unexpectedly calls twice',async()=>{
  const p=prepared(),fetchImpl=fetchOK(),original=source.reader,spy=jest.spyOn(source,'reader').mockImplementation(async args=>{await original(args);return original(args);});
  try{const r=await smoke.runPair(p.value,{env,manifest:p.manifest,fetchImpl,allowLive:true});expect(fetchImpl).toHaveBeenCalledTimes(2);expect(r.providerCalls).toBe(2);expect(r.readers.every(r=>r.safeFailureCode==='SMOKE_CALL_LIMIT')).toBe(true);}
  finally{spy.mockRestore();}
});
test('normal V4 logs contain only bounded diagnostics, never source text or image data',async()=>{
  const logger=require('../src/utils/logger'),spy=jest.spyOn(logger,'info').mockImplementation(()=>{}),raw=require('../src/services/hybridSource/shadow').rawEvidence;
  try{await source.readPage({bytes,mimeType:'image/png',identity:{submissionId:'s',runId:'j',fileId:'f',pageNumber:1},google:async()=>({pages:[{pageNumber:1}],words:[{bbox:{x:0,y:0,w:1,h:1}}],[raw]:[g]}),reader:async({model,targeted})=>({value:reading(model===env.OCR_FABLE_MODEL&&!targeted?b.activeTranscript:a.activeTranscript),returnedModel:model}),persistEvidence:async()=>{},env});
    const logs=JSON.stringify(spy.mock.calls);expect(logs).not.toContain(a.activeTranscript);expect(logs).not.toContain('base64');expect(logs).toContain('source_fidelity_targeted_v4');
  }finally{spy.mockRestore();}
});
test('future smoke refuses altered original focus, magnified pixels or source identity before transport',async()=>{
  for(const change of [p=>p.value.crop.images[1].bytes=Buffer.from('substituted'),p=>p.value.crop.audit.magnification.originalFocusSha256='f'.repeat(64),p=>p.value.evidence.ocrJobId='foreign']){
    const p=prepared(),fetchImpl=fetchOK();change(p);await expect(smoke.runPair(p.value,{env,manifest:p.manifest,fetchImpl,allowLive:true})).rejects.toThrow(/^SMOKE_/);expect(fetchImpl).not.toHaveBeenCalled();}
});
test.each(['production','staging',undefined])('future smoke refuses %s before transport',async nodeEnv=>{
  const p=prepared(),fetchImpl=fetchOK();await expect(smoke.runPair(p.value,{env:{...env,NODE_ENV:nodeEnv},manifest:p.manifest,fetchImpl,allowLive:true})).rejects.toThrow('SMOKE_LOCAL_ONLY');expect(fetchImpl).not.toHaveBeenCalled();
});
test('future evaluation compares V2/V3/V4 by exact model and retains stop policy despite lexical improvement',()=>{
  const expected='a b c',reader=(text,cost=.1)=>({requestedModel:'m',schemaValid:true,activeTranscript:text,uncertainSpans:[],reportedCost:cost});
  const now={readers:[reader('a b c'),{...reader('a b c'),requestedModel:'n'}],pair:{activeTextExactEqual:true,segmentSignatureEqual:true,hasUncertainty:false},reconciliation:{patchEligible:false}};
  const older={readers:[reader('a z c'),{...reader('a z c'),requestedModel:'n'}],reconciliation:{patchEligible:false}},r=evaluation.evaluate(now,expected,{v2:older,v3:older});
  expect(r.comparisons[0].v3.characterDistance).toBe(1);expect(r.comparisons[0].v4.exactRow).toBe(true);expect(r.experimentPolicy.stopFurtherVisualExperiments).toBe(true);expect(r.v4OutperformedV3.safeAutomaticResolution).toBe(false);expect(r.cost.v4IncrementalExperimentCost).toBe(.2);
  expect(evaluation.totalCost([{reportedCost:null},{reportedCost:.1}])).toBeNull();
  now.reconciliation.patchEligible=true;expect(evaluation.evaluate(now,expected,{v3:older}).experimentPolicy.stopFurtherVisualExperiments).toBe(false);
});
test('diagnostic flags are pinned and no write/provider pipeline entrypoints are present',()=>{
  expect(smoke.args(['--submission',smoke.PIN.submissionId,'--slot','8']).allowLive).toBe(false);
  for(const args of [[],['--submission',smoke.PIN.submissionId,'--slot','9'],['--submission',smoke.PIN.submissionId,'--slot','8','--allow-live','--allow-live']])expect(()=>smoke.args(args)).toThrow();
  const code=fs.readFileSync(path.join(__dirname,'../scripts/targeted-v4-live-smoke.cjs'),'utf8');for(const banned of ['readPage(','updateOne(','findOneAndUpdate(','persistEvidence(','google()'])expect(code).not.toContain(banned);
});
