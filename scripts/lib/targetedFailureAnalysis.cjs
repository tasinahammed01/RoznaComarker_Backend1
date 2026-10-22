'use strict';
const t=require('../../src/services/sourceFidelity/targetedVerification');
const source=require('../../src/services/sourceFidelityOcr.service');
function readerDiagnostic(r){
  if(!r)return {validationStatus:'NOT_STORED',returnedModel:null,activeTranscript:null,segments:null,uncertainSpans:null,latency:null,usage:{}};
  let validationStatus=r.validationStatus||'UNKNOWN_HISTORICAL';
  if(r.value)try{source.validate(JSON.stringify(r.value));validationStatus='VALID';}catch{validationStatus='FAILED';}
  return {requestedModel:r.model,returnedModel:r.returnedModel??null,returnedModelEvidence:r.returnedModel?'STORED':'NOT_STORED_NOT_INFERRED_FROM_REQUEST',
    activeTranscript:r.value?.activeTranscript??null,segments:r.value?.segments??null,uncertainSpans:r.value?.uncertainSpans??null,
    latency:r.durationMs??null,usage:r.usage||{},validationStatus,failureCode:r.failureCode??null,outcome:r.outcome??'NOT_STORED'};
}
function boundaryDiagnostic(original,region,words){
  const map=t.tokenMap(original,words),ws=words.filter(w=>region.sourceGeometryWordIds.includes(w.id));
  const left=ws[0],right=ws.at(-1),lm=map.filter(m=>m.id===left?.id&&m.exact&&!m.ambiguous),rm=map.filter(m=>m.id===right?.id&&m.exact&&!m.ambiguous);
  const reasons=[];
  if(region.lineIds.length!==1)reasons.push('AMBIGUOUS_MAPPING');
  if(lm.length!==1||rm.length!==1)reasons.push('AMBIGUOUS_BOUNDARY');
  const m=region.mapping;
  const hashMatch=m?.sourceTranscriptSha256?t.sha(original)===m.sourceTranscriptSha256:null;
  if(hashMatch===false)reasons.push('HASH_MISMATCH');
  return {structuralMappingState:m?.state||'NOT_STORED',mappedStartOffset:m?.start??null,mappedEndOffset:m?.end??null,
    leftAnchor:{id:region.leftAnchorId,actualBoundaryId:left?.id,exactMatchCount:lm.length},
    rightAnchor:{id:region.rightAnchorId,actualBoundaryId:right?.id,exactMatchCount:rm.length},
    boundaryAnchorState:lm.length===1&&rm.length===1?'EXACT_UNIQUE':'WITHHELD',uniqueMapping:m?.state==='UNIQUE_STRUCTURAL_SPAN',
    originalTranscriptHashMatch:hashMatch,mappingFailureReason:m?.state==='UNIQUE_STRUCTURAL_SPAN'?null:reasons.join('|')||'STRUCTURAL_RULE_REFUSAL',
    reasons};
}
function analyze(evidence){
  const pages=evidence.pages.map(page=>{
    const target=page.targeted;if(!target)return {pageNumber:page.pageNumber,evidenceAvailable:false};
    const words=t.geometryWords(page.google.nativePages[0]),original=page.astra.activeTranscript;
    const rows=target.results.map((result,i)=>{
      const region=result.region,[ar,br]=result.readers,a=readerDiagnostic(ar),b=readerDiagnostic(br),classes=[];
      const both=Boolean(ar?.value&&br?.value);
      const exact=both?ar.value.activeTranscript===br.value.activeTranscript:null;
      const role=both?JSON.stringify(ar.value.segments.map(s=>[s.type,s.text]))===JSON.stringify(br.value.segments.map(s=>[s.type,s.text])):null;
      const uncertain=both?ar.value.uncertainSpans.length>0||br.value.uncertainSpans.length>0||[...ar.value.segments,...br.value.segments].some(s=>s.type==='UNCERTAIN'):null;
      const geometry=both?t.accounted(region,ar.value,words)&&t.accounted(region,br.value,words):null;
      if(exact===false)classes.push('TARGETED_TEXT_DISAGREEMENT');if(role===false)classes.push('TARGETED_ROLE_DISAGREEMENT');
      if(uncertain)classes.push('TARGETED_UNCERTAINTY');if(geometry===false)classes.push('GEOMETRY_NOT_ACCOUNTED');
      for(const r of [a,b]){
        if(r.returnedModel&&r.returnedModel!==r.requestedModel||r.failureCode==='OCR_SOURCE_MODEL_IDENTITY')classes.push('MODEL_ID_MISMATCH');
        if(r.validationStatus==='FAILED'||/^OCR_SOURCE_(SCHEMA|TRANSCRIPT_MISMATCH)$/.test(r.failureCode||''))classes.push('SCHEMA_VALIDATION_FAILURE');
        if(/^(AI_|OCR_TARGETED_TIMEOUT)/.test(r.failureCode||''))classes.push('PROVIDER_FAILURE');
      }
      const mapping=boundaryDiagnostic(original,region,words);
      const pairAgreed=both&&t.compatible(ar.value,br.value)&&geometry;
      let replay=null;if(pairAgreed)replay=t.reconcile(original,region,ar.value);
      if(pairAgreed&&replay?.alignmentState!=='UNIQUE_STRUCTURAL_SPAN'){
        classes.push(...mapping.reasons);if(!mapping.reasons.length)classes.push('AMBIGUOUS_MAPPING');
        if(ar.value.activeTranscript.includes('\n'))classes.push('MULTILINE_MAPPING_REFUSED');
        if(region.mapping?.leftAnchor&&!ar.value.activeTranscript.startsWith(region.mapping.leftAnchor)
          ||region.mapping?.rightAnchor&&!ar.value.activeTranscript.endsWith(region.mapping.rightAnchor))classes.push('ANCHOR_MISMATCH');
      }
      if(result.failureCode==='OCR_TARGETED_CALL_LIMIT')classes.push('BUDGET_LIMIT');
      if(!both&&!classes.length)classes.push('OTHER');
      const ids=region.sourceGeometryWordIds;
      const relevant=text=>{const tm=t.tokenMap(text,words).filter(m=>ids.includes(m.id));return tm.length?{start:Math.min(...tm.map(m=>m.start)),end:Math.max(...tm.map(m=>m.end)),
        text:text.slice(Math.min(...tm.map(m=>m.start)),Math.max(...tm.map(m=>m.end))),state:'DIAGNOSTIC_ALIGNMENT_ONLY'}:null;};
      const resolved=result.status==='TARGETED_MODEL_AGREED'&&result.reconciliation?.alignmentState==='UNIQUE_STRUCTURAL_SPAN';
      return {regionIndex:i+1,regionId:region.id,pageNumber:region.pageNumber,targeted:result.readers.length>0,candidateReasonCodes:region.reasons,
        cropSha256:region.cropSha256??null,cropDimensions:region.cropDimensions??null,nativeRect:region.nativeCoordinates,geometryWordIds:ids,
        firstPassAstraRelevantSpan:relevant(original),firstPassFableRelevantSpan:relevant(page.fable.activeTranscript),
        targetedAstra:a,targetedFable:b,comparison:{activeTextExactEqual:exact,segmentSignatureEqual:role,hasUncertainty:uncertain,geometryAccountedFor:geometry,
          targetedPairState:result.status,comparisonEvidence:both?'AVAILABLE':'UNAVAILABLE_NO_READER_VALUES'},
        reconciliation:{...mapping,patchEligible:pairAgreed&&replay?.alignmentState==='UNIQUE_STRUCTURAL_SPAN',reconciliationReached:Boolean(result.reconciliation),
          targetedBoundaryAnchorState:both?'REPLAYABLE':'NOT_EVALUABLE',mappingOnlyFailure:Boolean(pairAgreed&&replay?.alignmentState!=='UNIQUE_STRUCTURAL_SPAN')},
        final:{resolved,unresolvedReasonCodes:[...new Set(classes)],failureDetail:!both&&result.readers.length?'READER_RESULT_UNAVAILABLE_FAILURE_STAGE_NOT_STORED':result.failureCode??null}};
    });
    return {pageNumber:page.pageNumber,sourceHashMatches:t.sha(page.exactText)===page.exactTextSha256,sourceEqualsPrimary:page.exactText===original,
      summary:target.summary,candidateRegionCount:target.plan.candidateRegionCount,omittedRegionCount:target.plan.omittedRegionCount,
      globalBlockers:[{reason:'UNLOCALIZED_SIGNAL',count:target.plan.unlocalizedSignalCount},
        {reason:'BUDGET_LIMIT',detail:'PAGE_REGION_LIMIT',count:target.plan.omittedRegionCount}].filter(r=>r.count>0),
      unlocalizedSignalCount:target.plan.unlocalizedSignalCount,regions:rows};
  });
  const regions=pages.flatMap(p=>p.regions||[]),targeted=regions.filter(r=>r.targeted);
  return {submissionId:evidence.submissionId,ocrJobId:evidence.ocrJobId,pages,counts:{targetedRegions:targeted.length,resolved:targeted.filter(r=>r.final.resolved).length,
    readerDisagreementsConfirmed:targeted.filter(r=>r.comparison.activeTextExactEqual===false||r.comparison.segmentSignatureEqual===false).length,
    readerUncertaintyConfirmed:targeted.filter(r=>r.comparison.hasUncertainty===true).length,
    mappingOnlyFailuresConfirmed:targeted.filter(r=>r.reconciliation.mappingOnlyFailure).length,
    readerOutcomesUnknown:targeted.filter(r=>r.comparison.activeTextExactEqual===null).length,
    uniqueFirstPassMappings:targeted.filter(r=>r.reconciliation.uniqueMapping).length,
    unlocalizedSignals:pages.reduce((n,p)=>n+(p.unlocalizedSignalCount||0),0)},sourceTextMutated:false,providerCalls:0};
}
module.exports={analyze,readerDiagnostic,boundaryDiagnostic};
