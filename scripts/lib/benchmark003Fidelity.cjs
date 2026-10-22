'use strict';
// Offline evaluation only; no provider, application models or source acceptance.
const {createHash}=require('crypto'),{align,tokens,diff}=require('../../src/services/sourceFidelity/exactEvidence');
const sha=s=>createHash('sha256').update(s).digest('hex');
const fail=code=>Object.assign(Error(code),{code});
function requireHumanGold(gold){
  if(gold.status!=='HUMAN_GOLD'||gold.humanReviewed!==true||gold.productionAuthority!==false||typeof gold.text!=='string'
    ||!Array.isArray(gold.unresolvedHumanRegions)||gold.unresolvedHumanRegions.length!==0||!Array.isArray(gold.deletedRegionAnnotations)||gold.deletedRegionAnnotations.some(r=>r.reviewStatus!=='HUMAN_CONFIRMED'))throw fail('HUMAN_GOLD_INCOMPLETE');
  if(!gold.text.isWellFormed()||sha(gold.text)!==gold.textSha256)throw fail('HUMAN_GOLD_HASH_INVALID');return gold;
}
const lexical=text=>[...text.matchAll(/\S+/gu)].map(m=>({text:m[0],start:m.index,end:m.index+m[0].length}));
const lineAt=(text,offset)=>text.slice(0,offset).split('\n').length;
const accuracy=(errors,total)=>total?Math.max(0,100*(1-errors/total)):errors?0:100;
function literalMetrics(human,astra){
  if(typeof human!=='string'||typeof astra!=='string')throw fail('EVALUATION_TEXT_INVALID');
  const chars=align(tokens(human,'character'),tokens(astra,'character')),charDiff=diff(human,astra,'character');
  const wordOps=align(lexical(human),lexical(astra)),wordSubstitutions=wordOps.filter(o=>o.left&&o.right&&o.left.text!==o.right.text).length,
    wordInsertions=wordOps.filter(o=>!o.left).length,wordDeletions=wordOps.filter(o=>!o.right).length;
  const humanWords=lexical(human),lineOps=align(tokens(human,'line'),tokens(astra,'line'));
  const mismatches=charDiff.hunks.map(h=>{
    const omitted=wordOps.filter(o=>o.left&&!o.right&&o.left.start>=h.start&&o.left.end<=h.end);
    const inserted=wordOps.filter(o=>!o.left&&o.right.start>=h.rightStart&&o.right.end<=h.rightEnd);
    let category='SPELLING_LEXICAL_CHANGE',subtype=null;
    if((h.left+h.right).includes('\n'))category='LINE_BREAK_CHANGE';
    else if(h.left&&h.right&&h.left!==h.right&&h.left.toLowerCase()===h.right.toLowerCase())category='CASE_CHANGE';
    else if(/^[\s]*$/u.test(h.left+h.right)){category='OTHER';subtype='SPACING_CHANGE';}
    else if(/^[\p{P}\p{S}]*$/u.test(h.left+h.right))category='PUNCTUATION_CHANGE';
    else if(omitted.length&&!h.right)category='WORD_OMISSION';else if(inserted.length&&!h.left)category='WORD_INSERTION';
    return {humanSpan:h.left,astraSpan:h.right,lineNumber:lineAt(human,h.start),astraLineNumber:lineAt(astra,h.rightStart),category,subtype,
      humanStart:h.start,humanEnd:h.end,astraStart:h.rightStart,astraEnd:h.rightEnd,alignmentAmbiguous:h.ambiguous,
      minimalCharacterDiff:{removed:h.left,inserted:h.right},sourceFidelityCategories:[category,...(category==='WORD_OMISSION'?['ACTIVE_TEXT_DROPPED']:[])]};
  });
  const characterEditDistance=chars.filter(o=>o.left?.text!==o.right?.text).length;
  return {normalization:'NONE',characterUnit:'UNICODE_CODE_POINT',wordUnit:'WHITESPACE_DELIMITED_LITERAL_TOKEN_WITH_PUNCTUATION',
    exactTranscriptEqual:human===astra,humanCharacterCount:[...human].length,astraCharacterCount:[...astra].length,characterEditDistance,
    characterAccuracyPercent:accuracy(characterEditDistance,[...human].length),exactLineMatches:lineOps.filter(o=>o.left&&o.right&&o.left.text===o.right.text).length,
    lineMismatchCount:lineOps.filter(o=>o.left?.text!==o.right?.text).length,totalHumanWords:humanWords.length,exactWordMatches:wordOps.filter(o=>o.left&&o.right&&o.left.text===o.right.text).length,
    wordSubstitutions,wordInsertions,wordDeletions,wordAccuracyPercent:accuracy(wordSubstitutions+wordInsertions+wordDeletions,humanWords.length),
    caseOnlyDifferences:mismatches.filter(m=>m.category==='CASE_CHANGE').length,punctuationDifferences:mismatches.filter(m=>m.category==='PUNCTUATION_CHANGE').length,
    spacingDifferences:mismatches.filter(m=>m.subtype==='SPACING_CHANGE').length,mismatches};
}
function projectedSpan(human,astra,start,end){
  if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<start||end>human.length)return null;
  const ops=align(tokens(human,'character'),tokens(astra,'character'));let cursor=0;const selected=[];
  for(const o of ops){const pos=o.left?.start??cursor;if(o.left)cursor=o.left.end;
    if(o.left?o.left.start<end&&o.left.end>start:pos>=start&&pos<=end)selected.push(o);}
  if(selected.some(o=>o.ambiguous))return null;
  return {text:selected.map(o=>o.right?.text||'').join(''),start:selected.find(o=>o.right)?.right.start??null,end:selected.filter(o=>o.right).at(-1)?.right.end??null};
}
function deletionAudit(gold,reader){
  return gold.deletedRegionAnnotations.map(region=>{
    const base={regionId:region.id,lineNumber:region.lineNumber};
    if(region.reviewStatus!=='HUMAN_CONFIRMED'||region.unresolvedRegionId)return {...base,classification:'HUMAN_GOLD_UNRESOLVED'};
    const span=projectedSpan(gold.text,reader.activeTranscript,region.sourceStart,region.sourceEnd);
    if(!span)return {...base,classification:'ROLE_UNCERTAIN',reason:'No unique proven transcript mapping; no coordinates or deleted characters guessed.'};
    const expected=gold.text.slice(region.sourceStart,region.sourceEnd),deleted=region.transcription;
    let classification=span.text===expected?'CORRECTLY_EXCLUDED':deleted&&span.text.includes(deleted)?'DELETED_TEXT_LEAKED':expected&&!span.text?'ACTIVE_REPLACEMENT_MISSED':expected?'ACTIVE_REPLACEMENT_WRONG':'ROLE_UNCERTAIN';
    return {...base,classification,humanSpan:expected,astraSpan:span.text,deletedTranscription:deleted??null,
      modelSeparatelyClassifiedDeletion:typeof deleted==='string'?reader.segments.some(s=>s.type==='CROSSED_OUT_OR_DELETED'&&s.text===deleted):null};
  });
}
function uncertaintyAudit(gold,reader){
  const records=[...reader.uncertainSpans.map((s,index)=>({id:'SPAN_'+index,kind:'SPAN',text:s.visibleContext})),
    ...reader.segments.map((s,index)=>({...s,index})).filter(s=>s.type==='UNCERTAIN').map(s=>({id:'SEGMENT_'+s.index,kind:'SEGMENT',text:s.text}))];
  return records.map(r=>{
    const manual=gold.uncertaintyAdjudications?.find(v=>v.id===r.id);
    if(manual)return {...r,...manual,authority:'EXPLICIT_EVALUATION_ADJUDICATION'};
    const start=typeof r.text==='string'&&r.text.length?gold.text.indexOf(r.text):-1;
    if(start>=0&&gold.text.indexOf(r.text,start+1)<0)return {...r,classification:null,status:'MAPPING_WITHHELD',candidateHumanStart:start,candidateHumanEnd:start+r.text.length,reason:'Unique context is a location candidate, not proof of the uncertain target or its active/deleted role. Explicit adjudication required.'};
    return {...r,classification:null,status:'MAPPING_WITHHELD',reason:'No unique literal human location. Visual/adjudicated mapping is required; absence of a literal context is not proof of unreadability or wrong context.'};
  });
}
function evaluate(gold,reader,{uncertaintyAdjudications=gold.uncertaintyAdjudications}={}){
  requireHumanGold(gold);const metrics=literalMetrics(gold.text,reader.activeTranscript),roles=deletionAudit(gold,reader),uncertainty=uncertaintyAudit({...gold,uncertaintyAdjudications},reader);
  const silent=metrics.mismatches.map((m,index)=>{
    const proven=uncertainty.some(u=>Number.isInteger(u.humanStart)&&u.humanStart<m.humanEnd&&u.humanEnd>m.humanStart);
    return {mismatchIndex:index,classification:proven?'WITHIN_REPORTED_UNCERTAINTY':uncertainty.some(u=>u.status==='MAPPING_WITHHELD')?'UNDETERMINED':'SILENT_ACTIVE_TEXT_MISMATCH'};
  });
  return {...metrics,deletionRevisionAudit:roles,uncertaintyAudit:uncertainty,silentErrorAudit:silent,
    silentErrorCount:silent.some(s=>s.classification==='UNDETERMINED')?null:silent.filter(s=>s.classification==='SILENT_ACTIVE_TEXT_MISMATCH').length,
    omissionCount:metrics.wordDeletions,deletionRoleErrorCount:roles.some(r=>['ROLE_UNCERTAIN','HUMAN_GOLD_UNRESOLVED'].includes(r.classification))?null:roles.filter(r=>['DELETED_TEXT_LEAKED','ACTIVE_REPLACEMENT_MISSED','ACTIVE_REPLACEMENT_WRONG'].includes(r.classification)).length,
    astraUncertainSpanCount:reader.uncertainSpans.length,
    correctlyUncertainCount:uncertainty.filter(u=>u.kind==='SPAN'&&u.classification==='CORRECTLY_UNCERTAIN').length,
    unnecessarilyUncertainCount:uncertainty.filter(u=>u.kind==='SPAN'&&u.classification==='UNNECESSARILY_UNCERTAIN').length,
    limitations:['Ambiguous sequence alignment is reported, not interpreted as proven geometry.','Unlocalized uncertainty and revision roles are withheld rather than guessed.','Accuracy is clamped max(0,100*(1-editCount/humanUnitCount)); no input normalization.']};
}
module.exports={sha,requireHumanGold,literalMetrics,projectedSpan,deletionAudit,uncertaintyAudit,evaluate};
