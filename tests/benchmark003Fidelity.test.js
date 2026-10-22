'use strict';
const fs=require('fs'),path=require('path');
const e=require('../scripts/lib/benchmark003Fidelity.cjs');
const loader=require('../scripts/ocr-benchmark-003-astra-fidelity.cjs');
const fixture=require('./fixtures/source-fidelity/benchmark-003-human-gold.cjs');
const manifest=require('../scripts/lib/ocrBenchmark003Manifest.cjs');
const gold=text=>({benchmarkId:'003',inputSha256:manifest.normalizedSha256,status:'HUMAN_GOLD',humanReviewed:true,productionAuthority:false,text,textSha256:e.sha(text),deletedRegionAnnotations:[],unresolvedHumanRegions:[]});
const reader=text=>({activeTranscript:text,segments:[],uncertainSpans:[]});
test('pending fixture cannot admit model evidence',async()=>{
  const readArtifact=jest.fn(),freeze=jest.fn(),readImage=jest.fn();
  await expect(loader.run({...fixture,status:"HUMAN_REVIEW_REQUIRED",humanReviewed:false},{readArtifact,freeze,readImage})).rejects.toThrow('HUMAN_GOLD_INCOMPLETE');
  expect(readArtifact).not.toHaveBeenCalled();expect(freeze).not.toHaveBeenCalled();expect(readImage).not.toHaveBeenCalled();
});
test('draft is reproducible and cannot masquerade as gold',()=>{
  expect(e.requireHumanGold(fixture)).toBe(fixture);expect(fixture.text.split('\n')).toHaveLength(16);const draft=fixture.previousDraft;
  expect(e.sha(JSON.stringify({draftLines:draft.draftLines,deletedRegionAnnotations:draft.deletedRegionAnnotations,unresolvedHumanRegions:draft.unresolvedHumanRegions}))).toBe(draft.draftSha256);
});
test('production source never imports this fixture or offline evaluator',()=>{
  function scan(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,entry.name);if(entry.isDirectory())scan(p);else if(/\.[cm]?js$/.test(p))expect(fs.readFileSync(p,'utf8')).not.toMatch(/benchmark-003-human-gold|benchmark003Fidelity|ocr-benchmark-003-astra-fidelity/);}}
  scan(path.resolve(__dirname,'../src'));
});
test('hash validation rejects modified text',()=>{expect(()=>e.requireHumanGold({...gold('a'),text:'b'})).toThrow('HUMAN_GOLD_HASH_INVALID');});
test.each([['A','a','CASE_CHANGE'],['word.','word!','PUNCTUATION_CHANGE'],['a b','a  b','OTHER'],['a\nb','a b','LINE_BREAK_CHANGE']])('literal classification %p / %p',(a,b,category)=>{
  const m=e.literalMetrics(a,b);expect(m.exactTranscriptEqual).toBe(false);expect(m.characterEditDistance).toBe(1);expect(m.mismatches[0].category).toBe(category);
});
test('no Unicode, whitespace, or spelling normalization',()=>{
  expect(e.literalMetrics('relize','realize').exactTranscriptEqual).toBe(false);
  expect(e.literalMetrics('\u00e9','e\u0301').characterEditDistance).toBe(2);
  expect(e.literalMetrics('x\r\n','x\n').characterEditDistance).toBe(1);
  expect(e.literalMetrics('\ud83d\ude00','\ud83d\ude00').humanCharacterCount).toBe(1);
});
test('word insertion and deletion counted literally',()=>{
  expect(e.literalMetrics('one two three','one three').wordDeletions).toBe(1);
  expect(e.literalMetrics('one three','one two three').wordInsertions).toBe(1);
  expect(e.literalMetrics('one two','one too').wordSubstitutions).toBe(1);
  expect(e.literalMetrics('a\nb','a\nb').exactLineMatches).toBe(2);
});
test('revision audit excludes unknown geometry and recognizes proven replacement',()=>{
  const g=gold('new');g.deletedRegionAnnotations=[{id:'D',reviewStatus:'HUMAN_CONFIRMED',transcription:'old',sourceStart:0,sourceEnd:3}];
  expect(e.deletionAudit(g,reader('new'))[0].classification).toBe('CORRECTLY_EXCLUDED');
  expect(e.deletionAudit(g,reader('old'))[0].classification).toBe('DELETED_TEXT_LEAKED');
  delete g.deletedRegionAnnotations[0].sourceStart;
  expect(e.deletionAudit(g,reader('new'))[0].classification).toBe('ROLE_UNCERTAIN');
});
test.each(['CORRECTLY_UNCERTAIN','UNNECESSARILY_UNCERTAIN','UNCERTAIN_AND_WRONG_CONTEXT','HUMAN_GOLD_UNRESOLVED'])('explicit uncertainty adjudication %s',classification=>{
  const g=gold('text');g.uncertaintyAdjudications=[{id:'SPAN_0',classification}];
  expect(e.uncertaintyAudit(g,{...reader('text'),uncertainSpans:[{visibleContext:'text'}]})[0].classification).toBe(classification);
});
test('context alone is not a proven uncertainty target; silent count withheld',()=>{
  const result=e.evaluate(gold('text'),{...reader('test'),uncertainSpans:[{visibleContext:'text'}]});
  expect(result.uncertaintyAudit[0].status).toBe('MAPPING_WITHHELD');expect(result.silentErrorCount).toBeNull();
  expect(e.evaluate(gold('text'),reader('test')).silentErrorCount).toBe(1);
});
test('pinned artifact hash rejected before JSON parsing',()=>{expect(()=>loader.parseArtifact(Buffer.from('not JSON'))).toThrow('ASTRA_ARTIFACT_HASH_INVALID');});
test('freeze completes before artifact read; admission test uses synthetic evidence only',async()=>{
  const events=[];const g=gold('x');
  await expect(loader.run(g,{readImage:async()=>({originalSha256:manifest.originalSha256,normalizedSha256:manifest.normalizedSha256,width:1200,height:1600}),freeze:async r=>{expect(r.textSha256).toBe(e.sha('x'));events.push('freeze');},readArtifact:async()=>{events.push('read');return Buffer.from('synthetic');}})).rejects.toThrow('ASTRA_ARTIFACT_HASH_INVALID');
  expect(events).toEqual(['freeze','read']);
});
test('evaluator has no provider or network entry points',()=>{
  for(const p of ['scripts/lib/benchmark003Fidelity.cjs','scripts/ocr-benchmark-003-astra-fidelity.cjs'])expect(fs.readFileSync(path.resolve(__dirname,'..',p),'utf8')).not.toMatch(/require\(['"](?:https?|net|axios)|fetch\s*\(|sourceFidelityOcr|runResume|\.reader\s*\(/);
});
test('confirmed gold preserves revised roles and exact source mappings',()=>{
  expect(fixture.textSha256).toBe('78272c7d642e4fc8a598cd9a85ecbaf5444738d39f2fb89acba0ff696ae6063f');
  expect(fixture.deletedRegionAnnotations.find(r=>r.id==='D3').transcription).toBeNull();
  for(const r of fixture.deletedRegionAnnotations){expect(r.reviewStatus).toBe('HUMAN_CONFIRMED');expect(r.sourceStart).toBeGreaterThanOrEqual(0);}
  expect(fixture.text.split('\n').at(-1)).toBe('intentional intentions may decive people and think wrong');
});
test('existing frozen Astra evidence has reproducible literal metrics and adjudicated uncertainty',()=>{
  const audit=require('./fixtures/source-fidelity/benchmark-003-fidelity-audit.cjs');
  const astra=loader.parseArtifact(fs.readFileSync(path.resolve(__dirname,'../..',loader.PIN.artifact)));
  const r=e.evaluate(fixture,astra,audit);
  expect(r.characterEditDistance).toBe(15);expect(r.humanCharacterCount).toBe(844);expect(r.astraCharacterCount).toBe(831);
  expect(r.exactLineMatches).toBe(12);expect(r.lineMismatchCount).toBe(4);
  expect(r.totalHumanWords).toBe(142);expect(r.exactWordMatches).toBe(138);
  expect([r.wordSubstitutions,r.wordInsertions,r.wordDeletions]).toEqual([3,0,1]);
  expect(r.silentErrorCount).toBe(2);expect(r.deletionRoleErrorCount).toBe(1);
  expect([r.astraUncertainSpanCount,r.correctlyUncertainCount,r.unnecessarilyUncertainCount]).toEqual([3,1,2]);
  expect(r.uncertaintyAudit.filter(u=>u.kind==='SEGMENT')).toHaveLength(3);
});
