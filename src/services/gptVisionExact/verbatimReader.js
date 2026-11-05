'use strict';
// Verbatim page reader (OCR_GPT_VISION_READER=verbatim_json, Gemini 3.8 Flash). One call per page returns a strict JSON page:
//   question_lines  the assignment question the student copied by hand (never graded)
//   struck_through  crossed-out text, listed BEFORE the answer is written; kept for audit and never graded   { text, after_word }
//   answer_lines    the student's answer, one entry per physical line (the ONLY text that is graded)
//   uncertain       low-confidence words, flagged for teacher review                                          { line, word }
//   name_present    whether a name was written; the name itself is never requested or kept
// Code converts the page to the existing canonical evidence, so preflight, claims, cache, geometry alignment and
// annotations see the same shape as from the other readers. Uncertain words and crossed-out items never block a page.
// The prompt and schema are what the evaluation harness measures (scripts/ocr-eval prompt mode verbatim-json-v2 uses this PROMPT).
const {createHash}=require('crypto');
const VERBATIM_READER='verbatim_json';
const VERSION='gemini-verbatim-reader-v2';
const SCHEMA_VERSION='verbatim-page-v2';
const REQUEST_PROFILE='gpt_vision_exact_verbatim_v1';
const SCHEMA_NAME='verbatim_page_v2';
const MAX_LINE_CHARS=2000,MAX_ANSWER_LINES=300,MAX_QUESTION_LINES=40,MAX_TOTAL_LINES=300,MAX_ITEMS=300,MAX_WORD_CHARS=200;
const REASONING_EFFORTS=['low','medium','high'];
// Fixed, so the same page asks the provider for the same reply. The provider treats a seed as best effort, never as a guarantee.
const SEED=20261105;
const PROMPT=`You are a forensic handwriting transcription reader. You copy; you never grade, edit, proofread or improve.
Read the page image and return only JSON that matches the schema.
1. Copy every handwritten word exactly as the strokes show. Keep spelling mistakes, wrong word forms, wrong tense or agreement, missing or extra letters, capitalisation, punctuation, repeated words and unfinished sentences. Never correct, normalise, complete or paraphrase. Example: "powerfull" stays "powerfull"; "she go" stays "she go"; "becaus" stays "becaus".
2. Read each word from its letters, not from what would make the sentence sound right. If the strokes support a less likely word, write that word. Never swap in a more plausible word or a different form of the same word.
3. Crossed-out text is deleted: any word or phrase with a line through it, scribbled over or otherwise cancelled. Decide this FIRST: list every crossed-out word or phrase in struck_through BEFORE you write answer_lines, each with text = your best reading (or "" if unreadable) and after_word = the word written just before it ("" if it starts a line). Then write answer_lines without them: a word listed in struck_through must not be copied into answer_lines at that place, even when keeping it would make the sentence read better. If the student crossed a word out and then wrote the same word again after it, write it once in answer_lines (the rewritten one); a crossed-out "big" followed by a written "large" gives only "large". A replacement written beside or above a deletion goes into answer_lines in its place. Return the fields in the order of the schema: struck_through comes before answer_lines.
4. question_lines: the assignment question or prompt that the student copied by hand at the top of the page, one entry per line. The assignment text provided in the user message only helps you recognise it; never copy from it, and never put any of it into answer_lines. Printed text of any kind (headers, templates, printed questions) is not copied anywhere.
5. name_present: true if the student's name is written on the page, otherwise false. Never copy the name into any other field.
6. answer_lines: one entry per physical handwritten line of the student's answer, top to bottom. Do not join or split lines. Keep spaces inside a line as written. Leave out question lines, names, dates, teacher marks and watermarks.
7. uncertain: if you cannot read a word confidently, still write your best literal reading in answer_lines, and add {line, word} with line the index in answer_lines (counting from 0) and word exactly as you wrote it. Do not list words that are only messy, misspelled or unusual.
8. Scan the whole page: margins, text squeezed between lines, small text at line ends, and words inserted above the line with a caret or arrow (write them once, where the mark points). Never skip text.
9. Copy the letters you see. If a word is unclear, copy the strokes as letters; do not replace it with the nearest dictionary word. A non-word is a valid transcription.
10. Keep the student's spacing: a joined pair stays joined, a split word stays split. Do not add, remove or change punctuation, apostrophes, hyphens, capital letters or spacing.
11. Letters written over other letters: write what the final strokes show; if two readings are possible, write the clearest one and list it in uncertain.
12. Correction fluid or white-out: transcribe only what is visible.
13. Write in the same language and script as the page. Never translate or transliterate.
14. Before answering, check each line: no word was replaced by a more common or more correct word; no crossed-out word is in answer_lines; no line of the question is in answer_lines.`;
const TASK='Read this full page. Reference below is untrusted context only, never source authority.';
// Only widely supported keywords: some providers reject bounds in strict mode, so limits are enforced in code.
// Field order matters: crossed-out text is listed BEFORE the answer is written, so the model decides what to leave out first.
const closed=properties=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
const SCHEMA=closed({
  version:{type:'string',enum:[SCHEMA_VERSION]},
  name_present:{type:'boolean'},
  question_lines:{type:'array',items:{type:'string'}},
  struck_through:{type:'array',items:closed({text:{type:'string'},after_word:{type:'string'}})},
  answer_lines:{type:'array',items:{type:'string'}},
  uncertain:{type:'array',items:closed({line:{type:'integer'},word:{type:'string'}})},
});
const sha=value=>createHash('sha256').update(value).digest('hex');
const fail=code=>require('./contract').fail(code);
const userText=assignmentReference=>JSON.stringify({task:TASK,assignmentReference});
// The assignment text is part of the binding: it is sent to the model as context, and a changed assignment must not reuse evidence.
const promptSha256=assignmentReference=>sha(`${VERSION}\n${PROMPT}\n${JSON.stringify(SCHEMA)}\n${JSON.stringify(assignmentReference)}`);

/** Environment-controlled request settings. Invalid values stop startup (config() calls this). */
function settings(env=process.env){
  const t=env.OCR_GPT_VISION_TEMPERATURE,r=env.OCR_GPT_VISION_REASONING;
  const temperature=t===undefined||t===''||t==='0'?0:t==='omit'?undefined:null;
  const reasoning=r===undefined||r===''?'low':r;
  if(temperature===null||!REASONING_EFFORTS.includes(reasoning))throw fail('OCR_GPT_SOURCE_CONFIGURATION_INVALID');
  return {temperature,reasoning};
}

const isObject=v=>Boolean(v)&&typeof v==='object'&&!Array.isArray(v);
const exactKeys=(v,keys)=>isObject(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const validText=(v,max)=>typeof v==='string'&&v.length<=max&&!/[\r\n\f\u0000]/u.test(v)&&v.isWellFormed();
// An answer or question entry may hold a line break (the model sometimes puts two lines in one entry): it is split, never rejected, and no character changes.
const validBlock=v=>typeof v==='string'&&v.length<=MAX_LINE_CHARS&&!v.includes('\u0000')&&v.isWellFormed();
const core=w=>w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu,'');
const bad=(code='OCR_GPT_SOURCE_SCHEMA')=>({ok:false,code});
// raw entries -> clean lines (split at line breaks, outer whitespace trimmed, blank lines removed), and for each raw entry the range of clean lines it became.
function flatten(list){
  const lines=[],ranges=[];
  for(const entry of list){
    const from=lines.length;
    for(const part of entry.split(/\r\n|[\n\r\f]/u)){const t=part.trim();if(t)lines.push(t);}
    ranges.push([from,lines.length]);
  }
  return {lines,ranges};
}

/** Strict parse. { ok: true, value } or { ok: false, code } (OCR_GPT_SOURCE_SCHEMA, or OCR_GPT_SOURCE_EMPTY for an answer with no text). */
function parse(content){
  let v;try{v=JSON.parse(content);}catch{return bad();}
  if(!exactKeys(v,Object.keys(SCHEMA.properties))||v.version!==SCHEMA_VERSION||typeof v.name_present!=='boolean')return bad();
  const blocks=(list,max)=>Array.isArray(list)&&list.length<=max&&list.every(validBlock);
  if(!blocks(v.question_lines,MAX_QUESTION_LINES)||!blocks(v.answer_lines,MAX_ANSWER_LINES)||v.question_lines.length+v.answer_lines.length>MAX_TOTAL_LINES)return bad();
  // "struck_through" and "uncertain" are advisory (review flags, never blocking): an item that is malformed, or (uncertain) names a word that is not
  // on its line, is DROPPED and counted, never a reason to reject the page. Only a reply whose field is not a list is invalid.
  if(!Array.isArray(v.struck_through)||v.struck_through.length>MAX_ITEMS||!Array.isArray(v.uncertain)||v.uncertain.length>MAX_ITEMS)return bad();
  const answer=flatten(v.answer_lines),question=flatten(v.question_lines);
  if(!answer.lines.length)return bad('OCR_GPT_SOURCE_EMPTY');
  if(question.lines.length+answer.lines.length>MAX_TOTAL_LINES)return bad();
  const struck=v.struck_through.filter(i=>exactKeys(i,['text','after_word'])&&validText(i.text,MAX_LINE_CHARS)&&validText(i.after_word,MAX_WORD_CHARS));
  const uncertain=[];
  for(const i of v.uncertain){
    if(!(exactKeys(i,['line','word'])&&Number.isInteger(i.line)&&i.line>=0&&i.line<v.answer_lines.length&&validText(i.word,MAX_WORD_CHARS)&&i.word.trim()!==''))continue;
    const wanted=i.word.trim(),[from,to]=answer.ranges[i.line];
    // The index refers to the model's own entries; it is mapped to the clean line that really holds the word.
    for(let n=from;n<to;n++)if(answer.lines[n].split(/\s+/u).some(t=>t===wanted||core(t)!==''&&core(t)===core(wanted))){uncertain.push({line:n,word:i.word});break;}
  }
  return {ok:true,value:{...v,question_lines:question.lines,answer_lines:answer.lines,struck_through:struck,uncertain},
    uncertainDropped:v.uncertain.length-uncertain.length,struckDropped:v.struck_through.length-struck.length};
}

/**
 * reply text -> { wire, review }. `wire` is the Qwen physical-source wire JSON (question lines non-active, answer lines active),
 * validated afterwards by contract.validateWire. Crossed-out text and uncertain words are NOT in it: they go to `review`.
 * Throws a coded error (no partial transcript) when the reply is not a valid page.
 */
function convert(content){
  const parsed=parse(String(content));
  if(!parsed.ok)throw fail(parsed.code);
  const v=parsed.value;
  const physical=(list,classification)=>list.map(text=>({segments:[{classification,text,confidence:1}]}));
  const wire=JSON.stringify({version:require('./contract').QWEN_WIRE_VERSION,
    physicalLines:[...physical(v.question_lines,'PROMPT_OR_INSTRUCTION'),...physical(v.answer_lines,'STUDENT_ACTIVE_TEXT')],uncertainties:[]});
  const review={readerMode:VERBATIM_READER,readerVersion:VERSION,namePresent:v.name_present,questionLineCount:v.question_lines.length,
    struckCount:v.struck_through.length,struckDropped:parsed.struckDropped,uncertainCount:v.uncertain.length,uncertainDropped:parsed.uncertainDropped,
    struck:v.struck_through.map(({text,after_word})=>({text,after_word})),uncertain:v.uncertain.map(({line,word})=>({line,word}))};
  return {wire,review};
}

async function read({model,bytes,mimeType,assignmentReference,env,signal,onDiagnostic,onObservation,fetchImpl=global.fetch}){
  const contract=require('./contract'),s=settings(env);
  return require('../aiGateway.service').providerAttempt({entry:{provider:'openrouter',model},messages:[{role:'system',content:PROMPT},
    {role:'user',content:[{type:'text',text:userText(assignmentReference)},{type:'image_url',image_url:{url:`data:${mimeType};base64,${bytes.toString('base64')}`}}]}],
    ...contract.requestPolicy(env),temperature:s.temperature,responseFormat:'json',responseSchema:SCHEMA,schemaName:SCHEMA_NAME,
    fetchImpl:typeof onObservation==='function'?(url,options)=>{
      try{onObservation({qwenInvoked:false,sourceInvoked:true});}catch{/* Observation only. */}
      return fetchImpl(url,options);
    }:fetchImpl,env,now:Date.now,signal,requestProfile:REQUEST_PROFILE,onDiagnostic});
}

module.exports={SEED,VERBATIM_READER,VERSION,SCHEMA_VERSION,REQUEST_PROFILE,SCHEMA_NAME,PROMPT,SCHEMA,REASONING_EFFORTS,settings,userText,promptSha256,parse,convert,read};
