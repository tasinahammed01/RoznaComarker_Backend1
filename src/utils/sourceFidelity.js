'use strict';
const {createHash}=require('crypto');
const VERSION='astra-fable-exact-v1';
const GPT_VERSION=require('../services/gptVisionExact/contract').VERSION;
const PAGE_SEPARATOR='\n\n\f\n\n';
const sha=value=>createHash('sha256').update(value).digest('hex');
const isExact=doc=>['astra_verified','astra_human_confirm','gpt_vision_exact'].includes(doc?.sourceFidelityMode);
const requiresWholePage=doc=>doc?.sourceFidelityMode==='astra_human_confirm';
const ordered=doc=>(doc.ocrPages||[]).slice().sort((a,b)=>a.fileOrder-b.fileOrder||a.pageIndex-b.pageIndex);
const gptAccepted=p=>p.sourceFidelityMode==='gpt_vision_exact'&&['gpt-vision-exact-v1',GPT_VERSION].includes(p.sourceFidelityVersion)&&p.sourceFidelityStatus==='GPT_SOURCE_ACCEPTED';
const pageAccepted=p=>p.sourceFidelityStatus==='HUMAN_VERIFIED'&&p.sourceFidelityVersion==='human-source-v1'&&/^[a-f0-9]{64}$/.test(p.sourceHumanReceiptHash||'')&&p.sourceHumanReviewUnresolved===0
  ||p.sourceFidelityStatus==='MODEL_AGREED'&&(!['targeted-source-v2','targeted-source-v3','targeted-source-v4'].includes(p.sourceFidelityVersion)
  ||p.sourceVerificationSummary?.unresolvedTargetedCount===0&&['FIRST_PASS_MODEL_AGREED','TARGETED_MODEL_AGREED'].includes(p.sourceVerificationStage));
function aggregate(doc,failures=[]) {
  const pages=ordered(doc),text=pages.map(p=>p.sourceTextExact??'').join(PAGE_SEPARATOR);
  const identity=pages.map(p=>({fileId:String(p.fileId),fileOrder:p.fileOrder,pageIndex:p.pageIndex,
    pageNumber:p.pageNumber,input:p.sourceInputSha256,source:p.sourceSha256,version:p.sourceFidelityVersion,
    ...(p.sourceHumanReceiptHash?{humanReceipt:p.sourceHumanReceiptHash}:{})}));
  const urgent=requiresWholePage(doc)||pages.some(p=>requiresWholePage(p));
  if(doc.sourceFidelityMode==='gpt_vision_exact'||pages.some(p=>p.sourceFidelityMode==='gpt_vision_exact'))return {
    sourceFidelityMode:'gpt_vision_exact',sourceFidelityVersion:pages.length&&pages.every(p=>p.sourceFidelityVersion==='gpt-vision-exact-v1')?'gpt-vision-exact-v1':GPT_VERSION,sourceTranscriptExact:text,sourceTranscriptSha256:sha(text),
    sourceFidelityInputIdentity:sha(JSON.stringify(identity)),sourceFidelityStatus:pages.length&&!failures.length&&pages.every(gptAccepted)?'GPT_SOURCE_ACCEPTED':'PROVIDER_FAILED'};
  const accepted=p=>pageAccepted(p)&&(!urgent||p.sourceFidelityStatus==='HUMAN_VERIFIED'&&p.sourceVerificationStage==='PAGE_HUMAN_VERIFIED');
  const complete=pages.length>0&&!failures.length&&!doc.sourceHumanReviewSummary?.required&&pages.every(accepted);
  const human=pages.some(p=>p.sourceFidelityVersion==='human-source-v1');
  return {sourceFidelityMode:urgent?'astra_human_confirm':'astra_verified',sourceFidelityVersion:human?'human-source-v1':urgent?'astra-human-confirm-v1':pages.some(p=>p.sourceFidelityVersion==='targeted-source-v4')?'targeted-source-v4':pages.some(p=>p.sourceFidelityVersion==='targeted-source-v3')?'targeted-source-v3':pages.some(p=>p.sourceFidelityVersion==='targeted-source-v2')?'targeted-source-v2':VERSION,sourceTranscriptExact:text,
    sourceTranscriptSha256:sha(text),sourceFidelityInputIdentity:sha(JSON.stringify(identity)),
    sourceFidelityStatus:complete?(human?'HUMAN_VERIFIED':'MODEL_AGREED'):doc.sourceHumanReviewSummary?.required||urgent?'HUMAN_REVIEW_REQUIRED':pages.some(p=>p.sourceFidelityStatus==='PROVIDER_FAILED')?'PROVIDER_FAILED':'OCR_UNCERTAIN'};
}
function eligible(doc) {
  if(!isExact(doc))return true;
  const pages=ordered(doc), files=(doc.files?.length?doc.files:[doc.file]).filter(Boolean).map(x=>String(x?._id||x));
  return (!requiresWholePage(doc)||doc.sourceFidelityStatus==='HUMAN_VERIFIED')&&(doc.sourceFidelityMode==='gpt_vision_exact'?doc.sourceFidelityStatus==='GPT_SOURCE_ACCEPTED': ['MODEL_AGREED','HUMAN_VERIFIED'].includes(doc.sourceFidelityStatus))&&!doc.sourceHumanReviewSummary?.required&&pages.length>0&&pages.every(p=>(doc.sourceFidelityMode==='gpt_vision_exact'?gptAccepted(p):pageAccepted(p))
    &&(!requiresWholePage(doc)||p.sourceFidelityStatus==='HUMAN_VERIFIED'&&p.sourceVerificationStage==='PAGE_HUMAN_VERIFIED')
    &&typeof p.sourceTextExact==='string'&&sha(p.sourceTextExact)===p.sourceTextSha256)
    &&files.every(id=>pages.some(p=>String(p.fileId?._id||p.fileId)===id))
    &&pages.map(p=>p.sourceTextExact).join(PAGE_SEPARATOR)===doc.sourceTranscriptExact
    &&sha(doc.sourceTranscriptExact)===doc.sourceTranscriptSha256;
}
function payload(doc) {
  // This automatic mode uses the normal result/error UX. The existing source
  // review card specifically describes independent readers/teacher review.
  if(doc?.sourceFidelityMode==='gpt_vision_exact')return undefined;
  if(!isExact(doc))return undefined;
  return {mode:doc.sourceFidelityMode,status:doc.sourceFidelityStatus,version:doc.sourceFidelityVersion,
    transcriptExact:doc.sourceTranscriptExact??'',transcriptSha256:doc.sourceTranscriptSha256,
    pageSeparator:PAGE_SEPARATOR,assessmentAllowed:eligible(doc),
    ...(doc.sourceHumanReviewSummary?{humanReview:{required:Boolean(doc.sourceHumanReviewSummary.required),total:doc.sourceHumanReviewSummary.total||0,
      resolved:doc.sourceHumanReviewSummary.resolved||0,unresolved:doc.sourceHumanReviewSummary.unresolved||0,unavailable:doc.sourceHumanReviewSummary.unavailable||0}}:{}),
    pages:ordered(doc).map(p=>({fileId:String(p.fileId),pageNumber:p.pageNumber,pageIndex:p.pageIndex,
      status:p.sourceFidelityStatus,textExact:p.sourceTextExact??'',disagreementCount:p.sourceDisagreementCount||0,
      ...(p.sourceFidelityVersion==='human-source-v1'?{verificationStage:p.sourceVerificationStage}:{}),
      ...(['targeted-source-v2','targeted-source-v3','targeted-source-v4'].includes(p.sourceFidelityVersion)?{verificationStage:p.sourceVerificationStage,
        candidateCount:p.sourceVerificationSummary?.candidateRegionCount||0,
        unresolvedCandidateCount:p.sourceVerificationSummary?.unresolvedTargetedCount||0,
        candidateReasons:(p.sourceVerificationSummary?.candidateReasons||[]).slice(0,6)}:{} )}))};
}
function canonical(doc) {
  let text='';const pages=[],wordSpans=[];
  for(const p of ordered(doc)) {
    if(pages.length)text+=PAGE_SEPARATOR;
    const startChar=text.length,pageText=p.sourceTextExact??'';text+=pageText;
    // Exact literal, unique occurrence only. Google words remain geometry evidence, never source.
    const spans=[];const googleWords=Array.isArray(p.words)?p.words:[];
    for(const [index,w] of googleWords.entries()) {
      if(p.sourceFidelityMode==='gpt_vision_exact'){
        if(!Number.isInteger(w.sourceStart)||!Number.isInteger(w.sourceEnd)||w.sourceStart<0||w.sourceEnd<=w.sourceStart||w.sourceEnd>pageText.length||pageText.slice(w.sourceStart,w.sourceEnd)!==w.text)continue;
        const word={...w,fileId:String(p.fileId),page:p.pageNumber};
        spans.push({start:startChar+w.sourceStart,end:startChar+w.sourceEnd,word,wordId:word.id,bbox:word.bbox||null,fileId:String(p.fileId),page:p.pageNumber});continue;
      }
      const token=w.text;if(typeof token!=='string'||!token.length)continue;
      const start=pageText.indexOf(token);
      if(start<0||pageText.indexOf(token,start+1)!==-1||googleWords.filter(x=>x.text===token).length!==1)continue;
      const before=start>0?pageText[start-1]:'';const after=pageText[start+token.length]||'';
      if((/[\p{L}\p{N}]/u.test(token[0])&&/[\p{L}\p{N}]/u.test(before))
        ||(/[\p{L}\p{N}]/u.test(token.at(-1))&&/[\p{L}\p{N}]/u.test(after)))continue;
      const word={...w,id:w.id||`word_${p.fileId}_${p.pageNumber}_${index+1}`,fileId:String(p.fileId),page:p.pageNumber};
      spans.push({start:start+startChar,end:start+startChar+token.length,word,wordId:word.id,bbox:word.bbox,fileId:String(p.fileId),page:p.pageNumber});
    }
    spans.sort((a,b)=>a.start-b.start);let cursor=startChar;
    for(const s of spans){s.separatorBefore=text.slice(cursor,s.start);cursor=s.end;}
    wordSpans.push(...spans);
    pages.push({fileId:String(p.fileId),fileOrder:p.fileOrder,pageNumber:p.pageNumber,pageIndex:p.pageIndex,
      text:pageText,startChar,endChar:text.length,source:'sourceTextExact',words:spans.map(s=>({...s.word,separatorBefore:s.separatorBefore})),
      paragraphs:[],sourceTextSha256:p.sourceTextSha256,sourceFidelityVersion:p.sourceFidelityVersion,sourceInputSha256:p.sourceInputSha256});
  }
  return {text,pages,wordSpans,paragraphs:[],separators:wordSpans.map(s=>s.separatorBefore),source:'sourceTextExact',
    isComplete:eligible(doc),version:VERSION};
}
const blockedState=()=>({ocrStatus:'failed',ocrErrorCode:'OCR_SOURCE_REVIEW_REQUIRED',ocrError:'Source review required before assessment.',
  correctionStatus:'failed',semanticStatus:'failed',semanticErrorCode:'OCR_SOURCE_REVIEW_REQUIRED',semanticNextRetryAt:null,
  evaluationStatus:'blocked',evaluationErrorCode:'OCR_SOURCE_REVIEW_REQUIRED',assessmentStatus:'failed',assessmentErrorCode:'OCR_SOURCE_REVIEW_REQUIRED',
  writingCorrections:[],correctionStatistics:undefined,analysisNextRetryAt:null});
function assertUnchanged(previous,next) {
  if(previous?.sourceFidelityInputIdentity&&previous.sourceFidelityInputIdentity===next.sourceFidelityInputIdentity
    &&(previous.sourceTranscriptExact!==next.sourceTranscriptExact||previous.sourceTranscriptSha256!==next.sourceTranscriptSha256
      ||JSON.stringify((previous.ocrPages||[]).map(p=>[p.sourceTextExact,p.sourceTextSha256]))!==JSON.stringify((next.ocrPages||[]).map(p=>[p.sourceTextExact,p.sourceTextSha256]))))
    throw Object.assign(Error('OCR_SOURCE_IDENTITY_MUTATION'),{code:'OCR_SOURCE_IDENTITY_MUTATION'});
}
module.exports={VERSION,PAGE_SEPARATOR,sha,isExact,requiresWholePage,aggregate,eligible,payload,canonical,blockedState,assertUnchanged};
