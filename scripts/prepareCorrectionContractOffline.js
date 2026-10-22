'use strict';
// Offline artifact preparation only. Never connect a completion adapter.
const fs=require('fs'),path=require('path'),assert=require('assert'),crypto=require('crypto');
const next=require('../src/services/correctionUniqueSource.service');
const v14=require('../src/services/correctionSourceLocator.service');
const {fallbackLegend}=require('../src/services/correctionLegendResolver.service');
const {digest}=require('../src/services/hybridSource/reconcile');
const {validateCorrectionGold}=require('../src/services/hybridSource/correctionGold');
const {evaluateCorrectionFixtures}=require('../src/services/hybridSource/correctionFixtureMetrics');
function main(){
 global.fetch=()=>{throw Error('OFFLINE_NETWORK_FORBIDDEN');};
 const fixtureRoot=path.resolve(__dirname,'../tests/fixtures/hybrid-source/private'),root=path.join(fixtureRoot,'001-louise-mallard'),out=path.join(root,'correction-hardening-phase3');
 fs.mkdirSync(out); // exclusive new offline artifact directory, no old reservation reuse
 const load=f=>JSON.parse(fs.readFileSync(path.join(root,f),'utf8')),write=(f,v)=>fs.writeFileSync(path.join(out,f),JSON.stringify(v,null,2)+'\n');
 const human=load('human-gold.json'),gold=load('human-corrections.json');
 const words=load('google-native.json').rawGoogle[0].words.map((w,i)=>({...w,id:`word_${gold.identity.fileId}_1_${i+1}`}));
 validateCorrectionGold(gold,human.transcript,gold.identity,{words,bindings:load('reconciliation-phase2/human-control.json').bindings,attestations:load('reconciliation-phase2/offline-gold-attestations.json')});
 const input={transcript:human.transcript,transcriptHash:digest(human.transcript),identity:gold.identity,legend:fallbackLegend(),assignment:{}},request=next.buildRequest(input);
 write('request-preview.json',{messages:request.messages,responseSchema:request.responseSchema,schemaName:request.schemaName});
 const capability=load('correction-hardening-phase2/locator-capability.json').map(c=>{const sourceEvidence={sourceLineIds:c.sourceEvidence.sourceLineIds,exactQuote:c.sourceEvidence.exactQuote},derived=next.locate(request.document,sourceEvidence,human.transcript);assert(derived.valid);assert.equal(derived.start,c.derived.start);assert.equal(derived.end,c.derived.end);assert.equal(derived.occurrence,c.derived.occurrence);return {goldId:c.goldId,sourceEvidence,derived,markerState:c.markerState,publishable:false};});
 assert.equal(capability.length,9);
 const representations=capability.map(c=>{const g=gold.corrections.find(g=>g.id===c.goldId);return {sourceLineIds:c.sourceEvidence.sourceLineIds,exactQuote:g.quotedText,code:g.symbol,suggestion:g.suggestedText,confidence:1,rationale:'Separate offline human-gold representability assertion.',criterionId:null};});
 const represented=next.normalize(input,{corrections:representations});assert.equal(represented.candidates.length,9);
 capability.forEach((c,i)=>{assert.equal(represented.records[i].category,gold.corrections.find(g=>g.id===c.goldId).category);c.suggestionExpressible=true;c.normalizedCandidate=true;});
 write('locator-capability.json',capability);
 const old=load('source-located-mini-v1-20261019/parsed-model.json'),oldAnalysis=v14.parse(JSON.stringify(old),input);
 // Deliberately feed UNCHANGED old envelope to new parser: never silently upgrade it.
 let newEnvelopeRejection;try{next.parse(JSON.stringify(old),input);throw Error('OLD_OUTPUT_ACCEPTED');}catch(e){assert.notEqual(e.message,'OLD_OUTPUT_ACCEPTED');newEnvelopeRejection=e.message;}
 write('old-output-diagnostics.json',{newEnvelopeRejection,records:oldAnalysis.records.map(r=>({index:r.index,providerRecord:r.providerRecord,oldReasons:r.reasons,oldStatus:r.status,oldLocator:r.sourceLocator})),newAccuracyClaim:false,explanation:'Old records retain provider category/symbol/nested evidence/anchor and fail v15 envelope. A unique null-anchor future record could locate its quote, but the old record is not repaired. D CAP/false RO remain conflicting intent; E/F/H no-op remain invalid; B/C/G were already exact old candidates.',providerCalls:0});
 const discovered=[];function scan(dir){for(const ent of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,ent.name);if(ent.isDirectory())scan(f);else if(ent.name==='human-corrections.json'){const g=JSON.parse(fs.readFileSync(f));discovered.push({path:path.relative(fixtureRoot,f),humanReviewed:g.review?.humanReviewed===true,exhaustive:g.review?.exhaustive===true,fixture:g.fixture});}}}scan(fixtureRoot);
 write('fixture-manifest.json',{fixtures:discovered,exhaustiveHumanReviewedCount:discovered.filter(g=>g.humanReviewed&&g.exhaustive).length,syntheticTestsAreNotHumanGold:true,metricDefinitions:'correctionFixtureMetrics.evaluateCorrectionFixtures: raw exact source range, quote, supported code, code-owned category and operative suggestion; unique gold target TP; duplicate extras FP; micro totals; null empty denominator',providerCalls:0});
 // Validate infrastructure with empty offline output, not a model benchmark or quality measurement.
 write('metric-contract-smoke.json',{purpose:'Empty synthetic output plumbing only, not model quality',result:evaluateCorrectionFixtures([{id:gold.fixture,transcript:human.transcript,gold,analysis:{transcriptHash:input.transcriptHash,records:[]}}])});
 const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
 const protectedHashes=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../output/phase3-protected-hashes.json')));for(const [f,h]of Object.entries(protectedHashes))assert.equal(hash(fs.readFileSync(path.resolve(__dirname,'../..',f))),h);
 write('integrity.json',{allProtectedFilesUnchanged:true,protectedHashes,providerCalls:0});
 write('versions.json',{prompt:next.PROMPT_VERSION,schema:next.SCHEMA_VERSION,normalization:next.NORMALIZATION_VERSION,authority:next.AUTHORITY_VERSION,implementationSha256:hash(fs.readFileSync(path.resolve(__dirname,'../src/services/correctionUniqueSource.service.js'))),messagesSha256:hash(JSON.stringify(request.messages)),schemaSha256:hash(JSON.stringify(request.responseSchema))});
 console.log(JSON.stringify({providerCalls:0,capabilityTargets:capability.length,fixtures:discovered,newEnvelopeRejection}));
}
if(require.main===module)main();
module.exports={main};
