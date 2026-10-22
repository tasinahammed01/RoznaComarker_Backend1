'use strict';
// Additional operative-edit metric; frozen strict provider-output metrics are untouched.
const diff=require('./correctionEditFootprint.service');
const {digest}=require('./hybridSource/reconcile');
const VERSION='operative-edit-exact-metrics-v1';
function evaluate(fixtures){
 const results=fixtures.map(({id,transcript,gold,analysis})=>{
  if(!gold.review?.humanReviewed||!gold.review.exhaustive||gold.sourceTranscriptSha256!==digest(transcript)||analysis.transcriptHash!==digest(transcript))throw Error('EXHAUSTIVE_CURRENT_HUMAN_GOLD_REQUIRED');
  const normalized=gold.corrections.map(g=>({gold:g,edit:diff.derive(g.quotedText,g.suggestedText,g.start,g.symbol)}));
  if(normalized.some(g=>!g.edit.valid))throw Error('GOLD_OPERATIVE_EDIT_REVIEW_REQUIRED');
  const found=new Set(),matches=[];
  for(const r of analysis.records){
   const e=r.operativeEdit?.operativeEditSpan,c=r.providerRecord;
   const target=normalized.find(({gold:g,edit})=>r.sourceLocator.valid&&r.operativeEdit.valid&&r.editShape.valid&&c.code===g.symbol&&r.category===g.category
    &&e.start===edit.operativeEditSpan.start&&e.end===edit.operativeEditSpan.end&&e.source===edit.operativeEditSpan.source&&e.replacement===edit.operativeEditSpan.replacement);
   if(target&&!found.has(target.gold.id)){found.add(target.gold.id);matches.push({recordIndex:r.index,goldId:target.gold.id,operativeEdit:e});}
  }
  return {id,rawCount:analysis.records.length,goldCount:gold.corrections.length,exactTP:found.size,exactFP:analysis.records.length-found.size,exactFN:gold.corrections.length-found.size,matches};
 });
 const micro=results.reduce((a,r)=>{for(const k of ['rawCount','goldCount','exactTP','exactFP','exactFN'])a[k]+=r[k];return a;},{rawCount:0,goldCount:0,exactTP:0,exactFP:0,exactFN:0});
 return {version:VERSION,metricFamily:'OPERATIVE_EDIT_EXACT',fixtures:results,micro:{...micro,precision:micro.rawCount?micro.exactTP/micro.rawCount:null,recall:micro.goldCount?micro.exactTP/micro.goldCount:null},publishable:false};
}
module.exports={VERSION,evaluate};
