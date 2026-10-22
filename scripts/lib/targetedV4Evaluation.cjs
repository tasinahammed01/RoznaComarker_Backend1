'use strict';
// Test-only post-result diagnostics. Never imported by source readers or crop generation.
const {distance}=require('./targetedV3Evaluation.cjs');
function metric(reader,expected){
  if(!reader?.schemaValid)return {characterDistance:null,exactRow:null,uncertainSpanCount:null,reportedCost:reader?.reportedCost??null};
  return {characterDistance:distance(reader.activeTranscript,expected),exactRow:reader.activeTranscript===expected,
    uncertainSpanCount:reader.uncertainSpans?.length??null,reportedCost:Number.isFinite(reader.reportedCost)?reader.reportedCost:null};
}
function totalCost(readers){return readers?.length===2&&readers.every(r=>Number.isFinite(r.reportedCost))?readers.reduce((sum,r)=>sum+r.reportedCost,0):null;}
function evaluate(result,expected,history={}){
  const comparisons=result.readers.map(r=>({requestedModel:r.requestedModel,
    v2:metric(history.v2?.readers?.find(p=>p.requestedModel===r.requestedModel),expected),
    v3:metric(history.v3?.readers?.find(p=>p.requestedModel===r.requestedModel),expected),v4:metric(r,expected)}));
  const oldAstra=history.v2?.readers?.find(r=>r.requestedModel===result.readers[0]?.requestedModel);
  const missing=oldAstra?.schemaValid?expected.split(/\s+/u).filter(t=>t&&!oldAstra.activeTranscript.split(/\s+/u).includes(t)):null;
  const exactMissing=result.readers.map(r=>({requestedModel:r.requestedModel,recoveredExactPreviouslyMissingTokens:missing?.length&&r.schemaValid?missing.every(t=>r.activeTranscript.split(/\s+/u).includes(t)):null}));
  const compatible=result.pair.activeTextExactEqual===null?null:Boolean(result.pair.activeTextExactEqual&&result.pair.segmentSignatureEqual&&!result.pair.hasUncertainty);
  const safe=Boolean(result.reconciliation.patchEligible),v4Cost=totalCost(result.readers),v3Cost=totalCost(history.v3?.readers);
  const better=comparisons.every(c=>c.v3.characterDistance!==null&&c.v4.characterDistance!==null&&c.v4.characterDistance<=c.v3.characterDistance)
    &&comparisons.some(c=>c.v3.characterDistance!==null&&c.v4.characterDistance<c.v3.characterDistance);
  return {authority:'TEST_ONLY_AFTER_BOTH_READERS_COMPLETE',comparisons,previouslyMissingExactTokens:missing,exactTokenRecovery:exactMissing,
    readersExactCompatible:compatible,uncertaintyDisappeared:result.pair.hasUncertainty===null?null:!result.pair.hasUncertainty,
    patchEligible:safe,characterDistanceOutperformedV3:history.v3?better:null,
    safeExactResolution:safe&&comparisons.every(c=>c.v4.exactRow===true),
    v4OutperformedV3:history.v3?{characterDistance:better,safeAutomaticResolution:safe&&comparisons.every(c=>c.v4.exactRow===true)&&!history.v3.reconciliation?.patchEligible}:null,
    cost:{v4IncrementalExperimentCost:v4Cost,v3ExperimentCost:v3Cost,differenceVersusV3:v4Cost!==null&&v3Cost!==null?v4Cost-v3Cost:null,currency:'USD_PROVIDER_REPORTED',unknownUsageIsNotZero:true},
    experimentPolicy:{finalBoundedVisualExperiment:true,stopFurtherVisualExperiments:!(safe&&comparisons.every(c=>c.v4.exactRow===true)),
      recommendation:safe&&comparisons.every(c=>c.v4.exactRow===true)?'Safe exact diagnostic result only; no source publication or production activation authorized.':'STOP crop/resize/prompt visual experiments for this row. Retain existing human verification fallback. No voting, dictionary hints, generative super-resolution or repeated retries.'}};
}
module.exports={metric,totalCost,evaluate};
