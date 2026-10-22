'use strict';
// Offline diagnostics only. No provider, application startup or model-write imports.
const crypto=require('crypto');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const fail=code=>Object.assign(Error(code),{code});
const string=(v,max=180000)=>typeof v==='string'?v.slice(0,max):null;
const number=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
function reading(v,metadata){
  if(!v)return null;
  if(typeof v.activeTranscript!=='string'||v.activeTranscript.length>180000)throw fail('AUDIT_EVIDENCE_LIMIT');
  return {requestedModel:string(metadata?.requestedModel,100),returnedModel:string(metadata?.returnedModel,100),
    activeTranscript:string(v.activeTranscript),segments:(v.segments||[]).slice(0,1000).map(s=>({type:string(s.type,60),text:string(s.text),confidence:number(s.confidence),notes:string(s.notes,2000)})),
    uncertainSpans:(v.uncertainSpans||[]).slice(0,1000).map(s=>({visibleContext:string(s.visibleContext),candidateReading:string(s.candidateReading),reason:string(s.reason,2000)})),
    usage:Object.fromEntries(['prompt_tokens','completion_tokens','total_tokens','cost','thoughts_tokens'].filter(k=>number(metadata?.usage?.[k])!==null).map(k=>[k,metadata.usage[k]])),
    latencyMs:number(metadata?.durationMs)};
}
function word(w){return {id:string(w.nativeId||w.id,160),text:string(w.text,2000),paragraphIndex:number(w.paragraphIndex),confidence:number(w.confidence),
  polygon:(w.polygon||[]).slice(0,8).map(p=>({x:number(p.x),y:number(p.y)})),
  bbox:w.bbox?Object.fromEntries(['x0','y0','x1','y1'].map(k=>[k,number(w.bbox[k])])):null,
  symbols:(w.symbols||[]).slice(0,200).map(s=>({text:string(s.text,20),confidence:number(s.confidence),breakType:typeof s.breakType==='number'?s.breakType:string(s.breakType,50),
    polygon:(s.polygon||[]).slice(0,8).map(p=>({x:number(p.x),y:number(p.y)}))}))};}
function exportEvidence(submission,evidence){
  if(!submission)throw fail('AUDIT_SUBMISSION_NOT_FOUND');
  const pages=(submission.ocrPages||[]).map(p=>{
    const matches=evidence.filter(e=>e.identity?.submissionId===String(submission._id)&&e.identity?.runId===String(submission.ocrJobId)
      &&e.identity?.fileId===String(p.fileId)&&e.identity?.pageNumber===p.pageNumber&&e.identity?.inputSha256===p.sourceInputSha256);
    if(matches.length>1)throw fail('AUDIT_AMBIGUOUS_CURRENT_EVIDENCE');
    const e=matches[0],payload=e?.payload;
    return {fileId:String(p.fileId),fileOrder:p.fileOrder,pageNumber:p.pageNumber,pageIndex:p.pageIndex,
      inputSha256:p.sourceInputSha256,sourceSha256:p.sourceSha256,mode:p.sourceFidelityMode,status:p.sourceFidelityStatus,version:p.sourceFidelityVersion,
      exactText:p.sourceTextExact,exactTextSha256:p.sourceTextSha256,storedDisagreementCount:p.sourceDisagreementCount,
      evidenceAvailable:Boolean(e),astra:reading(payload?.primary,payload?.readers?.[0]),fable:reading(payload?.secondary,payload?.readers?.[1]),
      google:{wordCount:payload?.google?.wordCount??null,nativePages:(payload?.google?.nativePages||[]).slice(0,1).map(n=>({pageNumber:n.pageNumber,width:n.width,height:n.height,
        dimensionsMatch:n.dimensionsMatch,words:(n.words||[]).slice(0,2000).map(word)})),storedWords:(p.words||[]).slice(0,2000).map(word)},
      existingDiagnostics:(payload?.differences||[]).slice(0,1000).map(d=>({category:string(d.category,100),start:number(d.start),
        evidenceScope:d.category==='SEGMENT_CLASSIFICATION_OR_TEXT'?'ORDERED_SEGMENT_SIGNATURE':'WHOLE_ACTIVE_TRANSCRIPT',
        astraValue:d.category==='SEGMENT_CLASSIFICATION_OR_TEXT'?reading(payload?.primary)?.segments:payload?.primary?.activeTranscript??null,
        fableValue:d.category==='SEGMENT_CLASSIFICATION_OR_TEXT'?reading(payload?.secondary)?.segments:payload?.secondary?.activeTranscript??null,
        limitation:'Stored diagnostic is coarse; exact regions are recomputed separately. It is not one source error.'}))};
  });
  return {version:'ocr-source-audit-v1',privateDiagnostic:true,submissionId:String(submission._id),ocrJobId:String(submission.ocrJobId),
    sourceMode:submission.sourceFidelityMode,sourceStatus:submission.sourceFidelityStatus,sourceVersion:submission.sourceFidelityVersion,
    sourceTranscriptExact:submission.sourceTranscriptExact,sourceTranscriptSha256:submission.sourceTranscriptSha256,pages,
    sourceTextMutated:false,providerCalls:0};
}
// Same exact-token/edit-distance concepts as benchmark comparison, with no CLI imports.
const {tokens,align,diff,geometryCoverage}=require('../../src/services/sourceFidelity/exactEvidence');
function comparisons(a,b){return {character:diff(a,b,'character'),word:diff(a,b),line:diff(a,b,'line')};}
function classify(gold,astra,fable,pending=[],authority='RELATIVE_TO_PROVISIONAL_HUMAN_BASELINE'){
  const a=diff(gold,astra,'character'),b=diff(gold,fable,'character');
  const ranges=[...a.hunks,...b.hunks].map(h=>({start:h.start,end:h.end})).sort((x,y)=>x.start-y.start||x.end-y.end),merged=[];
  for(const r of ranges){const last=merged.at(-1);if(last&&r.start<=last.end){last.end=Math.max(last.end,r.end);}else merged.push({...r});}
  const project=(text,hunks,start,end)=>{
    let cursor=start,result='';for(const h of hunks.filter(h=>h.start>=start&&h.end<=end)){
      result+=text.slice(cursor,h.start)+h.right;cursor=h.end;
    }return result+text.slice(cursor,end);
  };
  const findings=merged.map(r=>{
    const human=gold.slice(r.start,r.end),av=project(gold,a.hunks,r.start,r.end),fv=project(gold,b.hunks,r.start,r.end);
    const pendingSpans=pending.filter(p=>r.start<p.end&&r.end>p.start||r.start===r.end&&r.start>=p.start&&r.start<=p.end);
    const classification=pendingSpans.length?'HUMAN_GOLD_PENDING':av===human?'FABLE_ONLY_ERROR':fv===human?'ASTRA_ONLY_ERROR'
      :av===fv?'BOTH_MODELS_SAME_WRONG':'ASTRA_FABLE_DISAGREEMENT';
    return {...r,human,astra:av,fable:fv,classification,pendingSpans,lineNumber:gold.slice(0,r.start).split('\n').length,
      context:gold.slice(Math.max(0,r.start-45),Math.min(gold.length,r.end+45)),
      alignmentAmbiguous:[...a.hunks,...b.hunks].some(h=>h.start<=r.end&&h.end>=r.start&&h.ambiguous),
      authority};
  });
  for(const p of pending)if(!findings.some(f=>f.pendingSpans.some(s=>s.start===p.start)))findings.push({...p,human:gold.slice(p.start,p.end),
    astra:project(gold,a.hunks,p.start,p.end),fable:project(gold,b.hunks,p.start,p.end),classification:'HUMAN_GOLD_PENDING',
    reason:'Explicit final human freeze still required even if both models agree.'});
  return {counts:findings.reduce((out,f)=>(out[f.classification]=(out[f.classification]||0)+1,out),{}),findings};
}
function audit(page,gold){
  if(page.inputSha256!==gold.inputSha256)throw fail('AUDIT_GOLD_INPUT_MISMATCH');
  if(!page.astra||!page.fable)throw fail('AUDIT_READER_EVIDENCE_UNAVAILABLE');
  const a=page.astra.activeTranscript,b=page.fable.activeTranscript;
  if(sha(page.exactText)!==page.exactTextSha256||page.exactText!==a)throw fail('AUDIT_SOURCE_EVIDENCE_MISMATCH');
  const words=page.google.nativePages[0]?.words||page.google.storedWords;
  const humanFindings=classify(gold.text,a,b,gold.pendingSpans,gold.status==='HUMAN_GOLD'?'HUMAN_GOLD_TEST_ONLY':'RELATIVE_TO_PROVISIONAL_HUMAN_BASELINE');
  const geometry={astra:geometryCoverage(words,a),fable:geometryCoverage(words,b)};
  const reasons=[];
  if(a!==b)reasons.push('READER_DISAGREEMENT');
  if(humanFindings.counts.BOTH_MODELS_SAME_WRONG)reasons.push('POSSIBLE_SHARED_READER_ERROR');
  if(humanFindings.counts.HUMAN_GOLD_PENDING)reasons.push('HUMAN_GOLD_PENDING');
  if(geometry.astra.gaps.length||geometry.fable.gaps.length)reasons.push('GEOMETRY_COVERAGE_GAP');
  return {goldStatus:gold.status,baseline:gold.text,pendingSpans:gold.pendingSpans,
    humanVsAstra:comparisons(gold.text,a),humanVsFable:comparisons(gold.text,b),astraVsFable:comparisons(a,b),
    humanFindings,geometry,recommendedDiagnosticState:reviewState(page.status,reasons.length>0),
    reasons,runtimePolicyChanged:false,sourceTextMutated:false};
}
function reviewState(current,reviewRequired){return current==='MODEL_AGREED'&&reviewRequired?'OCR_UNCERTAIN':current;}
module.exports={sha,exportEvidence,tokens,align,diff,comparisons,classify,geometryCoverage,audit,reviewState};
