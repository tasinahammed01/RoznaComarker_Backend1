'use strict';
const {createHash}=require('crypto');
const sha=v=>createHash('sha256').update(v).digest('hex');
const fail=code=>Object.assign(Error(code),{code});
function tokens(text,unit='word'){
  const pattern=unit==='character'?/[\s\S]/gu:unit==='line'?/[^\n]*\n|[^\n]+$/gu:/\s+|[\p{L}\p{M}\p{N}]+|[^\s\p{L}\p{M}\p{N}]/gu;
  return [...text.matchAll(pattern)].map(m=>({text:m[0],start:m.index,end:m.index+m[0].length}));
}
function align(a,b){
  const n=a.length,m=b.length;if((n+1)*(m+1)>8000000)throw fail('AUDIT_DIFF_LIMIT');
  const rows=Array.from({length:n+1},()=>new Uint32Array(m+1));
  for(let i=0;i<=n;i++)rows[i][m]=n-i;for(let j=0;j<=m;j++)rows[n][j]=m-j;
  for(let i=n-1;i>=0;i--)for(let j=m-1;j>=0;j--)rows[i][j]=Math.min(rows[i+1][j]+1,rows[i][j+1]+1,rows[i+1][j+1]+(a[i].text===b[j].text?0:1));
  let i=0,j=0;const ops=[];
  while(i<n||j<m){
    const diagonal=i<n&&j<m&&rows[i][j]===rows[i+1][j+1]+(a[i].text===b[j].text?0:1);
    const deletion=i<n&&rows[i][j]===rows[i+1][j]+1,insertion=j<m&&rows[i][j]===rows[i][j+1]+1;
    const ambiguous=Number(diagonal)+Number(deletion)+Number(insertion)>1;
    if(diagonal)ops.push({left:a[i++],right:b[j++],ambiguous});
    else if(deletion)ops.push({left:a[i++],right:null,ambiguous});
    else ops.push({left:null,right:b[j++],ambiguous});
  }
  return ops;
}
function category(left,right){
  if(left===right)return 'EXACT';if(!left)return 'INSERTION';if(!right)return 'DELETION';
  if(/^\s+$/u.test(left)||/^\s+$/u.test(right))return 'WHITESPACE';
  if(left.toLowerCase()===right.toLowerCase())return 'CAPITALIZATION_ONLY';
  if(/^[\p{P}\p{S}]+$/u.test(left)||/^[\p{P}\p{S}]+$/u.test(right))return 'PUNCTUATION';
  return 'LEXICAL_SUBSTITUTION';
}
function diff(left,right,unit='word'){
  const operations=align(tokens(left,unit),tokens(right,unit)).map(o=>({...o,category:category(o.left?.text??'',o.right?.text??'')}));
  const hunks=[];let pending=null,l=0,r=0;
  for(const o of operations){if(o.category==='EXACT'){if(pending){hunks.push(pending);pending=null;}}
    else {if(!pending)pending={start:l,end:l,rightStart:r,rightEnd:r,left:'',right:'',categories:[],ambiguous:false};
      pending.left+=o.left?.text??'';pending.right+=o.right?.text??'';pending.end=l+(o.left?.text.length||0);pending.rightEnd=r+(o.right?.text.length||0);
      if(!pending.categories.includes(o.category))pending.categories.push(o.category);pending.ambiguous ||=o.ambiguous;}
    l+=o.left?.text.length||0;r+=o.right?.text.length||0;
  }if(pending)hunks.push(pending);
  if(operations.map(o=>o.left?.text??'').join('')!==left||operations.map(o=>o.right?.text??'').join('')!==right)throw fail('AUDIT_DIFF_RECONSTRUCTION');
  return {unit,caseSensitive:true,normalization:'NONE',leftSha256:sha(left),rightSha256:sha(right),
    differenceCount:hunks.length,editOperationCount:operations.filter(o=>o.category!=='EXACT').length,hunks,operations};
}
function geometryCoverage(words,reader){
  const boxes=words.map((w,index)=>{const points=w.polygon||[];const valid=points.filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y));
    const bbox=valid.length?{x:Math.min(...valid.map(p=>p.x)),y:Math.min(...valid.map(p=>p.y)),
      w:Math.max(...valid.map(p=>p.x))-Math.min(...valid.map(p=>p.x)),h:Math.max(...valid.map(p=>p.y))-Math.min(...valid.map(p=>p.y))}
      :w.bbox?{x:w.bbox.x0,y:w.bbox.y0,w:w.bbox.x1-w.bbox.x0,h:w.bbox.y1-w.bbox.y0}:null;
    return {...w,index,bbox};}).filter(w=>w.bbox&&w.bbox.w>0&&w.bbox.h>0);
  const lines=[];
  for(const box of boxes){let line=lines.at(-1);const center=box.bbox.y+box.bbox.h/2;
    if(!line||line.paragraphIndex!==box.paragraphIndex||Math.abs(line.center-center)>Math.max(line.height,box.bbox.h)*0.65){line={id:lines.length+1,paragraphIndex:box.paragraphIndex,center,height:box.bbox.h,words:[]};lines.push(line);}
    line.words.push(box);line.center=line.words.reduce((n,w)=>n+w.bbox.y+w.bbox.h/2,0)/line.words.length;
  }
  const readerTokens=tokens(reader).filter(t=>!/\s/u.test(t.text));
  // Compatible lexical/punctuation segmentation prevents a comma-only Google
  // box from looking like an omitted reader word ("wemen," vs "wemen", ",").
  const geometryTokens=boxes.flatMap(w=>tokens(w.text||'').filter(t=>!/\s/u.test(t.text)).map(t=>({...t,word:w})));
  const ops=align(geometryTokens,readerTokens),gaps=[];
  const occupied=new Set(ops.filter(o=>o.left&&o.right).map(o=>o.left.word.id));
  const lexicalExact=o=>o?.left&&o?.right&&o.left.text===o.right.text&&/[\p{L}\p{N}]/u.test(o.left.text);
  let index=0;
  while(index<ops.length){if(ops[index].left&& !ops[index].right){const start=index;while(index<ops.length&&ops[index].left&&!ops[index].right)index++;
      const missing=[...new Map(ops.slice(start,index).map(o=>[o.left.word.id,o.left.word])).values()].filter(w=>!occupied.has(w.id)&&/[\p{L}\p{N}]/u.test(w.text));
      if(!missing.length)continue;
      const before=ops.slice(0,start).reverse().find(lexicalExact),after=ops.slice(index).find(lexicalExact);
      const line=lines.find(l=>l.words.some(w=>w.id===missing[0].id));
      const anchored=before?.left&&before?.right&&after?.left&&after?.right&&before.left.text===before.right.text&&after.left.text===after.right.text
        &&line?.words.some(w=>w.id===before.left.word.id)&&line.words.some(w=>w.id===after.left.word.id);
      const intervalBoxes=anchored?line.words.filter(w=>w.index>before.left.word.index&&w.index<after.left.word.index&&/[\p{L}\p{N}]/u.test(w.text)):[];
      const intervalReaderTokens=anchored?readerTokens.filter(t=>t.start>=before.right.end&&t.end<=after.right.start&&/[\p{L}\p{N}]/u.test(t.text)):[];
      gaps.push({type:anchored?'POSSIBLE_READER_OMISSION':'GEOMETRY_COVERAGE_GAP',lineId:line?.id,
        geometryWordIds:missing.map(w=>w.id),geometryBoxCount:missing.length,
        boxes:missing.map(w=>({id:w.id,bbox:w.bbox,privateGoogleLexicalEvidence:w.text})),
        readerStart:before?.right?.end??0,readerEnd:after?.right?.start??reader.length,
        leftAnchor:before?.right?.text??null,rightAnchor:after?.right?.text??null,
        alignmentAmbiguous:ops.slice(start,index).some(o=>o.ambiguous),
        assignmentIsProven:false,
        anchoredInterval:anchored?{geometryWordIds:intervalBoxes.map(w=>w.id),geometryBoxCount:intervalBoxes.length,
          readerLexicalTokenCount:intervalReaderTokens.length,readerText:reader.slice(before.right.end,after.right.start),
          boxCountDeficit:Math.max(0,intervalBoxes.length-intervalReaderTokens.length),
          limitation:'Physical box count is not a source word count. Exact missing-box assignment and active/deleted status are unproven.'}:null,
        replacement:null,sourceAuthority:false,reason:'Box occupancy only; may include excluded/deleted/artifact writing or Google segmentation errors. Human review required.'});
    }else index++;
  }
  return {diagnosticOnly:true,sourceAuthority:false,wordBoxCount:boxes.length,readerTokenCount:[...reader.matchAll(/\S+/gu)].length,
    readerLexicalPunctuationTokenCount:readerTokens.length,
    exactMatchedBoxes:new Set(ops.filter(o=>o.left&&o.right&&o.left.text===o.right.text).map(o=>o.left.word.id)).size,
    lines:lines.map(l=>({lineId:l.id,paragraphIndex:l.paragraphIndex,wordIds:l.words.map(w=>w.id)})),gaps};
}

module.exports={tokens,align,diff,geometryCoverage};
