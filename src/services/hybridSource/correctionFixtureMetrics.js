'use strict';
// Offline multi-fixture metric definitions. No generation, persistence or output repair.
const {digest}=require('./reconcile');
function evaluateCorrectionFixtures(fixtures) {
 const results=fixtures.map(({id,transcript,gold,analysis})=>{
  if(!gold.review?.humanReviewed||!gold.review.exhaustive||gold.sourceTranscriptSha256!==digest(transcript)||analysis.transcriptHash!==digest(transcript))throw Error('EXHAUSTIVE_CURRENT_HUMAN_GOLD_REQUIRED');
  const matched=new Set();let exactTP=0;
  // Score ALL raw records, including diagnostic-only results, before authority filtering.
  for(const r of analysis.records){const c=r.providerRecord,l=r.sourceLocator;
   const g=gold.corrections.find(g=>l.valid&&l.start===g.start&&l.end===g.end&&c.exactQuote===g.quotedText&&c.code===g.symbol&&r.category===g.category&&c.suggestion===g.suggestedText);
   if(g&&!matched.has(g.id)){matched.add(g.id);exactTP++;}
  }
  return {id,rawCount:analysis.records.length,goldCount:gold.corrections.length,exactTP,exactFP:analysis.records.length-exactTP,exactFN:gold.corrections.length-exactTP,matchedIds:[...matched]};
 });
 const totals=results.reduce((a,r)=>{for(const k of ['rawCount','goldCount','exactTP','exactFP','exactFN'])a[k]+=r[k];return a;},{rawCount:0,goldCount:0,exactTP:0,exactFP:0,exactFN:0});
 return {fixtures:results,micro:{...totals,precision:totals.rawCount?totals.exactTP/totals.rawCount:null,recall:totals.goldCount?totals.exactTP/totals.goldCount:null},publishable:false};
}
module.exports={evaluateCorrectionFixtures};
