'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert');
const pipeline=require('../src/services/correctionShadow/pipeline');
const review=require('../src/services/correctionShadow/verifier');
const store=require('../src/services/correctionShadow/privateReview');
const workflow=require('../src/services/correctionShadow/goldWorkflow');
const metrics=require('../src/services/correctionShadow/metrics');
const {digest}=require('../src/services/hybridSource/reconcile');
async function main(){
 global.fetch=()=>{throw Error('ZERO_PROVIDER_CALLS');};
 const root=path.resolve(__dirname,'../tests/fixtures/hybrid-source/private/001-louise-mallard'),load=f=>JSON.parse(fs.readFileSync(path.join(root,f),'utf8'));
 const human=load('human-gold.json'),gold=load('human-corrections.json'),native=load('google-native.json'),id=gold.identity;
 const generator={id:'openrouter-gpt41-mini-v15',model:'openai/gpt-4.1-mini'};
 const snapshot=(transcript)=>({identity:id,transcript,transcriptHash:digest(transcript)});
 const page={identity:id,sources:{legacy:snapshot(native.fullText),human:snapshot(human.transcript)},analysisSource:'human',savedCompletion:load('unique-source-mini-v1-20261020/raw-completion.json').content,
  evidence:{bindings:load('reconciliation-phase2/human-control.json').bindings,attestations:load('reconciliation-phase2/offline-gold-attestations.json'),nativeWords:native.rawGoogle[0].words.map((w,i)=>({...w,id:`word_${id.fileId}_1_${i+1}`}))}};
 const result=await pipeline.runPage(page,{generator,reviewers:[]});
 const matched=metrics.evaluate([{id:'golden001',transcript:human.transcript,gold,humanSourceReviewed:human.humanReviewed,analysis:result.analysis,artifact:result.artifact}]);
 assert.equal(matched.aggregate.operative.exactTP,6);assert.equal(matched.aggregate.strict.exactTP,0);
 assert(result.artifact.rows.every(r=>!r.publishable&&!r.authority.semanticCorrectionAuthority.sufficient&&!r.authority.scoringAuthority.eligibleOffline&&!r.authority.markerAuthority.eligibleOffline));
 assert.equal(result.artifact.rows[6].code,'T');assert(result.artifact.rows[6].withheldReasons.includes('COMPLEX_OR_MULTI_EDIT'));
 const requests=result.analysis.records.map(r=>review.request(r,result.analysis,generator));requests.forEach(review.validateRequest);
 const out=path.join(root,'correction-shadow-phase5');fs.mkdirSync(out);
 const write=(name,v)=>store.write(path.join(out,name),v);
 write('shadow-review.json',result.artifact);write('metrics.json',matched);write('review-actions.json',store.reviewActions(result.artifact));
 write('human-gold-draft.json',workflow.draft(result.artifact));write('requests.json',requests);requests.forEach((r,i)=>write(`requests/candidate-${i}.json`,r));
 write('registry-template.json',{notice:'Template only. Registration is an explicit trusted developer action, not automatic approval.',generator,reviewers:[]});
 write('request-sizes.json',{serializedUtf8Bytes:{oneCandidate:Buffer.byteLength(JSON.stringify(requests[0])),sevenCandidates:Buffer.byteLength(JSON.stringify(requests))},candidates:requests.length,providerCalls:0});
 write('review.html',store.render(result.artifact,path.join(root,'source.png.jpeg'),path.join(out,'review.html')));
 const workspace=path.resolve(__dirname,'../..'),snapshots=JSON.parse(fs.readFileSync(path.join(workspace,'output/phase5-protected-hashes.json')));
 for(const [f,h]of Object.entries(snapshots))assert.equal(digest(fs.readFileSync(path.join(workspace,f))),h);
 write('integrity.json',{allProtectedFilesUnchanged:true,protectedHashes:snapshots,providerCalls:0});
 console.log(JSON.stringify({providerCalls:0,strictTP:0,operativeTP:6,missing:['F','H','I'],semanticSupport:0,scoringAuthority:0,markerPublication:false,requestBytes:{one:Buffer.byteLength(JSON.stringify(requests[0])),seven:Buffer.byteLength(JSON.stringify(requests))}}));
}
if(require.main===module)main().catch(()=>{process.stderr.write('Offline shadow replay failed; no provider fallback exists.\n');process.exitCode=1;});
module.exports={main};
