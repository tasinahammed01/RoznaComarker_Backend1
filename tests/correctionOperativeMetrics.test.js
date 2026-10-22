'use strict';
const metric=require('../src/services/correctionOperativeMetrics.service');
const strict=require('../src/services/hybridSource/correctionFixtureMetrics');
const {digest}=require('../src/services/hybridSource/reconcile');
const layer=require('../src/services/correctionOperativeAuthority.service');
const v15=require('../src/services/correctionUniqueSource.service');
const {REQUIRED}=require('../src/services/correctionLegendResolver.service');
function fixture(id='test'){
 const transcript='depend of maps',input={transcript,transcriptHash:digest(transcript),identity:{},assignment:{}};
 const reviews=Object.fromEntries(Object.entries(REQUIRED).map(([k,c])=>[k,{reviewed:true,reviewedSymbols:c,noFindingReason:'Synthetic.'}]));
 const analysis=layer.analyzeSaved(input,JSON.stringify({reviews,corrections:[{sourceLineIds:[v15.sourceDocument(transcript).lines[0].id],exactQuote:transcript,code:'PREP',suggestion:'depend on maps',confidence:1,rationale:'Synthetic.',criterionId:null}]}));
 return {id,transcript,analysis,gold:{review:{humanReviewed:true,exhaustive:true},sourceTranscriptSha256:digest(transcript),corrections:[{id:'X',quotedText:'depend of',suggestedText:'depend on',start:0,end:9,symbol:'PREP',category:'GRAMMAR'}]}};
}
test('separate metrics normalize human phrase gold by same diff, retain strict 0',()=>{const f=fixture();expect(metric.evaluate([f]).micro).toMatchObject({exactTP:1,exactFP:0,exactFN:0});expect(strict.evaluateCorrectionFixtures([{...f,analysis:f.analysis.originalV15Analysis}]).micro.exactTP).toBe(0);});
test('duplicates remain FP and multi-fixture metrics aggregate',()=>{const a=fixture('one'),b=fixture('two');b.analysis={...b.analysis,records:[...b.analysis.records,...b.analysis.records]};expect(metric.evaluate([a,b]).micro).toMatchObject({exactTP:2,exactFP:1,exactFN:0,precision:2/3});});
test('empty denominators are null',()=>expect(metric.evaluate([]).micro).toMatchObject({precision:null,recall:null}));
test('unreviewed human gold rejected',()=>{const f=fixture();f.gold.review.humanReviewed=false;expect(()=>metric.evaluate([f])).toThrow('EXHAUSTIVE_CURRENT_HUMAN_GOLD_REQUIRED');});
test('stale source rejected',()=>{const f=fixture();f.transcript+='!';expect(()=>metric.evaluate([f])).toThrow();});
