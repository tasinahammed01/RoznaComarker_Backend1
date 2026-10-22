'use strict';
// Post-result diagnostic comparisons only. Never imported by the OCR runtime.
function distance(a,b){
  if(typeof a!=='string'||typeof b!=='string'||a.length>2000||b.length>2000)return null;
  let row=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=1;i<=a.length;i++){const next=[i];for(let j=1;j<=b.length;j++)next[j]=Math.min(next[j-1]+1,row[j]+1,row[j-1]+(a[i-1]===b[j-1]?0:1));row=next;}
  return row[b.length];
}
function evaluate(result,expected,historical){
  const old=historical?.readers||[],now=result.readers;
  const expectedTokens=expected.split(/\s+/u).filter(Boolean),missing=old[0]?.schemaValid?expectedTokens.filter(token=>!old[0].activeTranscript.split(/\s+/u).includes(token)):null;
  const compare=now.map((r,i)=>{const before=old[i]?.schemaValid?distance(old[i].activeTranscript,expected):null,after=r.schemaValid?distance(r.activeTranscript,expected):null;
    return {model:r.requestedModel,historicalCharacterDistance:before,currentCharacterDistance:after,exactRow:r.schemaValid?r.activeTranscript===expected:null,
      characterDistanceImproved:before!==null&&after!==null?after<before:null,
      reportsClippedEdges:r.schemaValid?[...(r.uncertainSpans||[]).map(s=>s.reason),...(r.segments||[]).map(s=>s.notes)].some(s=>/clip|crop.edge|cut.off/iu.test(s)):null};});
  return {authority:'TEST_ONLY_POST_RESULT',lexicalMetricOnly:true,missingExpectedTokensFromHistoricalAstra:missing,
    astraNowContainsPreviouslyMissingExactTokens:missing?.length&&now[0]?.schemaValid?missing.every(token=>now[0].activeTranscript.split(/\s+/u).includes(token)):null,
    readers:compare,readersExactCompatible:result.pair.activeTextExactEqual===null?null:result.pair.activeTextExactEqual&&result.pair.segmentSignatureEqual&&!result.pair.hasUncertainty,
    geometryAccountedFor:result.pair.geometryAccountedFor,structuralReconciliationEligible:result.reconciliation.patchEligible,
    automaticSourceImproved:compare[0]?.characterDistanceImproved===true&&result.reconciliation.patchEligible,
    interpretation:'Exact missing-token and character-distance evidence, not semantic correctness. Agreement/geometry/reconciliation gates remain mandatory.'};
}
module.exports={distance,evaluate};
