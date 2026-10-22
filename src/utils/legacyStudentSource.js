'use strict';
const {createHash}=require('crypto');
const VERSION='legacy-student-source-v1';
const sha=s=>createHash('sha256').update(s).digest('hex');
const tokens=s=>(String(s||'').toLowerCase().match(/[\p{L}]+/gu)||[]);
function lcs(a,b){let row=new Uint16Array(b.length+1);for(const x of a){const next=new Uint16Array(b.length+1);for(let j=1;j<=b.length;j++)next[j]=x===b[j-1]?row[j-1]+1:Math.max(row[j],next[j-1]);row=next;}return row[b.length];}
function promptBoundary(spans,assignment={}){
  const lines=[];for(const s of spans){if(!lines.length||s.separatorBefore.includes('\n'))lines.push([]);lines.at(-1).push(s);}
  const refs=['prompt','question','instructions','description','title'].filter(k=>typeof assignment[k]==='string').map(k=>({key:k,words:tokens(assignment[k].replace(/<[^>]*>/gu,' '))})).filter(r=>r.words.length>=8&&r.words.length<=500);
  const diagnostics={promptCandidateDetected:false,promptMatchScore:0,promptLinesExcluded:0,studentTranscriptStartLine:1,sourceBoundaryUncertain:true};
  let best=null;
  for(let n=1;n<=Math.min(6,lines.length);n++){
    const region=lines.slice(0,n).flat(),first=region[0]?.bbox;
    if(!first)continue;const top=first.y0??first.y;if(!Number.isFinite(top)||top>25)continue;
    const positions=region.map(s=>s.bbox).filter(Boolean);
    if(positions.length<region.length*.9||positions.some(b=>(b.y1??b.y+b.h)>40))continue;
    const words=tokens(region.map(s=>s.word.text).join(' '));if(words.length>550)break;
    for(const ref of refs){const matched=lcs(ref.words,words),recall=matched/ref.words.length,precision=words.length?matched/words.length:0,score=Math.min(recall,precision);
      diagnostics.promptMatchScore=Math.max(diagnostics.promptMatchScore,score);
      if(score>=.94&&(!best||score>best.score)){best={n,score,region,referenceKey:ref.key};}
    }
  }
  if(best)Object.assign(diagnostics,{promptCandidateDetected:true,promptMatchScore:best.score,promptLinesExcluded:best.n,studentTranscriptStartLine:best.n+1,sourceBoundaryUncertain:false});
  return {excludedIds:new Set(best?.region.map(s=>s.wordId)||[]),referenceKey:best?.referenceKey||null,...diagnostics};
}
function bounds(box,width,height){if(!box)return null;const x=box.x0??box.x,y=box.y0??box.y,w=box.x1!=null?box.x1-x:box.w,h=box.y1!=null?box.y1-y:box.h;
  if(![x,y,w,h].every(Number.isFinite)||w<=0||h<=0)return null;
  return {x:Math.max(0,Math.floor(x*width/100)),y:Math.max(0,Math.floor(y*height/100)),w:Math.max(1,Math.round(w*width/100)),h:Math.max(1,Math.round(h*height/100))};}
// Pixel analysis only. No recognition, English, confidence score or OCR rewriting.
function deletionEvidence({data,width,height},box,neighborDensity=0){
  const b=bounds(box,width,height);if(!b||b.w<8||b.h<6)return {status:'ACTIVE',reason:'NO_STRONG_DELETION_EVIDENCE'};
  const ink=(x,y)=>x>=0&&y>=0&&x<width&&y<height&&data[Math.round(y)*width+Math.round(x)]<95;
  let count=0,total=0;for(let y=b.y;y<Math.min(height,b.y+b.h);y++)for(let x=b.x;x<Math.min(width,b.x+b.w);x++){count+=ink(x,y)?1:0;total++;}
  const density=total?count/total:0,paths=[];let borderline=false;
  for(const rise of [0,-.6,-.3,.3,.6])for(let f=.25;f<=.751;f+=.1){
    const center=b.y+b.h*f,at=x=>center+rise*b.h*((x-b.x)/b.w-.5);
    const hit=x=>[-1,0,1].some(d=>ink(x,at(x)+d));let hits=0,samples=0;
    for(let x=b.x;x<b.x+b.w;x++){hits+=hit(x)?1:0;samples++;}
    const coverage=hits/samples;if(coverage<.72)continue;
    const extension=Math.max(3,Math.ceil(b.w*.15));let outside=0;
    for(let d=1;d<=extension;d++)outside+=Number(hit(b.x-d))+Number(hit(b.x+b.w-1+d));
    const extended=outside/(extension*2)>=.9;
    // A continuous page-width rule cannot alone prove deletion.
    let pageHits=0;for(let x=0;x<width;x++)pageHits+=hit(x)?1:0;
    const ruled=pageHits/width>=.65;
    if(ruled)continue;
    if(coverage>=.93&&!paths.some(p=>Math.abs(p.center-center)<Math.max(2,b.h*.12)&&Math.abs(p.rise-rise)<.25))paths.push({center,rise,extended});
    else borderline=true;
  }
  const crossing=paths.some(p=>{
    if(!p.extended)return false;let above=0,below=0;
    for(let y=b.y;y<b.y+b.h;y++)for(let x=b.x;x<b.x+b.w;x++)if(ink(x,y)){
      const lineY=p.center+p.rise*b.h*((x-b.x)/b.w-.5);if(y<lineY-2)above++;if(y>lineY+2)below++;
    }
    return above/(b.w*b.h)>=.06&&below/(b.w*b.h)>=.06;
  }),scribble=paths.length>=3&&paths.some(p=>p.rise<0)&&paths.some(p=>p.rise>0)&&density>=.55&&density>=neighborDensity*1.7+.08;
  if(crossing||scribble)return {status:'VISUALLY_DELETED',reason:scribble?'MULTIPLE_DENSE_TRAVERSING_STROKES':'LOCAL_BODY_TRAVERSING_STROKE',density,traversingStrokeCount:paths.length};
  if(paths.length||borderline)return {status:'DELETION_UNCERTAIN',reason:'BORDERLINE_VISUAL_STROKES',density,traversingStrokeCount:paths.length};
  return {status:'ACTIVE',reason:'NO_STRONG_DELETION_EVIDENCE',density,traversingStrokeCount:0};
}
function assembleActive(words,expectedHash){
  let text='';const spans=[];for(const word of words||[]){
    if(typeof word.text!=='string'||!['ACTIVE','DELETION_UNCERTAIN'].includes(word.studentSourceStatus)||typeof word.separatorBefore!=='string')return {text:'',spans:[],layoutDegraded:true};
    const separatorBefore=spans.length?word.separatorBefore:'';text+=separatorBefore;const start=text.length;text+=word.text;
    spans.push({word,wordId:word.id,start,end:text.length,separatorBefore,bbox:word.bbox,fileId:word.fileId,page:word.page});
  }
  const valid=expectedHash===undefined||sha(text)===expectedHash;
  return {text:valid?text:'',spans:valid?spans:[],words:valid?words:[],separators:spans.map(s=>s.separatorBefore),layoutDegraded:!valid,mapping:{totalWords:words?.length||0,mappedWords:valid?spans.length:0,alignmentRatio:valid?1:0}};
}
async function selectStudentSource({bytes,spans,assignment}){
  const boundary=promptBoundary(spans,assignment),raw=await require('sharp')(bytes).greyscale().removeAlpha().raw().toBuffer({resolveWithObject:true});
  const image={data:raw.data,width:raw.info.width,height:raw.info.height},evidence=[],active=[];let pendingBreak='';
  // Local neighbor ink density is diagnostic context, not a textual authority.
  const densities=spans.map(s=>deletionEvidence(image,s.bbox,1).density||0);
  for(const [i,s] of spans.entries()){
    if(s.separatorBefore.includes('\n'))pendingBreak=pendingBreak.includes('\n\n')||s.separatorBefore.includes('\n\n')?'\n\n':'\n';
    const neighbor=[densities[i-1],densities[i+1]].filter(Number.isFinite);const baseline=neighbor.length?neighbor.reduce((a,b)=>a+b,0)/neighbor.length:0;
    const visual=deletionEvidence(image,s.bbox,baseline),prompt=boundary.excludedIds.has(s.wordId);
    const status=prompt?'ASSIGNMENT_PROMPT':visual.status;
    evidence.push({wordId:s.wordId,text:s.word.text,bbox:s.bbox,status,visual});
    if(prompt||status==='VISUALLY_DELETED')continue;
    const separatorBefore=active.length?(pendingBreak||s.separatorBefore):'';
    active.push({...s.word,id:s.wordId,separatorBefore,studentSourceStatus:status});pendingBreak='';
  }
  const assembled=assembleActive(active);return {version:VERSION,text:assembled.text,textSha256:sha(assembled.text),words:active,spans:assembled.spans,
    evidence:{version:VERSION,inputSha256:sha(bytes),boundary:Object.fromEntries(Object.entries(boundary).filter(([k])=>k!=='excludedIds')),occurrences:evidence,
      excludedPromptCount:evidence.filter(e=>e.status==='ASSIGNMENT_PROMPT').length,visuallyDeletedCount:evidence.filter(e=>e.status==='VISUALLY_DELETED').length,
      uncertainDeletionCount:evidence.filter(e=>e.status==='DELETION_UNCERTAIN').length}};
}
module.exports={VERSION,sha,promptBoundary,deletionEvidence,assembleActive,selectStudentSource};
