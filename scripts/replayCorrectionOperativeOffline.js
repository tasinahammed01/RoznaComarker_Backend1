'use strict';
// Explicit offline saved-output replay. No completion adapter or provider entry is exposed.
const fs=require('fs'),path=require('path'),assert=require('assert');
const layer=require('../src/services/correctionOperativeAuthority.service');
const strict=require('../src/services/hybridSource/correctionFixtureMetrics');
const operative=require('../src/services/correctionOperativeMetrics.service');
const {digest}=require('../src/services/hybridSource/reconcile');
function main(){
 global.fetch=()=>{throw Error('OFFLINE_NETWORK_FORBIDDEN');};
 const workspace=path.resolve(__dirname,'../..'),root=path.resolve(__dirname,'../tests/fixtures/hybrid-source/private/001-louise-mallard');
 const load=f=>JSON.parse(fs.readFileSync(path.join(root,f),'utf8'));
 const snapshots=JSON.parse(fs.readFileSync(path.join(workspace,'output/phase4-protected-hashes.json')));
 for(const [f,h]of Object.entries(snapshots))assert.equal(digest(fs.readFileSync(path.join(workspace,f))),h);
 const human=load('human-gold.json'),gold=load('human-corrections.json'),raw=load('unique-source-mini-v1-20261020/raw-completion.json');
 const input={transcript:human.transcript,transcriptHash:digest(human.transcript),identity:gold.identity,assignment:{}};
 const analysis=layer.analyzeSaved(input,raw.content),context={identity:gold.identity,transcript:human.transcript,bindings:load('reconciliation-phase2/human-control.json').bindings,
  attestations:load('reconciliation-phase2/offline-gold-attestations.json'),nativeWords:load('google-native.json').rawGoogle[0].words.map((w,i)=>({...w,id:`word_${gold.identity.fileId}_1_${i+1}`})),generatorId:'saved-openrouter-gpt41-mini-v15'};
 const fixture={id:'golden001',transcript:human.transcript,gold,analysis};
 const strictMetrics=strict.evaluateCorrectionFixtures([{...fixture,analysis:analysis.originalV15Analysis}]),operativeMetrics=operative.evaluate([fixture]);
 assert.equal(strictMetrics.micro.exactTP,0);assert.equal(operativeMetrics.micro.exactTP,6);assert.equal(operativeMetrics.micro.exactFP,1);assert.equal(operativeMetrics.micro.exactFN,3);
 const matched=operativeMetrics.fixtures[0].matches;
 const rows=analysis.records.map(record=>{
  const match=matched.find(m=>m.recordIndex===record.index),request=layer.verificationRequest(record,analysis);
  // Explicit offline receipt from frozen human gold / user's negative-control adjudication.
  // This registry is local replay context only; no gold lookup exists in runtime authority code.
  const receipt={reviewerId:'user-gold',reviewId:match?`human-gold-${match.goldId}`:'user-explicit-negative-control-T',candidateKey:request.candidateKey,decision:match?'SUPPORTED':'UNSUPPORTED'};
  const reviewed={...context,trustedSemanticReviewers:{'user-gold':{kind:'HUMAN_REVIEW'}},semanticVerifications:[receipt]};
  return {index:record.index,goldTarget:match?.goldId||null,providerRecord:record.providerRecord,providerEvidenceQuote:record.providerEvidenceQuote,providerSuggestion:record.providerSuggestion,
   sourceLocator:record.sourceLocator,operativeEdit:record.operativeEdit,editShape:record.editShape,reasons:record.reasons,risk:record.semanticRisk,
   baselineAuthority:layer.authority(record,analysis,context),offlineHumanGoldAuthority:layer.authority(record,analysis,reviewed),receipt,verificationRequest:request,publishable:false};
 });
 assert(rows.every(r=>r.baselineAuthority.sourceLocationAuthority.passed));assert(rows.every(r=>!r.baselineAuthority.semanticCorrectionAuthority.sufficient));assert(rows.every(r=>!r.baselineAuthority.scoringAuthority.eligibleOffline));
 assert.equal(rows.filter(r=>r.offlineHumanGoldAuthority.markerAuthority.eligibleOffline).length,6);assert.equal(rows[6].offlineHumanGoldAuthority.semanticCorrectionAuthority.state,'UNSUPPORTED');
 const expectedWords={A:30,B:76,C:86,D:38,E:104,G:130};
 for(const row of rows.filter(r=>r.goldTarget))assert.deepStrictEqual(row.offlineHumanGoldAuthority.markerAuthority.wordIds,[`word_${gold.identity.fileId}_1_${expectedWords[row.goldTarget]}`]);
 const out=path.join(root,'correction-hardening-phase4');fs.mkdirSync(out);
 const write=(f,v)=>fs.writeFileSync(path.join(out,f),JSON.stringify(v,null,2)+'\n');
 write('saved-output-replay.json',{providerCalls:0,notNewDetection:true,strictMetrics,operativeMetrics,rows,missingGoldIds:['F','H','I'],publishable:false});
 write('versions.json',{analysis:layer.ANALYSIS_VERSION,authority:layer.AUTHORITY_VERSION,semanticPolicy:layer.SEMANTIC_POLICY_VERSION,diff:require('../src/services/correctionEditFootprint.service').VERSION,metrics:operative.VERSION,providerSchemaUnchanged:'semantic-corrections-v15-code-owned-category',providerCalls:0});
 const modules=['src/services/correctionEditFootprint.service.js','src/services/correctionOperativeAuthority.service.js','src/services/correctionOperativeMetrics.service.js'];
 write('implementation-hashes.json',Object.fromEntries(modules.map(f=>[f,digest(fs.readFileSync(path.resolve(__dirname,'..',f)))])));
 for(const [f,h]of Object.entries(snapshots))assert.equal(digest(fs.readFileSync(path.join(workspace,f))),h);
 write('integrity.json',{allProtectedFilesUnchanged:true,protectedHashes:snapshots,providerCalls:0});
 console.log(JSON.stringify({providerCalls:0,strict:strictMetrics.micro,operative:operativeMetrics.micro,baselineSourcePass:7,baselineSemanticPass:0,baselineScoringPass:0,offlineHumanGoldMarkers:6,missing:['F','H','I']}));
}
if(require.main===module)main();
module.exports={main};
