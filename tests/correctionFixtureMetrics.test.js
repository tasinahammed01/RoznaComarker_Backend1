'use strict';
const {evaluateCorrectionFixtures:evaluate}=require('../src/services/hybridSource/correctionFixtureMetrics');
const {digest}=require('../src/services/hybridSource/reconcile');
function fixture(id='synthetic'){return {id,transcript:'a',gold:{review:{humanReviewed:true,exhaustive:true},sourceTranscriptSha256:digest('a'),corrections:[{id:'A',quotedText:'a',start:0,end:1,symbol:'CAP',category:'MECHANICS',suggestedText:'A'}]},analysis:{transcriptHash:digest('a'),records:[{status:'DIAGNOSTIC_ONLY',providerRecord:{exactQuote:'a',code:'CAP',suggestion:'A'},sourceLocator:{valid:true,start:0,end:1},category:'MECHANICS'}]}};}
test('same metric definitions aggregate fixtures and retain diagnostics in denominator',()=>{const a=fixture('one'),b=fixture('two');b.analysis.records.push({...b.analysis.records[0],sourceLocator:{valid:false}});expect(evaluate([a,b]).micro).toMatchObject({rawCount:3,goldCount:2,exactTP:2,exactFP:1,exactFN:0,precision:2/3,recall:1});});
test('duplicate exact records count once',()=>{const f=fixture();f.analysis.records.push(f.analysis.records[0]);expect(evaluate([f]).micro).toMatchObject({exactTP:1,exactFP:1});});
test.each(['humanReviewed','exhaustive'])('reject unreviewed/incomplete %s',k=>{const f=fixture();f.gold.review[k]=false;expect(()=>evaluate([f])).toThrow('EXHAUSTIVE_CURRENT_HUMAN_GOLD_REQUIRED');});
test('reject stale gold transcript',()=>{const f=fixture();f.transcript='changed';expect(()=>evaluate([f])).toThrow();});
