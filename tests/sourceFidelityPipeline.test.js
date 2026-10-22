'use strict';
jest.mock('fs',()=>({existsSync:jest.fn(()=>true)}));
jest.mock('../src/models/File',()=>({findById:jest.fn(async id=>({_id:id,path:`${id}.jpg`}))}));
jest.mock('../src/services/visionOcr.service',()=>({extractOcrFromImageFile:jest.fn()}));
jest.mock('../src/services/canonicalCorrectionsPipeline.service',()=>({generateAndPersist:jest.fn(async()=>{})}));
const vision=require('../src/services/visionOcr.service');
const corrections=require('../src/services/canonicalCorrectionsPipeline.service');
const {runOcrAndPersistForFiles}=require('../src/services/ocrPipeline.service');
const sf=require('../src/utils/sourceFidelity');
const {buildCanonicalSubmissionTranscript}=require('../src/utils/ocrTranscriptNormalizer');
const result=(text,status='MODEL_AGREED')=>({fullText:'Google must not replace source',words:[],pages:[{pageNumber:1,words:[],
  sourceTextExact:text,sourceTextSha256:sf.sha(text),sourceFidelityMode:'astra_verified',sourceFidelityStatus:status,
  sourceInputSha256:sf.sha(text+'pixels'),sourceSha256:sf.sha('original'),sourceFidelityVersion:sf.VERSION}]});
const doc=()=>({_id:'submission',files:['a','b'],ocrJobId:'job',assignment:null,
  constructor:{exists:jest.fn(async()=>true),updateOne:jest.fn(async()=>({matchedCount:1}))},
  toObject(){const {constructor,toObject,...rest}=this;return rest;}});
beforeEach(()=>{process.env.OCR_SOURCE_MODE='astra_verified';jest.clearAllMocks();});
afterEach(()=>delete process.env.OCR_SOURCE_MODE);
test('GPT automatic exact source reaches existing correction pipeline with active-only aliases and stable nullable geometry',async()=>{
  process.env.OCR_SOURCE_MODE='gpt_vision_exact';const d=doc();d.files=['a'];
  const out=result('Society always expect\npowerfull Say , wrong wrong','GPT_SOURCE_ACCEPTED');
  Object.assign(out.pages[0],{sourceFidelityMode:'gpt_vision_exact',sourceFidelityVersion:'gpt-vision-exact-v1'});
  const text=out.pages[0].sourceTextExact;out.pages[0].words=[...text.matchAll(/\S+/gu)].map((m,i)=>({id:`word_a_1_gpt_${i+1}`,text:m[0],sourceStart:m.index,sourceEnd:m.index+m[0].length,bbox:null}));
  vision.extractOcrFromImageFile.mockResolvedValue(out);
  corrections.generateAndPersist.mockImplementationOnce(async submission=>{
    expect(sf.eligible(submission)).toBe(true);expect(buildCanonicalSubmissionTranscript(submission).text).toBe(text);expect(submission.combinedOcrText).toBe(text);
    expect(submission.ocrPages[0].words.map(w=>w.id)).toEqual(out.pages[0].words.map(w=>w.id));
  });
  await runOcrAndPersistForFiles({fileIds:['a'],targetDoc:d,jobId:'job'});expect(d.ocrStatus).toBe('completed');expect(corrections.generateAndPersist).toHaveBeenCalledTimes(1);
});
test.each(['OCR_GPT_SOURCE_UNCERTAIN','OCR_GPT_PROVIDER_PAYMENT_REQUIRED','OCR_GPT_SOURCE_SCHEMA','OCR_GPT_SOURCE_ATTEMPT_RESERVED'])('GPT %s terminates without corrections/review/fallback',async code=>{
  process.env.OCR_SOURCE_MODE='gpt_vision_exact';const d=doc();vision.extractOcrFromImageFile.mockRejectedValue(Object.assign(Error('unsafe provider'),{code,retryable:false}));
  await runOcrAndPersistForFiles({fileIds:['a','b'],targetDoc:d,jobId:'job'});expect(d.ocrStatus).toBe('failed');expect(d.ocrErrorCode).toBe(code);
  expect(d.evaluationStatus).toBe('blocked');expect(d.analysisNextRetryAt).toBeNull();expect(d.sourceHumanReviewSummary).toBeUndefined();expect(corrections.generateAndPersist).not.toHaveBeenCalled();
  expect(require('../src/services/canonicalResultState.service').buildCanonicalResultState({submission:d})).toMatchObject({ocrErrorCode:code,terminal:true,manualRetryAllowed:false});
});
test('all pages establish exact source before correction, preserving file order and page separator',async()=>{
  const d=doc();vision.extractOcrFromImageFile.mockImplementation(async p=>p.endsWith('a.jpg')?result('  sence \nSocial  '):result('Shape\n'));
  corrections.generateAndPersist.mockImplementationOnce(async submission=>{
    expect(sf.eligible(submission)).toBe(true);expect(d.constructor.updateOne).toHaveBeenCalled();
    expect(buildCanonicalSubmissionTranscript(submission).text).toBe('  sence \nSocial  '+sf.PAGE_SEPARATOR+'Shape\n');
  });
  await runOcrAndPersistForFiles({fileIds:['a','b'],targetDoc:d,jobId:'job'});
  expect(d.sourceTranscriptExact).toBe('  sence \nSocial  '+sf.PAGE_SEPARATOR+'Shape\n');
  expect(d.ocrPages.map(p=>p.fileId)).toEqual(['a','b']);expect(corrections.generateAndPersist).toHaveBeenCalledTimes(1);
});
test.each(['OCR_UNCERTAIN','PROVIDER_FAILED','SOURCE_UNREADABLE'])('one %s page blocks all correction/scoring and terminates',async status=>{
  const d=doc();vision.extractOcrFromImageFile.mockImplementation(async p=>result('sence',p.endsWith('b.jpg')?status:'MODEL_AGREED'));
  await runOcrAndPersistForFiles({fileIds:['a','b'],targetDoc:d,jobId:'job'});
  expect(corrections.generateAndPersist).not.toHaveBeenCalled();expect(d.evaluationStatus).toBe('blocked');
  expect(d.analysisNextRetryAt).toBeNull();expect(d.ocrStatus).toBe('failed');expect(d.sourceTranscriptExact).toContain('sence');
});
test('stale job cannot persist late reader result',async()=>{
  const d=doc();let current=true;d.constructor.exists.mockImplementation(async()=>current);
  vision.extractOcrFromImageFile.mockImplementation(async()=>{current=false;return result('late');});
  expect(await runOcrAndPersistForFiles({fileIds:['a','b'],targetDoc:d,jobId:'job'})).toEqual({ocrStatus:'superseded'});
  expect(d.constructor.updateOne).not.toHaveBeenCalled();expect(corrections.generateAndPersist).not.toHaveBeenCalled();
});
test('canonical exact path withholds ambiguous repeated/case-different geometry without losing source',()=>{
  const d={files:['a'],ocrPages:[{fileId:'a',fileOrder:0,pageIndex:0,pageNumber:1,...result('sence sence Shape').pages[0],
    words:[{text:'sence',bbox:{}},{text:'shape',bbox:{}}]}]};Object.assign(d,sf.aggregate(d));
  const c=buildCanonicalSubmissionTranscript(d);expect(c.text).toBe('sence sence Shape');expect(c.wordSpans).toEqual([]);
  expect(sf.payload(d).assessmentAllowed).toBe(true);
});
test('same source mutation rejected, new identity allowed; source hash is exact',()=>{
  const a={sourceFidelityInputIdentity:'same',sourceTranscriptExact:'sence',sourceTranscriptSha256:sf.sha('sence'),ocrPages:[]};
  expect(()=>sf.assertUnchanged(a,{...a,sourceTranscriptExact:'sense'})).toThrow('IDENTITY_MUTATION');
  expect(()=>sf.assertUnchanged(a,{...a,sourceFidelityInputIdentity:'new',sourceTranscriptExact:'sense'})).not.toThrow();
  expect(sf.sha('sence')).not.toBe(sf.sha('sence '));
});
test('targeted V2 shares a single call budget across files and persists unresolved gating metadata',async()=>{
  const before=process.env.OCR_SOURCE_VERIFICATION_MODE,node=process.env.NODE_ENV;
  process.env.OCR_SOURCE_VERIFICATION_MODE='targeted_v2';process.env.NODE_ENV='test';
  try{
    const d=doc();vision.extractOcrFromImageFile.mockImplementation(async()=>{
      const out=result('sence');Object.assign(out.pages[0],{sourceFidelityVersion:'targeted-source-v2',sourceVerificationStage:'OCR_UNCERTAIN',
        sourceVerificationSummary:{candidateRegionCount:2,unresolvedTargetedCount:1,candidateReasons:['GEOMETRY_COVERAGE_GAP']}});return out;
    });
    await runOcrAndPersistForFiles({fileIds:['a','b'],targetDoc:d,jobId:'job'});
    const options=vision.extractOcrFromImageFile.mock.calls.map(c=>c[1]);expect(options[0].targetedBudget).toBe(options[1].targetedBudget);
    expect(options[0].targetedBudget.reserve(12)).toBe(true);expect(options[1].targetedBudget.reserve(2)).toBe(false);
    expect(d.sourceFidelityStatus).toBe('OCR_UNCERTAIN');expect(d.ocrPages[0].sourceVerificationSummary.unresolvedTargetedCount).toBe(1);
    expect(corrections.generateAndPersist).not.toHaveBeenCalled();expect(d.assessmentStatus).toBe('failed');
  }finally{if(before===undefined)delete process.env.OCR_SOURCE_VERIFICATION_MODE;else process.env.OCR_SOURCE_VERIFICATION_MODE=before;
    if(node===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=node;}
});
