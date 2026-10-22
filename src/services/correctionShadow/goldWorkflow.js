'use strict';
const {digest}=require('../hybridSource/reconcile');
const {fallbackLegend,contentHash}=require('../correctionLegendResolver.service');
const {validateCorrectionGold}=require('../hybridSource/correctionGold');
const review=require('./verifier');
function draft(artifact){
 const transcript=artifact.sources[artifact.sourceMode].transcript;
 return {version:'correction-human-review-draft-v1',identity:artifact.identity,humanGold:{version:'human-gold-v1',humanReviewed:false,reviewer:null,imageSha256:artifact.identity.sourceSha256,transcript,excludedSpans:[],expectedCorrections:[]},
  correctionGold:{version:'human-corrections-v1',fixture:`page-${artifact.identity.pageNumber}`,identity:artifact.identity,sourceTranscriptSha256:digest(transcript),sourceGoldFileSha256:null,legend:{version:fallbackLegend().version,contentHash:contentHash(fallbackLegend())},review:{humanReviewed:false,exhaustive:false,status:'PENDING_HUMAN_REVIEW'},corrections:[],reviewCandidates:[],negativeCases:[]},notice:'Draft transcript is not human gold. Independently inspect original image and all categories; explicitly complete transcript, corrections and negative controls before freezing.'};
}
function finalize(value,action,trusted,{geometry}={}){
 if(action?.action!=='FINALIZE_HUMAN_GOLD'||action.confirmedActiveTranscript!==true||action.confirmedExhaustiveCorrections!==true||action.confirmedNegativeControls!==true||action.draftSha256!==digest(JSON.stringify(value)))throw Error('EXPLICIT_COMPLETE_HUMAN_REVIEW_REQUIRED');
 if(!trusted.reviewers.some(r=>r.id===action.reviewerId&&r.kind==='HUMAN_REVIEWER'))throw Error('UNKNOWN_REVIEWER');
 const out=JSON.parse(JSON.stringify(value)),source=out.humanGold,gold=out.correctionGold;
 review.identity(out.identity);
 if(source.imageSha256!==out.identity.sourceSha256||typeof source.transcript!=='string'||source.transcript.length>100000||!Array.isArray(source.excludedSpans))throw Error('HUMAN_SOURCE_REVIEW_INVALID');
 if(gold.reviewCandidates.length||gold.corrections.some(g=>g.mappingStatus==='EXACT_MAPPING_OFFLINE')&&!geometry)throw Error('HUMAN_MAPPING_REVIEW_REQUIRED');
 source.humanReviewed=true;source.reviewer=action.reviewerId;require('../hybridSource/benchmark').validateGold(source);
 gold.sourceTranscriptSha256=digest(source.transcript);gold.sourceGoldFileSha256=digest(JSON.stringify(source,null,2)+'\n');
 gold.review={humanReviewed:true,exhaustive:true,status:'HUMAN_REVIEW_COMPLETE',reviewer:action.reviewerId,reviewedAt:new Date().toISOString(),actionDigest:action.draftSha256};
 validateCorrectionGold(gold,source.transcript,out.identity,geometry);
 return {humanGold:source,correctionGold:gold,publishable:false};
}
module.exports={draft,finalize};
