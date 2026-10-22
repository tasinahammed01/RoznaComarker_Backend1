'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert');
const hook=require('../src/services/correctionShadow/stagingHook'),layer=require('../src/services/correctionOperativeAuthority.service');
const operative=require('../src/services/correctionOperativeMetrics.service'),workflow=require('../src/services/correctionShadow/goldWorkflow'),review=require('../src/services/correctionShadow/privateReview');
const {digest}=require('../src/services/hybridSource/reconcile');
async function main(){
 global.fetch=()=>{throw Error('ZERO_EXTERNAL_TRAFFIC');};
 const root=path.resolve(__dirname,'../tests/fixtures/hybrid-source/private/001-louise-mallard'),load=f=>JSON.parse(fs.readFileSync(path.join(root,f)));
 const human=load('human-gold.json'),gold=load('human-corrections.json'),native=load('google-native.json'),id=gold.identity,raw=load('unique-source-mini-v1-20261020/raw-completion.json');
 const pages=hook.snapshotCompleted({submissionId:id.submissionId,runId:id.runId,status:'completed',pages:[{fileId:id.fileId,pageNumber:id.pageNumber,ocrRunId:id.runId,text:human.transcript,width:id.width,height:id.height,ocrExifOrientation:id.orientation,sourceSha256:id.sourceSha256,ocrInputSha256:id.inputSha256,words:native.rawGoogle[0].words.map((w,i)=>({...w,id:`word_${id.fileId}_1_${i+1}`}))}]});
 const saved=[],unchanged={score:84,rubric:{content:20},corrections:['existing-production'],pdf:'existing.pdf'},before=JSON.stringify(unchanged);
 const env={NODE_ENV:'staging',CORRECTION_PIPELINE_MODE:'shadow_v15'},response=new(require('events').EventEmitter)();response.writableFinished=false;hook.trackResponse(id.submissionId,id.runId,response,env);
 hook.observeCompleted(pages,{env,requireResponseBoundary:true,adapters:{generator:{id:'saved-v15-local-replay',model:'openai/gpt-4.1-mini'},generate:async()=>raw.content},repositoryFactory:()=>({isCurrent:async()=>true,save:async artifact=>saved.push(artifact)})});assert.equal(saved.length,0);response.writableFinished=true;response.emit('finish');await hook.waitForIdle();
 assert.equal(saved.length,1);assert.equal(saved[0].rows.length,7);assert.equal(before,JSON.stringify(unchanged));assert(saved[0].rows.every(r=>!r.publishable&&!r.authority.scoringAuthority.eligibleOffline&&!r.authority.semanticCorrectionAuthority.sufficient));
 const analysis=layer.analyzeSaved({transcript:human.transcript,transcriptHash:digest(human.transcript),identity:id,assignment:{}},raw.content),metrics=operative.evaluate([{id:'golden001',transcript:human.transcript,gold,analysis}]);assert.equal(metrics.micro.exactTP,6);assert.equal(metrics.micro.exactFN,3);
 const draft=workflow.draft(saved[0]);assert.equal(draft.humanGold.humanReviewed,false);assert.equal(draft.correctionGold.review.exhaustive,false);
 const out=path.join(root,'correction-shadow-phase6-v2');fs.mkdirSync(out);const write=(n,v)=>fs.writeFileSync(path.join(out,n),JSON.stringify(v,null,2)+'\n');write('hooked-replay.json',{artifact:saved[0],metrics,missed:['F','H','I'],iMappingStatus:gold.corrections.find(g=>g.id==='I').mappingStatus,publicProductionStateUnchanged:true,providerCalls:0});write('review-actions.json',review.reviewActions(saved[0]));write('human-gold-draft.json',draft);write('diagnostics.json',hook.diagnostics());
 console.log(JSON.stringify({providerCalls:0,operativeExactTP:6,missing:['F','H','I'],semanticAuthority:0,scoringAuthority:0,publishable:false}));
}
if(require.main===module)main().catch(()=>{process.stderr.write('Local hookup replay failed; no provider fallback exists.\n');process.exitCode=1;});
module.exports={main};
