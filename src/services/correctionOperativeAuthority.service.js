'use strict';
// New post-response analysis only: no provider entry and no production scoring/publishing hook.
const v15=require('./correctionUniqueSource.service');
const diff=require('./correctionEditFootprint.service');
const {REQUIRED}=require('./correctionLegendResolver.service');
const {digest,validIdentity,polygonValid}=require('./hybridSource/reconcile');
const {sameIdentity}=require('./hybridSource/sourceAuthority');
const {correctionDependency}=require('./hybridSource/verificationPolicy');
const ANALYSIS_VERSION='correction-operative-analysis-v1';
const AUTHORITY_VERSION='correction-layered-authority-v1-independent-semantics';
const SEMANTIC_POLICY_VERSION='correction-semantic-risk-v1-review-required';
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
function risk(code){return {version:SEMANTIC_POLICY_VERSION,riskClass:['SP','CAP'].includes(code)?'LOWER_SOURCE_FORM_RISK':code==='PREP'?'PREPOSITION_CONTEXT_RISK':'HIGHER_MEANING_CONTEXT_RISK',independentReviewRequired:true};}
function analyzeSaved(input,content){
 const original=v15.parse(content,input);
 const records=original.records.map(r=>{
  const provider=r.providerRecord,operative=diff.derive(provider?.exactQuote,provider?.suggestion,r.start??0,provider?.code);
  const shape=diff.validateShape(operative,provider?.code,input.transcript);
  // v15's quote-as-word check is superseded only by the new operative-word validation.
  const reasons=[...r.reasons.filter(x=>x!=='MINIMAL_WORD_QUOTE_REQUIRED'),...shape.reasons];
  if(!r.sourceLocator.valid)reasons.push('EXACT_SOURCE_LOCATION_REQUIRED');
  if(!Object.values(REQUIRED).flat().includes(provider?.code))reasons.push('UNSUPPORTED_CODE');
  return {...r,providerEvidenceQuote:provider?.exactQuote,providerSuggestion:provider?.suggestion,operativeEdit:operative,editShape:shape,
   semanticRisk:risk(provider?.code),originalV15Reasons:[...r.reasons],reasons:[...new Set(reasons)],status:reasons.length?'DIAGNOSTIC_REVIEW_ONLY':'SEMANTIC_REVIEW_REQUIRED',publishable:false};
 });
 return freeze({analysisVersion:ANALYSIS_VERSION,authorityVersion:AUTHORITY_VERSION,semanticPolicyVersion:SEMANTIC_POLICY_VERSION,
  providerSchemaVersion:original.schemaVersion,identity:input.identity,transcriptHash:input.transcriptHash,criteria:original.criteria,rawContent:content,originalV15Analysis:original,records,publishable:false});
}
function verificationRequest(record,analysis){
 if(!analysis.records.includes(record)||!record.sourceLocator.valid)throw Error('CURRENT_BOUNDED_CANDIDATE_REQUIRED');
 const body={version:'independent-correction-verification-v1',identity:analysis.identity,transcriptHash:analysis.transcriptHash,
  sourceContext:record.providerEvidenceQuote,fullSuggestion:record.providerSuggestion,operativeEdit:record.operativeEdit,code:record.providerRecord.code,
  criterion:record.assignmentCriterion||null};
 return freeze({...body,candidateKey:digest(JSON.stringify(body)),publishable:false});
}
function semanticAuthority(record,analysis,context){
 const key=verificationRequest(record,analysis).candidateKey;
 const receipts=(context.semanticVerifications||[]).filter(v=>v.candidateKey===key);
 const trusted=receipts.filter(v=>{
  const registry=context.trustedSemanticReviewers||{},reviewer=Object.hasOwn(registry,v.reviewerId)?registry[v.reviewerId]:null;
  return reviewer&&v.reviewerId!==context.generatorId&&['HUMAN_REVIEW','INDEPENDENT_VERIFIER'].includes(reviewer.kind)
   &&(reviewer.kind==='HUMAN_REVIEW'||(typeof context.generatorId==='string'&&reviewer.independentOf?.includes(context.generatorId)))
   &&typeof v.reviewId==='string'&&v.reviewId.length>0&&['SUPPORTED','UNSUPPORTED','UNCERTAIN'].includes(v.decision);
 });
 if(!trusted.length)return {sufficient:false,state:'SEMANTIC_REVIEW_REQUIRED',reason:'INDEPENDENT_SEMANTIC_EVIDENCE_REQUIRED'};
 if(trusted.some(v=>v.decision==='UNSUPPORTED'))return {sufficient:false,state:'UNSUPPORTED',reason:'INDEPENDENT_REVIEW_REJECTED'};
 if(trusted.some(v=>v.decision==='UNCERTAIN'))return {sufficient:false,state:'UNCERTAIN',reason:'INDEPENDENT_REVIEW_UNCERTAIN'};
 return {sufficient:true,state:'SUPPORTED',reason:'INDEPENDENT_BOUND_CANDIDATE_REVIEW',reviewIds:trusted.map(v=>v.reviewId)};
}
function authority(record,analysis,context={}){
 const no=reason=>({passed:false,reason});
 let source=no('CURRENT_SOURCE_REQUIRED');
 const member=analysis.records.includes(record),current=member&&validIdentity(context.identity)&&sameIdentity(analysis.identity,context.identity)
  &&typeof context.transcript==='string'&&digest(context.transcript)===analysis.transcriptHash;
 if(current){
  const loc=v15.locate(v15.sourceDocument(context.transcript,analysis.transcriptHash),{sourceLineIds:record.providerRecord.sourceLineIds,exactQuote:record.providerEvidenceQuote},context.transcript);
  if(loc.valid&&loc.start===record.start&&loc.end===record.end&&loc.occurrence===record.canonicalOccurrence){
   const relevant=(context.bindings||[]).filter(b=>b.transcriptStart<loc.end&&b.transcriptEnd>loc.start);
   if(relevant.some(b=>b.classification!=='STUDENT_ACTIVE_TEXT'))source=no('EXCLUDED_SOURCE');
   else{const gate=correctionDependency({quotedText:record.providerEvidenceQuote,start:loc.start,end:loc.end,category:record.category,symbol:record.providerRecord.code},context.bindings||[],context.identity,context.attestations||[],{transcript:context.transcript});
    source=gate.decision==='ALLOW_OFFLINE_BINDING'?{passed:true,reason:'CURRENT_EXACT_INDEPENDENTLY_TRUSTED_SOURCE'}:no(gate.reason);}
  }else source=no('DERIVED_LOCATION_MISMATCH');
 }else if(member)source=no('STALE_OR_FOREIGN_SOURCE');
 const shape=source.passed&&record.editShape.valid&&!record.reasons.length?{passed:true,reason:'EXACT_CODE_SHAPED_OPERATIVE_EDIT'}:no(record.reasons[0]||'EDIT_SHAPE_OR_SOURCE_REQUIRED');
 let semantic=source.passed?semanticAuthority(record,analysis,context):{sufficient:false,state:'SEMANTIC_REVIEW_REQUIRED',reason:'EXACT_TRUSTED_SOURCE_REQUIRED'};
 if(semantic.sufficient&&!shape.passed)semantic={sufficient:false,state:'SEMANTIC_REVIEW_REQUIRED',reason:'VALID_EDIT_SHAPE_REQUIRED'};
 let geometry=no('EXACT_OPERATIVE_SPAN_REQUIRED');
 if(source.passed&&shape.passed){
  const e=record.operativeEdit.operativeEditSpan;
  if(e.start===e.end)geometry=no('INSERTION_HAS_NO_SOURCE_POLYGON');
  else{
   const relevant=(context.bindings||[]).filter(b=>b.transcriptStart<e.end&&b.transcriptEnd>e.start).sort((a,b)=>a.transcriptStart-b.transcriptStart);
   if(!relevant.length||relevant[0].transcriptStart!==e.start||relevant.at(-1).transcriptEnd!==e.end)geometry=no('EXACT_OPERATIVE_WORD_BOUNDARIES_REQUIRED');
   else{
    const gate=correctionDependency({quotedText:e.source,start:e.start,end:e.end,category:record.category,symbol:record.providerRecord.code},context.bindings||[],context.identity,context.attestations||[],{transcript:context.transcript});
    const words=new Map((context.nativeWords||[]).map(w=>[w.id,w]));
    if(gate.decision!=='ALLOW_OFFLINE_BINDING')geometry=no(gate.reason);
    else if(!gate.wordIds.length||gate.wordIds.some((id,i)=>!words.has(id)||!polygonValid(gate.polygons[i],context.identity)||JSON.stringify(words.get(id).polygon)!==JSON.stringify(gate.polygons[i])))geometry=no('EXACT_NATIVE_GEOMETRY_REQUIRED');
    else geometry={passed:true,reason:'EXACT_OPERATIVE_NATIVE_GEOMETRY',wordIds:gate.wordIds,polygons:gate.polygons,start:e.start,end:e.end};
   }
  }
 }
 const marker=geometry.passed&&semantic.sufficient?{eligibleOffline:true,reason:'SEMANTICALLY_SUPPORTED_EXACT_MARKER',...geometry}: {eligibleOffline:false,reason:!semantic.sufficient?'SEMANTIC_REVIEW_REQUIRED':geometry.reason,wordIds:[],polygons:[]};
 const policy=context.scoringPolicy,permitted=typeof policy?.id==='string'&&policy.id.length>0&&Array.isArray(policy.permittedCodes)&&policy.permittedCodes.includes(record.providerRecord?.code);
 const scoring=source.passed&&shape.passed&&semantic.sufficient&&permitted?{eligibleOffline:true,reason:'EXPLICIT_POLICY_AND_INDEPENDENT_SEMANTICS',policyId:policy.id}:{eligibleOffline:false,reason:!semantic.sufficient?'SEMANTIC_REVIEW_REQUIRED':!shape.passed?'VALID_EDIT_SHAPE_REQUIRED':'EXPLICIT_SCORING_POLICY_REQUIRED'};
 return freeze({sourceLocationAuthority:source,editShapeAuthority:shape,semanticCorrectionAuthority:semantic,geometryEvidence:geometry,markerAuthority:marker,scoringAuthority:scoring,publishable:false});
}
module.exports={ANALYSIS_VERSION,AUTHORITY_VERSION,SEMANTIC_POLICY_VERSION,risk,analyzeSaved,verificationRequest,authority};
