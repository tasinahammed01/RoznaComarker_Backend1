'use strict';
const {sha}=require('./contract');
const normalized=s=>s.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu,'');
function near(a,b){
  if(!a||!b||Math.max(a.length,b.length)>64)return false;
  let row=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=1;i<=a.length;i++){const next=[i];for(let j=1;j<=b.length;j++)next[j]=Math.min(next[j-1]+1,row[j]+1,row[j-1]+(a[i-1]===b[j-1]?0:1));row=next;}
  return row[b.length]<=1&&Math.min(a.length,b.length)>=4;
}
function alignGeometry(text,google,identity){
  let cursor=0;
  const tokens=[...text.matchAll(/\S+/gu)].map((m,i)=>{
    const separatorBefore=text.slice(cursor,m.index);cursor=m.index+m[0].length;
    return {text:m[0],sourceStart:m.index,sourceEnd:cursor,separatorBefore,fileId:String(identity.fileId),
      id:`word_${identity.fileId}_${identity.pageNumber}_gpt_${i+1}`,page:identity.pageNumber,bbox:null};
  });
  let layout;try{layout=require('../../utils/ocrTranscriptNormalizer').buildHandwritingGeometryTranscript(google?.words||[]);}catch{/* Mapping is optional. */}
  const geometry=!layout?.layoutDegraded?(layout?.spans||[]).map(s=>({...s.word,line:layout.text.slice(0,s.start).split('\n').length})):[];
  if(tokens.length*geometry.length<=2000000&&geometry.length){
    const a=geometry.map((w,i)=>({text:normalized(w.text)||w.text,index:i})),b=tokens.map((w,i)=>({text:normalized(w.text)||w.text,index:i}));
    const ops=require('../sourceFidelity/exactEvidence').align(a,b);
    const frequency=list=>{const counts=new Map();for(const v of list)counts.set(v.text,(counts.get(v.text)||0)+1);return counts;};
    const ga=frequency(a),gb=frequency(b);
    const contextFrequency=list=>{const counts=new Map();for(let i=1;i<list.length-1;i++){const key=JSON.stringify([list[i-1].text,list[i+1].text]);counts.set(key,(counts.get(key)||0)+1);}return counts;};
    const ca=contextFrequency(a),cb=contextFrequency(b);
    const exact=o=>o?.left&&o?.right&&!o.ambiguous&&o.left.text===o.right.text;
    for(let i=0;i<ops.length;i++){
      const o=ops[i];if(!o.left||!o.right||o.ambiguous)continue;
      const before=ops[i-1],after=ops[i+1],g=geometry[o.left.index],token=tokens[o.right.index];
      const sameLineAnchors=exact(before)&&exact(after)&&geometry[before.left.index].line===g.line&&geometry[after.left.index].line===g.line
        &&text.slice(tokens[before.right.index].sourceStart,token.sourceEnd).indexOf('\n')<0&&text.slice(token.sourceStart,tokens[after.right.index].sourceEnd).indexOf('\n')<0;
      const contextKey=sameLineAnchors?JSON.stringify([before.left.text,after.left.text]):null;
      const provenContext=sameLineAnchors&&ca.get(contextKey)===1&&cb.get(contextKey)===1;
      const punctuationMismatch=/^[\p{P}\p{S}]+$/u.test(token.text)&&/^[\p{N}\p{P}\p{S}]+$/u.test(g.text);
      if(exact(o)&&(ga.get(o.left.text)===1&&gb.get(o.right.text)===1||provenContext)||provenContext&&(near(o.left.text,o.right.text)||punctuationMismatch)){
        token.bbox=g.bbox||null;token.geometryWordId=g.id||null;
      }
    }
  }
  return {words:tokens,coverage:tokens.length?tokens.filter(w=>w.bbox).length/tokens.length:0,textSha256:sha(text)};
}
module.exports={alignGeometry};
