'use strict';
// Optional second reader (OCR_GPT_VISION_SECOND_READER, off by default). After the primary reader's page is accepted, a cheap model
// from a different family (Qwen, plain-text prompt) reads the same image once. The words on which the two readings differ are stored
// for teacher review. It only FLAGS: it never blocks a page, never changes the graded text, and its failures are swallowed.
// Runs only on a fresh read (never on reused evidence), so a page is never read twice by the second model.
const MAX_WORDS=3000,MAX_STORED_DIFFERENCES=100,TIMEOUT_MS=45000;
const core=w=>w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu,'');
const wordsOf=lines=>lines.flatMap((text,line)=>String(text).split(/\s+/u).filter(Boolean).map(word=>({line,word,key:core(word)||word})));

/** Word-level alignment of the primary reading against the other. Reports the primary words the other reading did not confirm. */
function compare(primaryLines,otherLines){
  const a=wordsOf(primaryLines),b=wordsOf(otherLines);
  if(a.length>MAX_WORDS||b.length>MAX_WORDS)return {comparedWords:a.length,skipped:'TOO_LARGE'};
  const width=b.length+1,cost=new Uint16Array((a.length+1)*width);
  for(let j=1;j<=b.length;j++)cost[j]=j;
  for(let i=1;i<=a.length;i++){
    cost[i*width]=i;
    for(let j=1;j<=b.length;j++)cost[i*width+j]=Math.min(cost[(i-1)*width+j-1]+(a[i-1].key===b[j-1].key?0:1),cost[(i-1)*width+j]+1,cost[i*width+j-1]+1);
  }
  const differences=[];
  for(let i=a.length,j=b.length;i>0||j>0;){
    if(i>0&&j>0&&cost[i*width+j]===cost[(i-1)*width+j-1]+(a[i-1].key===b[j-1].key?0:1)){
      if(a[i-1].key!==b[j-1].key)differences.push({line:a[i-1].line,word:a[i-1].word,other:b[j-1].word});
      i--;j--;
    }else if(i>0&&cost[i*width+j]===cost[(i-1)*width+j]+1){differences.push({line:a[i-1].line,word:a[i-1].word,other:null});i--;}
    else j--;
  }
  differences.reverse();
  return {comparedWords:a.length,differingWords:differences.length,differences};
}

const activeLines=wire=>JSON.parse(wire).physicalLines.map(l=>l.segments.filter(s=>s.classification==='STUDENT_ACTIVE_TEXT').map(s=>s.text).join('')).filter(Boolean);

/**
 * Reads the page with the second model and compares. Always returns a result object (never throws):
 *   { model, status: 'compared', comparedWords, differingWords, differences } | { model, status: 'unavailable' } | { model, status: 'skipped', reason }
 */
async function run({model,bytes,mimeType,assignmentReference,primaryLines,questionLines=[],env,signal,fetchImpl=global.fetch,onDiagnostic}){
  const controller=new AbortController(),stop=()=>controller.abort();
  const timer=setTimeout(stop,TIMEOUT_MS);
  signal?.addEventListener('abort',stop,{once:true});
  try{
    const plain=require('./plainReader');
    const result=await plain.read({model,bytes,mimeType,env,signal:controller.signal,fetchImpl,onDiagnostic});
    // The plain prompt also copies the student's question; drop it the same way production does, using the first reader's question lines.
    const wire=plain.toWire(result.content,{...assignmentReference,...(questionLines.length?{question:questionLines.join(' ')}:{})});
    const outcome=compare(primaryLines,activeLines(wire));
    if(outcome.skipped)return {model,status:'skipped',reason:outcome.skipped};
    return {model,status:'compared',comparedWords:outcome.comparedWords,differingWords:outcome.differingWords,differences:outcome.differences.slice(0,MAX_STORED_DIFFERENCES)};
  }catch(error){
    // Content-free: the code only, never the message.
    try{require('../../utils/logger').warn({event:'gpt_second_reader_unavailable',model,errorCode:/^(AI_|OCR_)[A-Z0-9_]{1,75}$/.test(error?.code||'')?error.code:'UNKNOWN'});}catch{/* Diagnostics only. */}
    return {model,status:'unavailable'};
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',stop);}
}

module.exports={compare,run,TIMEOUT_MS};
