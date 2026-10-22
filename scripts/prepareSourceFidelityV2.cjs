'use strict';
// Offline, lossless crop preparation. Requires the sole saved Google response.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const v = require('./local-shadow/source-fidelity-v2.cjs');
const { bounds } = require('../src/services/hybridSource/visualLines');
const median = a => [...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
function orderedWords(input) {
  const rows = [];
  const words = input.map(w => ({ ...w, box: bounds(w.polygon) }));
  for (const w of [...words].sort((a,b)=>a.box.center-b.box.center || a.box.left-b.box.left)) {
    const fitting = rows.filter(row => Math.abs(median(row.map(x=>x.box.center))-w.box.center) <= 45);
    if (fitting.length === 1) fitting[0].push(w);
    else { w.lineAmbiguous = fitting.length > 1; rows.push([w]); }
  }
  rows.sort((a,b)=>median(a.map(w=>w.box.center))-median(b.map(w=>w.box.center)));
  const ordered = rows.flatMap((row, index) => row.sort((a,b)=>a.box.left-b.box.left).map(w => {
    w.visualLine = index+1;
    w.overlap = row.some(other => other !== w && Math.min(other.box.right,w.box.right)-Math.max(other.box.left,w.box.left) > Math.min(other.box.right-other.box.left,w.box.right-w.box.left)*.25);
    return w;
  }));
  return ordered;
}
// Agent visual risk observations from the original image. These only trigger review,
// never assert text, deletion authority or substitute geometry.
const visualRisks = [
  {left:55,top:140,right:345,bottom:225,reason:'VISIBLE_REVISION'},
  {left:65,top:380,right:198,bottom:467,reason:'VISIBLE_REVISION'},
  {left:438,top:365,right:658,bottom:460,reason:'VISIBLE_REVISION'},
  {left:350,top:911,right:575,bottom:991,reason:'VISIBLE_REVISION'},
  {left:934,top:916,right:1090,bottom:979,reason:'REVISION_NEAR_ACTIVE_WORD'},
  {left:540,top:1120,right:945,bottom:1200,reason:'VISIBLE_REVISION'},
  {left:865,top:1260,right:952,bottom:1343,reason:'AMBIGUOUS_MARK'},
];
async function prepare() {
  v.initialize();
  if (fs.existsSync(path.join(v.DIR,'sol-1-attempt.reserved.json'))) throw Error('CROP_PLAN_FROZEN_AFTER_TRANSPORT');
  const save = (name, value) => {
    const file=path.join(v.DIR,name);
    if (fs.existsSync(file)) fs.writeFileSync(file,Buffer.isBuffer(value)||typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');
    else v.save(v.DIR,name,value);
  };
  if (v.read(v.DIR,'google-result.json').status !== 'COMPLETE') throw Error('GOOGLE_STAGE_NOT_COMPLETE');
  const geom = v.read(v.DIR,'google-geometry.json'), original = v.source();
  const solText = fs.readFileSync(path.join(v.OLD,'activeTranscript.txt'),'utf8');
  const words = orderedWords(geom.words), gt = words.flatMap(w=>v.tokens(w.text).map(t=>({...t,wordId:w.id}))), st=v.tokens(solText);
  const alignment = v.align(gt,st);
  for (const op of alignment.operations) {
    op.googleText = op.googleIndex === null ? '' : gt[op.googleIndex].text;
    op.solText = op.solIndex === null ? '' : st[op.solIndex].text;
    op.difference = v.difference(op.googleText,op.solText);
  }
  const insertions = alignment.operations.filter(op=>op.googleIndex === null);
  const eligible = new Map();
  for (const w of words) {
    const ops = alignment.operations.filter(op=>op.googleIndex !== null && gt[op.googleIndex].wordId === w.id);
    const reasons = [];
    if (ops.some(o=>!o.exact)) reasons.push('EXACT_DISAGREEMENT');
    if (ops.some(o=>o.ambiguous) || w.lineAmbiguous) reasons.push('AMBIGUOUS_ALIGNMENT');
    if (w.confidence === null || w.confidence < .85) reasons.push('LOW_GOOGLE_CONFIDENCE');
    if (w.overlap) reasons.push('OVERLAPPING_NATIVE_GEOMETRY');
    if (!w.geometryValid) reasons.push('INVALID_NATIVE_GEOMETRY');
    for (const r of visualRisks) if (w.box.left < r.right && w.box.right > r.left && w.box.top < r.bottom && w.box.bottom > r.top) reasons.push(r.reason);
    // A Sol-only token has no proven word geometry; flag adjacent native words for context review.
    const index = alignment.operations.findIndex(o=>o.googleIndex !== null && gt[o.googleIndex].wordId === w.id);
    if (index >= 0 && [alignment.operations[index-1],alignment.operations[index+ops.length]].some(o=>o?.googleIndex === null)) reasons.push('ADJACENT_UNLOCATED_SOL_TOKEN');
    w.alignment = ops; w.reasons = [...new Set(reasons)];
    if (reasons.length) eligible.set(w.id,w);
  }
  // Adjacent eligible native words form short phrases, <=3 lexical words and <=360 pixels wide.
  const groups=[];
  for (const w of words) {
    if (!eligible.has(w.id)) continue;
    const last=groups.at(-1), previous=last?.at(-1);
    const lexical = x => /[\p{L}\p{N}]/u.test(x.text);
    if (previous && previous.visualLine===w.visualLine && words.indexOf(w)===words.indexOf(previous)+1 &&
        w.box.right-last[0].box.left <=360 && last.filter(lexical).length+Number(lexical(w))<=3 &&
        (w.box.left<75)===(previous.box.left<75)) last.push(w);
    else groups.push([w]);
  }
  const targets=[];
  for (const group of groups) {
    const cropId=`CROP_${String(targets.length+1).padStart(3,'0')}`, reasons=[...new Set(group.flatMap(w=>w.reasons))];
    const ops=group.flatMap(w=>w.alignment), si=[...new Set(ops.filter(o=>o.solIndex!==null).map(o=>o.solIndex))].sort((a,b)=>a-b);
    const alternativeDifferences=[...new Set(ops.flatMap(o=>alignment.alternatives[o.googleIndex].filter(j=>j!==null).map(j=>v.difference(o.googleText,st[j].text))).filter(d=>d!=='EXACT'))];
    const left=Math.max(0,Math.floor(Math.min(...group.map(w=>w.box.left)))-5);
    const top=Math.max(0,Math.floor(Math.min(...group.map(w=>w.box.top)))-5);
    const right=Math.min(geom.width,Math.ceil(Math.max(...group.map(w=>w.box.right)))+5);
    const bottom=Math.min(geom.height,Math.ceil(Math.max(...group.map(w=>w.box.bottom)))+5);
    const rect={left,top,width:right-left,height:bottom-top};
    const t={cropId,sourceSha256:v.HASH,wordIds:group.map(w=>w.id),nativePolygons:group.map(w=>w.polygon),visualLine:group[0].visualLine,rect,
      googleText:group.map(w=>w.text).join(' '), googleExactWords:group.map(w=>w.text),
      solText:si.length?solText.slice(st[si[0]].start,st[si.at(-1)].end):null,
      solMappingAmbiguous:ops.some(o=>o.ambiguous), reasons, differences:[...new Set(ops.filter(o=>!o.exact).map(o=>o.difference))], alternativeDifferences,
      geometryValid:group.every(w=>w.geometryValid), selected:false};
    // Native rectangle is a visual span, not proof of new token-level character boxes.
    const raw=await sharp(original).extract(rect).removeAlpha().raw().toBuffer({resolveWithObject:true});
    const png=await sharp(raw.data,{raw:{width:rect.width,height:rect.height,channels:raw.info.channels}}).png().toBuffer();
    const decoded=await sharp(png).raw().toBuffer();
    if (!decoded.equals(raw.data)) throw Error('ORIGINAL_CROP_PIXEL_MISMATCH');
    const enlarged=await sharp(png).resize(rect.width*4,rect.height*4,{kernel:'lanczos3'}).png().toBuffer();
    t.originalSha256=v.sha(png);t.originalDecodedPixelSha256=v.sha(raw.data);t.enlargedSha256=v.sha(enlarged);
    t.enlargement={scale:4,kernel:'lanczos3',generative:false};
    save(`${cropId}-original.png`,png);
    save(`${cropId}-enlarged.png`,enlarged);
    t.priority=(t.differences.includes('CASE_ONLY')?120:0)+(t.differences.includes('SPELLING_OR_OTHER')?110:0)
      +(t.differences.includes('PUNCTUATION_OR_GAP')?60:0)+(reasons.some(r=>/REVISION|MARK/.test(r))?40:0);
    if (alternativeDifferences.includes('CASE_ONLY') && !t.differences.includes('CASE_ONLY')) t.priority+=120;
    targets.push(t);
  }
  const selected=targets.filter(t=>t.geometryValid).sort((a,b)=>b.priority-a.priority || a.cropId.localeCompare(b.cropId)).slice(0,24);
  selected.forEach(t=>t.selected=true);
  const batches=[selected.slice(0,12).map(t=>t.cropId),selected.slice(12,24).map(t=>t.cropId)].filter(b=>b.length);
  const plan={sourceSha256:v.HASH,oldSolSha256:v.sha(solText),googleConfidenceThreshold:.85,visualCharacterConfidenceThreshold:.95,
    readingOrder:'Native polygon vertical clusters within 45px, then x; overlaps/ambiguous alignments withheld.',
    visualRisks,wordCount:words.length,eligibleWordCount:eligible.size,targets,batches,
    secondBatchNecessary:selected.length>12,omittedTargets:targets.filter(t=>!t.selected).map(t=>t.cropId),
    counts:{totalDisagreements:alignment.operations.filter(o=>!o.exact).length,caseOnly:alignment.operations.filter(o=>o.difference==='CASE_ONLY').length,
      spellingOrOther:alignment.operations.filter(o=>o.difference==='SPELLING_OR_OTHER').length,punctuationOrGap:alignment.operations.filter(o=>o.difference==='PUNCTUATION_OR_GAP').length,
      solOnlyTokens:insertions.length},unlocatedSolTokens:insertions.map(o=>({text:o.solText,offset:st[o.solIndex].start,state:'OCR_UNCERTAIN'}))};
  save('alignment.json',{...alignment,googleTokens:gt,solTokens:st,orderedWords:words});
  save('crop-plan.json',plan);
  console.log(JSON.stringify({counts:plan.counts,targets:targets.length,selected:selected.length,batches:batches.map(b=>b.length),omitted:plan.omittedTargets.length}));
}
if(require.main===module) prepare().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={orderedWords,prepare};
