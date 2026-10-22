'use strict';
const strict=require('../hybridSource/correctionFixtureMetrics');
const operative=require('../correctionOperativeMetrics.service');
function evaluate(pages){
 const reviewed=pages.filter(p=>p.gold?.review?.humanReviewed&&p.gold.review.exhaustive&&p.humanSourceReviewed===true),excluded=pages.filter(p=>!reviewed.includes(p)).map(p=>({id:p.id,status:'HUMAN_REVIEW_REQUIRED'}));
 const perPage=reviewed.map(p=>{
  const f={id:p.id,transcript:p.transcript,gold:p.gold,analysis:p.analysis},a=operative.evaluate([f]),s=strict.evaluateCorrectionFixtures([{...f,analysis:p.analysis.originalV15Analysis}]);
  const adjudications=p.ocrAdjudications||[],seen=new Set();
  for(const x of adjudications){if(x.action!=='RECORD_HUMAN_OCR_CAUSAL_REVIEW'||x.confirmed!==true||typeof x.ocrInduced!=='boolean'||seen.has(x.candidateKey)||!p.artifact.rows.some(r=>r.candidateKey===x.candidateKey)||!p.trustedRegistry?.reviewers.some(r=>r.id===x.reviewerId&&r.kind==='HUMAN_REVIEWER'))throw Error('EXPLICIT_HUMAN_OCR_ADJUDICATION_REQUIRED');seen.add(x.candidateKey);}
  const ocrCount=adjudications.filter(x=>x.ocrInduced).length,ocrUnknown=p.artifact.rows.length-adjudications.length;
  const matches=new Set(a.fixtures[0].matches.map(m=>m.recordIndex)),rows=p.artifact.rows,eligible=rows.filter(r=>r.authority.sourceLocationAuthority.passed&&r.authority.editShapeAuthority.passed&&r.authority.semanticCorrectionAuthority.sufficient);
  const supported=rows.filter(r=>r.authority.semanticCorrectionAuthority.state==='SUPPORTED').length,unsupported=rows.filter(r=>r.authority.semanticCorrectionAuthority.state==='UNSUPPORTED').length,uncertain=rows.filter(r=>r.authority.semanticCorrectionAuthority.state==='UNCERTAIN').length;
  const markers=rows.filter(r=>r.authority.markerAuthority.eligibleOffline).length;
  return {id:p.id,strict:s.micro,operative:a.micro,semanticFalsePositives:supported+unsupported+uncertain===rows.length?unsupported:null,semanticReviewPending:rows.length-supported-unsupported-uncertain,semanticFalseNegatives:a.micro.exactFN,semanticAdjudicationComplete:supported+unsupported+uncertain===rows.length,authorityEligible:eligible.length,authorityEligibleTP:eligible.filter(r=>matches.has(r.index)).length,authorityEligiblePrecision:eligible.length?eligible.filter(r=>matches.has(r.index)).length/eligible.length:null,
   unsupported,uncertain,unsupportedUncertainRate:rows.length?(unsupported+uncertain)/rows.length:null,markerEligible:markers,markerEligibilityRate:rows.length?markers/rows.length:null,rawCount:rows.length,ocrInducedFalseCorrections:{status:ocrUnknown?'EXPLICIT_SOURCE_ADJUDICATION_REQUIRED':'HUMAN_ADJUDICATED',count:adjudications.length?ocrCount:null,unknown:ocrUnknown,rate:!ocrUnknown&&rows.length?ocrCount/rows.length:null}};
 });
 const aggregate={pages:perPage.length,strict:strict.evaluateCorrectionFixtures(reviewed.map(p=>({id:p.id,transcript:p.transcript,gold:p.gold,analysis:p.analysis.originalV15Analysis}))).micro,
  operative:operative.evaluate(reviewed.map(p=>({id:p.id,transcript:p.transcript,gold:p.gold,analysis:p.analysis}))).micro};
 for(const k of ['semanticFalsePositives','semanticFalseNegatives','authorityEligible','authorityEligibleTP','unsupported','uncertain','semanticReviewPending','markerEligible','rawCount'])aggregate[k]=perPage.reduce((n,p)=>n+p[k],0);
 if(perPage.some(p=>!p.semanticAdjudicationComplete))aggregate.semanticFalsePositives=null;
 aggregate.authorityEligiblePrecision=aggregate.authorityEligible?aggregate.authorityEligibleTP/aggregate.authorityEligible:null;
 aggregate.unsupportedUncertainRate=aggregate.rawCount?(aggregate.unsupported+aggregate.uncertain)/aggregate.rawCount:null;aggregate.markerEligibilityRate=aggregate.rawCount?aggregate.markerEligible/aggregate.rawCount:null;
 const ocrUnknown=perPage.reduce((n,p)=>n+p.ocrInducedFalseCorrections.unknown,0),ocrCount=perPage.reduce((n,p)=>n+(p.ocrInducedFalseCorrections.count||0),0);aggregate.ocrInducedFalseCorrections={status:ocrUnknown?'EXPLICIT_SOURCE_ADJUDICATION_REQUIRED':'HUMAN_ADJUDICATED',count:perPage.length?ocrCount:null,unknown:ocrUnknown,rate:!ocrUnknown&&aggregate.rawCount?ocrCount/aggregate.rawCount:null};
 return {version:'correction-shadow-metrics-v1',perPage,aggregate,excluded,publishable:false};
}
module.exports={evaluate};
