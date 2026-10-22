'use strict';
// Deterministic token alignment and exact character envelope. No provider/network dependency.
const VERSION = 'correction-edit-footprint-v1-exact-token-diff';
const WORD = /^[\p{L}\p{M}]+(?:['’\-][\p{L}\p{M}]+)*$/u;
const PREPOSITIONS = new Set('aboard about above across after against along amid among around as at before behind below beneath beside besides between beyond by despite down during except for from in inside into like near of off on onto opposite out outside over past per round since than through throughout till to toward towards under underneath unlike until up upon via with within without'.split(' '));
function tokens(text) {
 return [...text.matchAll(/[\p{L}\p{M}]+(?:['’\-][\p{L}\p{M}]+)*|\s+|[^\s]/gu)].map(m => ({ text: m[0], start: m.index, end: m.index + m[0].length }));
}
function characterEnvelope(source, suggestion, offset) {
 let left = 0, right = 0;
 while (left < source.length && left < suggestion.length && source[left] === suggestion[left]) left++;
 while (right < source.length-left && right < suggestion.length-left && source.at(-1-right) === suggestion.at(-1-right)) right++;
 return { start: offset+left, end: offset+source.length-right, source: source.slice(left, source.length-right), replacement: suggestion.slice(left, suggestion.length-right) };
}
function derive(source, suggestion, offset = 0, code) {
 const no = (reason, extra={}) => ({ version: VERSION, valid: false, reason, operativeEditSpan: null, components: [], ...extra });
 if (typeof source !== 'string' || typeof suggestion !== 'string' || source.length > 500 || suggestion.length > 300 || !Number.isInteger(offset) || offset < 0) return no('BOUNDED_EXACT_EDIT_REQUIRED');
 if (source === suggestion) return no('NO_OP_CORRECTION');
 const characterChange = characterEnvelope(source, suggestion, offset), a = tokens(source), b = tokens(suggestion), n = a.length, m = b.length;
 // Unit token costs keep an entire changed word intact (including spelling transpositions).
 const dp = Array.from({length:n+1},()=>new Uint16Array(m+1)), count = Array.from({length:n+1},()=>new Uint8Array(m+1));
 count[0][0]=1;
 for(let i=0;i<=n;i++)for(let j=0;j<=m;j++){
  if(!i&&!j)continue;
  const choices=[];
  if(i&&j)choices.push([dp[i-1][j-1]+(a[i-1].text===b[j-1].text?0:1),count[i-1][j-1]]);
  if(i)choices.push([dp[i-1][j]+1,count[i-1][j]]);
  if(j)choices.push([dp[i][j-1]+1,count[i][j-1]]);
  const best=Math.min(...choices.map(c=>c[0]));dp[i][j]=best;count[i][j]=Math.min(2,choices.filter(c=>c[0]===best).reduce((s,c)=>s+c[1],0));
 }
 if(count[n][m]!==1)return no('COMPLEX_OR_MULTI_EDIT',{detail:'AMBIGUOUS_TOKEN_ALIGNMENT',characterChange});
 const operations=[];let i=n,j=m;
 while(i||j){
  if(i&&j&&dp[i][j]===dp[i-1][j-1]+(a[i-1].text===b[j-1].text?0:1)){operations.push({kind:a[i-1].text===b[j-1].text?'equal':'replace',ai:i-1,bj:j-1});i--;j--;}
  else if(i&&dp[i][j]===dp[i-1][j]+1){operations.push({kind:'delete',ai:i-1,bj:j});i--;}
  else{operations.push({kind:'insert',ai:i,bj:j-1});j--;}
 }
 operations.reverse();const groups=[];let group=null;
 for(const op of operations){if(op.kind==='equal'){group=null;continue;}if(!group){group=[];groups.push(group);}group.push(op);}
 const components=groups.map(g=>{
  const old=g.filter(o=>o.kind!=='insert').map(o=>a[o.ai]), fresh=g.filter(o=>o.kind!=='delete').map(o=>b[o.bj]);
  const start=old.length?old[0].start:(a[g[0].ai]?.start??source.length),end=old.length?old.at(-1).end:start;
  return {start:offset+start,end:offset+end,source:source.slice(start,end),replacement:fresh.map(t=>t.text).join('')};
 });
 // RO explicitly permits one boundary punctuation edit plus its following case change.
 const roPair=code==='RO'&&components.length===2&&/^[,;.!?]*$/.test(components[0].source)&&/^[.;!?]+$/.test(components[0].replacement)
  &&/^\s+$/.test(source.slice(components[0].end-offset,components[1].start-offset))
  &&WORD.test(components[1].source)&&components[1].source!==components[1].replacement&&components[1].source.toLowerCase()===components[1].replacement.toLowerCase();
 if(components.length!==1&&!roPair)return no('COMPLEX_OR_MULTI_EDIT',{detail:'SEPARATED_EDIT_REGIONS',characterChange,components});
 const start=components[0].start,end=components.at(-1).end;
 const suffixLength=source.length-(end-offset),replacement=suggestion.slice(start-offset,suggestion.length-suffixLength);
 const edit={start,end,source:source.slice(start-offset,end-offset),replacement};
 if(source.slice(0,start-offset)+replacement+source.slice(end-offset)!==suggestion)return no('COMPLEX_OR_MULTI_EDIT',{detail:'EXACT_RECONSTRUCTION_FAILED',characterChange,components});
 const oldWords=tokens(edit.source).filter(t=>WORD.test(t.text)),newWords=tokens(edit.replacement).filter(t=>WORD.test(t.text));
 if(!roPair&&(oldWords.length>1||newWords.length>1))return no('COMPLEX_OR_MULTI_EDIT',{detail:'MULTIWORD_REWRITE',characterChange,components});
 return {version:VERSION,valid:true,reason:roPair?'EXPLICIT_RO_BOUNDARY_INTENT':'EXACT_SINGLE_EDIT',operativeEditSpan:edit,characterChange,components};
}
function validateShape(edit, code, transcript) {
 if(!edit.valid)return {valid:false,reasons:[edit.reason]};
 const e=edit.operativeEditSpan,reasons=[],caseOnly=e.source!==e.replacement&&e.source.toLowerCase()===e.replacement.toLowerCase();
 if(e.source===e.replacement)reasons.push('NO_OP_CORRECTION');
 if(code==='SP'||code==='CAP'){
  if(!WORD.test(e.source)||!WORD.test(e.replacement)||/[\p{L}\p{M}]/u.test(transcript[e.start-1]||'')||/[\p{L}\p{M}]/u.test(transcript[e.end]||''))reasons.push('COMPLETE_OPERATIVE_WORD_REQUIRED');
  if(code==='SP'&&caseOnly)reasons.push('CASE_CHANGE_REQUIRES_CAP');
  if(code==='CAP'&&!caseOnly)reasons.push('CAP_NOT_CASE_ONLY');
 }
 if(code==='PREP'){
  const old=e.source.trim(),fresh=e.replacement.trim();
  if((old&&!PREPOSITIONS.has(old.toLowerCase()))||(fresh&&!PREPOSITIONS.has(fresh.toLowerCase()))||(!old&&!fresh))reasons.push('PREPOSITION_TOKEN_EDIT_REQUIRED');
 }
 if(code==='RO'){
  const old=(e.source.match(/[.!?;,]/g)||[]).join(''),fresh=(e.replacement.match(/[.!?;,]/g)||[]).join('');
  if(old===fresh||!/[.!?;]/.test(e.replacement))reasons.push('RO_MATERIAL_BOUNDARY_CHANGE_REQUIRED');
  if(/[.!?]\s+\p{Ll}/u.test(e.replacement+transcript.slice(e.end)))reasons.push('RO_COMPLETE_CAPITALIZATION_REQUIRED');
 }
 return {valid:!reasons.length,reasons};
}
module.exports={VERSION,derive,validateShape,tokens};
