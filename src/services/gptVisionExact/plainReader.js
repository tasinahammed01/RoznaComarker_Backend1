'use strict';
// Plain-first Qwen source reader (OCR_GPT_VISION_READER=plain_text). One call returns the transcription as plain
// text; code converts it to the existing Qwen physical-source wire JSON, so the unchanged validators, preflight,
// claims, cache, geometry alignment and annotations see the same canonical evidence as from the JSON reader.
// The prompt is the one the acceptance gate measured (scripts/ocr-eval prompt mode plain-first); keep them equal.
const {createHash}=require('crypto');
const JSON_READER='json_contract',PLAIN_READER='plain_text',READER_MODES=[JSON_READER,PLAIN_READER];
const VERSION='qwen-plain-reader-v1';
const REQUEST_PROFILE='gpt_vision_exact_plain_v1';
const PROMPT=`You are a forensic handwriting transcription reader. You are never a grader, editor, proofreader or writer.
Transcribe the student's handwriting on the supplied page exactly as it is physically written.
1. Reproduce every word exactly as written. Preserve spelling mistakes, capitalisation and lowercase errors, punctuation, quotation marks, repeated words, grammatical mistakes, awkward wording, wrong prepositions and incomplete sentences. Never correct, normalise, complete, modernise or paraphrase anything. Example: "powerfull" stays "powerfull"; "Society always expect" stays "Society always expect"; a lowercase "i" stays "i".
2. Visual evidence outranks English plausibility. Never use grammar or meaning to decide what a word is, never guess a word from context and never fill in missing words.
3. Include only the student's handwritten text. Include the student's own handwritten copy of the question if the page has one. Exclude printed header or template text, name and date fields, teacher marks, watermarks and camera branding.
4. Handwriting that is crossed out or scribbled over is deleted: leave it out. If the student wrote a replacement, transcribe the replacement.
5. Keep the physical line breaks: start a new line wherever the handwriting starts a new line. Do not add or remove spaces inside a line.
6. If a word is hard to read, give your best literal reading of the visible strokes. Only if a word is genuinely unreadable, so that you cannot identify its letters, write [?] in its place. Never use [?] for a word that is merely messy, misspelled or oddly chosen, and never leave a word out.
7. Output ONLY the transcription as plain text: no preamble, no notes, no markdown, no quotation marks around the text, and no corrections or suggestions.`;
const USER_TEXT="Transcribe the student's handwriting on this page exactly as written.";
const MAX_SEGMENT=2000;
const UNCERTAIN_TOKEN=/(\S*\[\?\]\S*)/u;
const sha=value=>createHash('sha256').update(value).digest('hex');
// The assignment reference is not sent to the model; it only drives the copied-question rule, so it is bound here.
const promptSha256=assignmentReference=>sha(`${VERSION}\n${PROMPT}\n${USER_TEXT}\n${JSON.stringify(assignmentReference)}`);

async function read({model,bytes,mimeType,env,signal,onDiagnostic,onObservation,fetchImpl=global.fetch}){
  const contract=require('./contract');
  return require('../aiGateway.service').providerAttempt({entry:{provider:'openrouter',model},messages:[{role:'system',content:PROMPT},
    {role:'user',content:[{type:'text',text:USER_TEXT},{type:'image_url',image_url:{url:`data:${mimeType};base64,${bytes.toString('base64')}`}}]}],
    ...contract.requestPolicy(env),temperature:0,responseFormat:'text',
    fetchImpl:typeof onObservation==='function'?(url,options)=>{
      try{onObservation({qwenInvoked:model===contract.QWEN_MODEL});}catch{/* Observation only. */}
      return fetchImpl(url,options);
    }:fetchImpl,env,now:Date.now,signal,requestProfile:REQUEST_PROFILE,onDiagnostic});
}

/** Removes ONE markdown fence wrapping the whole reply, as the measured harness did. Nothing else is altered. */
function stripFence(content){
  const match=/^\s*```[A-Za-z0-9_-]*\r?\n([\s\S]*?)\r?\n?```\s*$/u.exec(content);
  return match?match[1]:content;
}
/** Code-point-safe pieces within the per-segment schema limit. */
function pieces(text){
  const out=[];let current='';
  for(const ch of text){if(current.length+ch.length>MAX_SEGMENT){out.push(current);current='';}current+=ch;}
  if(current)out.push(current);
  return out;
}
function activeSegments(line){
  const parts=line.split(UNCERTAIN_TOKEN),segments=[];// odd indexes are [?] tokens
  parts.forEach((part,i)=>{
    if(i%2===1){segments.push({classification:'UNCERTAIN',text:part.split('[?]').join('')||null,confidence:0});return;}
    let text=part;
    if(i>0)text=text.replace(/^\s+/u,'');
    if(i<parts.length-1)text=text.replace(/\s+$/u,'');
    if(!text)return;
    // Exactly one space separates readable words on either side of a removed [?] token.
    if(i>0&&segments.some(s=>s.classification==='STUDENT_ACTIVE_TEXT'))text=` ${text}`;
    for(const piece of pieces(text))segments.push({classification:'STUDENT_ACTIVE_TEXT',text:piece,confidence:1});
  });
  return segments;
}

// Copied-question rule. Today's JSON reader excludes a handwritten copy of the question as PROMPT_OR_INSTRUCTION;
// the plain reader transcribes it, so code excludes it by matching against the stored assignment text. Only the
// leading lines of a page are considered, and matching stops at the first line that is not part of the copy.
const MIN_COPY_WORDS=3,MIN_MATCH_RATIO=.8,MAX_COPY_LINES=12;
const words=text=>String(text).normalize('NFKC').toLowerCase().replace(/[‘’]/gu,"'").split(/\s+/u)
  .map(w=>w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu,'')).filter(Boolean);
function withinOneEdit(a,b){
  if(Math.abs(a.length-b.length)>1)return false;
  let i=0,j=0,edits=0;
  while(i<a.length&&j<b.length){
    if(a[i]===b[j]){i++;j++;continue;}
    if(++edits>1)return false;
    if(a.length>b.length)i++;else if(b.length>a.length)j++;else{i++;j++;}
  }
  return edits+(a.length-i)+(b.length-j)<=1;
}
// Handwritten copies carry spelling slips: words of 4+ letters may differ by one edit.
const sameWord=(a,b)=>a===b||Math.min(a.length,b.length)>=4&&withinOneEdit(a,b);
function lcs(a,b){
  let previous=new Array(b.length+1).fill(0);
  for(let i=1;i<=a.length;i++){
    const row=new Array(b.length+1).fill(0);
    for(let j=1;j<=b.length;j++)row[j]=sameWord(a[i-1],b[j-1])?previous[j-1]+1:Math.max(previous[j],row[j-1]);
    previous=row;
  }
  return previous[b.length];
}
/** Most line words matched, in order, inside any contiguous stretch of one reference field (line length + 2). */
function bestMatch(lineWords,fields){
  let best=0;
  for(const field of fields)for(let start=0;start<field.length&&best<lineWords.length;start++){
    if(!lineWords.some(w=>sameWord(w,field[start])))continue;
    best=Math.max(best,lcs(lineWords,field.slice(start,start+lineWords.length+2)));
  }
  return best;
}
function copiedQuestionLineCount(lines,assignmentReference){
  const fields=Object.values(assignmentReference||{}).filter(v=>typeof v==='string').map(words).filter(f=>f.length);
  if(!fields.length)return 0;
  let count=0,previous=null;
  for(const line of lines.slice(0,MAX_COPY_LINES)){
    const lineWords=words(line);
    if(!lineWords.length)break;
    const matched=bestMatch(lineWords,fields);
    const copy=lineWords.length>=MIN_COPY_WORDS&&matched/lineWords.length>=MIN_MATCH_RATIO
      // A short line is excluded only as a whole reference field (a title) or as the tail of the copy above it.
      ||fields.some(f=>f.length>=2&&f.length===lineWords.length&&f.every((w,k)=>sameWord(w,lineWords[k])))
      ||previous&&bestMatch([...previous,...lineWords],fields)>=bestMatch(previous,fields)+lineWords.length;
    if(!copy)break;
    count++;previous=lineWords;
  }
  return count;
}

/** Plain transcription -> Qwen physical-source wire JSON (string), validated afterwards by contract.validateWire. */
function toWire(content,assignmentReference={}){
  const {QWEN_WIRE_VERSION}=require('./contract');
  const lines=String(stripFence(String(content))).split(/\r?\n/u).map(l=>l.replace(/[\r\n\f\u0000]/gu,' ').trim()).filter(Boolean);
  const copied=copiedQuestionLineCount(lines,assignmentReference),physicalLines=[],uncertainties=[];
  lines.forEach((line,index)=>{
    const lineIndex=physicalLines.length;
    if(index<copied){
      physicalLines.push({segments:pieces(line).map(text=>({classification:'PROMPT_OR_INSTRUCTION',text,confidence:1}))});
      if(line.includes('[?]'))uncertainties.push({lineIndex,segmentIndex:0,kind:'NON_ACTIVE_PROMPT_UNCERTAIN',reason:'Unreadable word in the copied question ([?]).'});
      return;
    }
    const segments=activeSegments(line);
    if(!segments.length)return;
    segments.forEach((s,segmentIndex)=>{if(s.classification==='UNCERTAIN')
      uncertainties.push({lineIndex,segmentIndex,kind:'ACTIVE_TEXT_UNCERTAIN',reason:'Marked unreadable by the reader ([?]).'});});
    physicalLines.push({segments});
  });
  return JSON.stringify({version:QWEN_WIRE_VERSION,physicalLines,uncertainties});
}

module.exports={JSON_READER,PLAIN_READER,READER_MODES,VERSION,REQUEST_PROFILE,PROMPT,USER_TEXT,promptSha256,read,toWire,stripFence};
