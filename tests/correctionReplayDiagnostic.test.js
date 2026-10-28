'use strict';
const fs=require('fs'),path=require('path'),cp=require('child_process');
const replay=require('../../tmp/correction-replay-source.cjs');
const fidelity=require('../src/utils/sourceFidelity');
const root=path.resolve(__dirname,'../..');
function docFor(context){const version=require('../src/services/gptVisionExact/contract').VERSION;
 return {_id:context.pin.id,sourceFidelityMode:'gpt_vision_exact',sourceFidelityStatus:'GPT_SOURCE_ACCEPTED',sourceTranscriptExact:context.input.transcript,sourceTranscriptSha256:context.pin.sourceSha256,
  files:context.input.pageManifest.map(p=>p.fileId),ocrPages:context.input.pageManifest.map(p=>({...p,sourceFidelityMode:'gpt_vision_exact',sourceFidelityStatus:'GPT_SOURCE_ACCEPTED',sourceFidelityVersion:version,sourceTextExact:p.text,sourceTextSha256:fidelity.sha(p.text)}))};
}
test('accepted source bytes, source hash, teacher policy and word/page identity are reused unchanged',()=>{
 const c=replay.mock();expect(c.input.transcriptHash).toBe(fidelity.sha(c.input.transcript));
 expect(c.input.policy.strictness).toBe('strict');expect(c.input.disableCategoryAudit).toBe(true);
 expect(c.input.spans.length).toBeGreaterThan(0);
 for(const s of c.input.spans){expect(c.input.transcript.slice(s.start,s.end)).toBe(s.word.text);expect(s.fileId).toBe('synthetic-file');expect(s.page).toBe(1);expect(s.wordId).toBeTruthy();}
});
test.each(['rejected','changed','unmapped'])('replay refuses %s source instead of running OCR or weakening grounding',mode=>{
 const c=replay.mock(),doc=docFor(c);
 if(mode==='rejected')doc.sourceFidelityStatus='PROVIDER_FAILED';
 if(mode==='changed')doc.sourceTranscriptExact+='changed';
 if(mode==='unmapped')for(const w of doc.ocrPages[0].words)w.sourceStart=-1;
 expect(()=>replay.build(doc,{assignment:{},teacher:{},legend:c.input.legend},c.pin)).toThrow();
});
test('live authorization gate rejects absent permission before any database or provider operation',()=>{
 expect(()=>replay.authorize(true,[])).toThrow('SEPARATE_ONE_CALL_AUTHORIZATION_REQUIRED');
 expect(()=>replay.authorize(false,[])).not.toThrow();
 const runner=fs.readFileSync(path.join(root,'tmp/gpt41-symbol-map-one-shot.cjs'),'utf8');
 expect(runner.indexOf('replay.authorize(')).toBeLessThan(runner.indexOf('await replay.load('));
});
test('scoring, OCR, comments, lifecycle and credit entry points are disabled',()=>{
 const script="const r=require('./tmp/correction-replay-source.cjs');r.blockFeatures();let blocked=0;for(const n of ['ocrPipeline','visionOcr','semanticRubricAssessment','canonicalEvaluation','canonicalCorrectionsPipeline','teacherComments','assessmentCompletion','assessmentCreditRouter','credit'])try{require('./backend/src/services/'+n+'.service');}catch(e){if(e.message==='DISABLED_REPLAY_FEATURE')blocked++;}if(blocked!==9)process.exitCode=1;console.log(JSON.stringify({blocked}));";
 const result=cp.spawnSync(process.execPath,['--require','./backend/tests/offlineProviderGuard.cjs','-e',script],{cwd:root,encoding:'utf8',timeout:15000});
 expect(result.status).toBe(0);expect(JSON.parse(result.stdout)).toEqual({blocked:9});
});
test('source read path fails outside development before reading a record',async()=>{
 const findOne=jest.fn();await expect(replay.load({NODE_ENV:'production'},{findOne})).rejects.toThrow('DEVELOPMENT_ONLY');expect(findOne).not.toHaveBeenCalled();
});
test('human-review examples never become prompt hints or automatic false-positive/overlap judgments',()=>{
 const c=replay.mock(),start=c.input.transcript.indexOf('mispell.');
 const a={symbol:'SP',category:'MECHANICS',quotedText:'mispell.',startChar:start,endChar:start+8,fileId:'synthetic-file',page:1,wordIds:['synthetic-word-5']};
 const b={...a,symbol:'P'},raw=replay.comparison(c.input,[],[a,b]);
 expect(raw.confirmedFalsePositiveCount).toBeNull();expect(raw.overlapReview[0].review).toBe('OVERLAP_REQUIRES_HUMAN_REVIEW');
 const reviewed=replay.comparison(c.input,[],[a,b],{sourceSha256:c.input.transcriptHash,falsePositiveIndices:[1],legitimateOverlapPairs:[[0,1]]});
 expect(reviewed.confirmedFalsePositiveCount).toBe(1);expect(reviewed.overlapReview[0].review).toBe('HUMAN_CONFIRMED_LEGITIMATE_INDEPENDENT');
 expect(()=>replay.comparison(c.input,[],[a],{sourceSha256:'wrong',falsePositiveIndices:[0]})).toThrow('HUMAN_REVIEW_SOURCE_MISMATCH');
 expect(JSON.stringify(raw)).not.toContain(c.input.transcript);expect(JSON.stringify(raw)).not.toContain('quotedText');
});
test('real one-shot mock uses one fetch with current schema, no disabled features and no consumed-marker write',()=>{
 const marker=path.join(replay.directory,'one-call-consumed.json'),before=fs.existsSync(marker)?fs.readFileSync(marker,'utf8'):null;
 const result=cp.spawnSync(process.execPath,['--require','./backend/tests/offlineProviderGuard.cjs','tmp/gpt41-symbol-map-one-shot.cjs','--mock-replay'],{cwd:root,encoding:'utf8',timeout:15000});
 expect(result.status).toBe(0);expect(JSON.parse(result.stdout)).toMatchObject({mockPassed:true,hardGuardPassed:true,liveProviderCallCount:0});
 expect(fs.existsSync(marker)?fs.readFileSync(marker,'utf8'):null).toBe(before);
 expect(require('../src/services/correctionAdmission.service').shared.snapshot()).toMatchObject({limit:4,queueLimit:64,active:0,queued:0});
 const runner=fs.readFileSync(path.join(root,'tmp/gpt41-symbol-map-one-shot.cjs'),'utf8');
 expect(runner).toContain('attemptTimeoutMs:90000,totalBudgetMs:95000');expect(runner).toContain('primaryRetries:0,fallbackRetries:0,retriesPerModel:0,maxRetries:0');
});
