'use strict';

const { canonicalOcrWordId } = require('./ocrWordIdentity');

// Increment whenever canonical reading-order or separator rules change. This is
// intentionally independent from the correction prompt/schema version.
const CANONICAL_TRANSCRIPT_LAYOUT_VERSION = 'ocr-layout-v5-native-text';
const HANDWRITING_LAYOUT_VERSION = 'vision-handwriting-geometry-v1';

// Separate from the historical printed/display normalizer. No vocabulary,
// paragraph ids or margin-artifact removal supplies source text. Immediate
// source neighbors may prove a local insertion, never a page-wide ordering.
function buildHandwritingGeometryTranscript(words) {
  const source=(Array.isArray(words)?words:[]).map((word,inputIndex)=>({word,inputIndex})).filter(c=>typeof c.word?.text==='string'&&c.word.text.length);
  const candidates=source.map(({word,inputIndex},sourceIndex)=>{
    const b=word.bbox,values=b&&('x0' in b?[b.x0,b.y0,b.x1,b.y1]:[b.x,b.y,b.w,b.h]);
    return {word,inputIndex,sourceIndex,box:values?.every(n=>typeof n==='number'&&Number.isFinite(n))?bboxOf(word):null};
  });
  const valid=candidates.filter(c=>c.box);
  const coverage={totalWords:source.length,geometricWords:valid.length,ratio:source.length?valid.length/source.length:0};
  const lines=[];
  const h=median(valid.map(c=>c.box.height));
  const placementStats=()=>({detectedWordCount:source.length,geometricWordCount:valid.length,rawGeometryCoverage:coverage.ratio,
    resolvedWordCount:candidates.filter(c=>c.line).length,resolvedPlacementCoverage:source.length?candidates.filter(c=>c.line).length/source.length:0,
    fallbackPlacementCount:candidates.filter(c=>c.structural).length,ambiguousWordCount:candidates.filter(c=>c.ambiguous).length,
    soleCandidateOutlierPlacementCount:candidates.filter(c=>c.soleCandidate).length,
    unresolvedWordCount:candidates.filter(c=>!c.line).length,lineCount:lines.length,medianWordHeight:h,
    unresolvedDescriptors:candidates.filter(c=>!c.line).slice(0,20).map(c=>({inputIndex:c.inputIndex,textLength:c.word.text.length,hasGeometry:!!c.box,
      candidateLineCount:c.candidateLineCount||0,reason:c.reason||(c.box?'UNRESOLVED_OUTLIER':'MISSING_GEOMETRY_UNRESOLVED'),...(c.soleDiagnostics||{})}))});
  const degraded=reason=>({text:'',words:[],spans:[],separators:[],...placementStats(),geometryCoverage:coverage,
    readingOrderStrategy:HANDWRITING_LAYOUT_VERSION,layoutDegraded:true,reason});
  if(!source.length||!valid.length)return degraded('MISSING_GEOMETRY_UNRESOLVED');
  const core=valid.filter(c=>c.box.height>=h*.65&&c.box.height<=h*1.45);
  // Spatial neighbors vote, never Google's block/paragraph traversal order.
  const slopes=[];
  for(const a of core){
    const ax=(a.box.x0+a.box.x1)/2;
    const neighbors=core.filter(b=>b!==a).map(b=>({dx:(b.box.x0+b.box.x1)/2-ax,dy:b.box.centerY-a.box.centerY}))
      .filter(p=>p.dx>h*1.5&&p.dx<h*12&&Math.abs(p.dy)<h*.65&&Math.abs(p.dy/p.dx)<.18)
      .sort((a,b)=>a.dx-b.dx||Math.abs(a.dy)-Math.abs(b.dy)).slice(0,2);
    slopes.push(...neighbors.map(p=>p.dy/p.dx));
  }
  const slope=slopes.length>=3?median(slopes):0;
  for(const c of valid){const dy=slope*(c.box.x0+c.box.x1)/2;c.top=c.box.y0-dy;c.bottom=c.box.y1-dy;c.center=c.box.centerY-dy;}
  const compare=(a,b)=>a.box.x0-b.box.x0||a.center-b.center||a.box.x1-b.box.x1||a.box.height-b.box.height;
  const update=line=>{
    const anchors=line.words.filter(c=>c.box.height>=h*.65&&c.box.height<=h*1.45);
    const basis=anchors.length?anchors:line.words;
    line.height=median(basis.map(c=>c.box.height));line.center=median(basis.map(c=>c.center));
    line.baseline=median(basis.map(c=>c.bottom));line.top=median(basis.map(c=>c.top));line.bottom=median(basis.map(c=>c.bottom));
  };
  const memberships=(c,loose=false)=>lines.map(line=>{
    const localH=Math.min(h*1.35,Math.max(h*.75,line.height));
    const overlap=Math.max(0,Math.min(c.bottom,line.bottom)-Math.max(c.top,line.top))/Math.min(c.box.height,localH);
    const baseline=Math.abs(c.bottom-line.baseline)/localH;
    const center=Math.abs(c.center-line.center)/localH;
    const tall=c.box.height>h*1.45;
    const effective=tall?Math.min(center,baseline):center;
    // A broad word box is not allowed to swallow another line. Stable seed and
    // robust medians prevent incremental low-word/tall-word chain drift.
    const seed=tall?Math.min(Math.abs(c.center-line.seed),Math.abs(c.bottom-localH/2-line.seed)):Math.abs(c.center-line.seed);
    const horizontalCollision=line.words.some(w=>w!==c&&w.box&&!w.structural&&Math.min(w.box.x1,c.box.x1)-Math.max(w.box.x0,c.box.x0)>Math.min(w.box.width,c.box.width)*.5);
    const plausible=(!horizontalCollision||loose)&&overlap>=(loose ? .1 : .25)&&effective<=(loose?1.15:.72)&&seed<=h*(loose?1.4:.95)&&(baseline<=(loose?1.6:1.05)||tall&&center<=.55);
    return {line,plausible,horizontalCollision,localH,normalizedCenterDistance:center,normalizedBaselineDistance:baseline,verticalOverlapRatio:overlap,
      score:effective*.6+Math.min(baseline,1.5)*.25+(1-Math.min(overlap,1))*.15};
  }).filter(m=>m.plausible).sort((a,b)=>a.score-b.score||a.line.center-b.line.center);
  // Normal-height words establish baselines before ascenders/descenders vote.
  const pending=valid.filter(c=>!core.includes(c));
  for(const c of [...core].sort(compare)){
    const matches=memberships(c);
    if(matches.length>1&&matches[1].score-matches[0].score<.10){c.ambiguous=true;pending.push(c);continue;}
    if(matches.length){matches[0].line.words.push(c);update(matches[0].line);}
    else if(lines.some(l=>Math.abs(c.center-l.center)<h*.85)){pending.push(c);}
    else{const line={words:[c],seed:c.center};update(line);lines.push(line);}
  }
  // Revisit isolated normal-height outliers once established lines have robust
  // medians. An early high/low word must not remain a false physical line.
  for(const line of [...lines]){
    if(line.words.length!==1)continue;
    const c=line.words[0],matches=memberships(c).filter(m=>m.line!==line);
    if(matches.length&&(!matches[1]||matches[1].score-matches[0].score>=.10)){
      matches[0].line.words.push(c);update(matches[0].line);lines.splice(lines.indexOf(line),1);
    }
  }
  // A later-created line may compete with an early assignment. Recheck the
  // complete line bank before any word is allowed to act as a reliable neighbor.
  const reconsider=[];
  for(const line of lines)for(const c of line.words){
    const matches=memberships(c,true);
    const tied=matches.length>1&&matches[1].score-matches[0].score<.10;
    if(tied||matches[0]&&matches[0].line!==line){if(tied)c.ambiguous=true;reconsider.push({line,c});}
  }
  for(const {line,c} of reconsider){line.words.splice(line.words.indexOf(c),1);pending.push(c);}
  for(const line of [...lines]){if(line.words.length)update(line);else lines.splice(lines.indexOf(line),1);}
  for(const line of lines)for(const c of line.words){c.line=line;c.reliable=true;}
  const deferred=[];
  for(const c of pending.sort(compare)){
    const matches=memberships(c,true);c.candidateLineCount=matches.length;
    const tied=matches.length>1&&matches[1].score-matches[0].score<.10;if(tied)c.ambiguous=true;
    if(!matches.length||tied||matches[0].horizontalCollision){deferred.push(c);continue;}
    c.line=matches[0].line;c.reliable=true;c.line.words.push(c);
    // Outliers never move the already established line baseline.
  }
  // An immediate reliable pair must also be consecutive left-to-right on its
  // physical line. Reversed/scrambled Google blocks cannot establish a slot.
  for(const c of [...deferred,...candidates.filter(c=>!c.box)].sort((a,b)=>a.sourceIndex-b.sourceIndex)){
    const before=candidates[c.sourceIndex-1],after=candidates[c.sourceIndex+1];
    const matches=c.box?memberships(c,true):[];c.candidateLineCount=c.box?matches.length:before?.line===after?.line&&before?.line?1:0;
    const basis=before?.line?.words.filter(w=>w.reliable).sort(compare)||[];
    const left=basis.indexOf(before),right=basis.indexOf(after);
    const pair=before?.reliable&&after?.reliable&&before.line===after.line&&left>=0&&right===left+1&&before.box.x0<after.box.x0;
    const tiedLines=matches.filter(m=>matches[0]&&m.score-matches[0].score<.10).map(m=>m.line);
    if(pair&&(!c.box||tiedLines.includes(before.line))){c.line=before.line;c.structural={before,after};c.line.words.push(c);}
    else c.reason=!c.box?'MISSING_GEOMETRY_UNRESOLVED':c.ambiguous?'AMBIGUOUS_LINE_MEMBERSHIP':'UNRESOLVED_OUTLIER';
  }
  // Narrow final rule: one existing candidate, strong vertical fit and a unique
  // geometric slot inside the established text region. Never use text/glyph
  // identity or promote this placement into a reliable recursive anchor.
  const horizontalSlot=(c,ordered)=>{
    const x=(c.box.x0+c.box.x1)/2,centers=ordered.map(w=>(w.box.x0+w.box.x1)/2);
    if(centers.some((v,i)=>Math.abs(v-x)<1e-7||i&&v<=centers[i-1]+1e-7))return null;
    const index=centers.findIndex(v=>v>x);
    return index<0?ordered.length:index;
  };
  for(const c of candidates.filter(c=>!c.line&&c.box&&c.reason==='UNRESOLVED_OUTLIER')){
    const matches=memberships(c,true);c.candidateLineCount=matches.length;
    if(matches.length!==1)continue;
    const m=matches[0],anchors=m.line.words.filter(w=>w.reliable).sort(compare);
    const slot=horizontalSlot(c,anchors),cx=(c.box.x0+c.box.x1)/2;
    const allAnchors=lines.flatMap(l=>l.words.filter(w=>w.reliable));
    const left=Math.min(...anchors.map(w=>w.box.x0)),right=Math.max(...anchors.map(w=>w.box.x1));
    const bodyLeft=Math.min(...allAnchors.map(w=>w.box.x0)),bodyRight=Math.max(...allAnchors.map(w=>w.box.x1));
    const edgeArtifactRisk=cx<left-m.localH||cx>right+m.localH||cx<bodyLeft-m.localH*.5||cx>bodyRight+m.localH*.5;
    const conflictingLine=lines.some(l=>l!==m.line&&Math.max(0,Math.min(c.bottom,l.bottom)-Math.max(c.top,l.top))/Math.min(c.box.height,l.height)>=.25);
    const before=candidates[c.sourceIndex-1],after=candidates[c.sourceIndex+1];
    const neighborSupport=slot!==null&&slot>0&&slot<anchors.length&&before?.reliable&&after?.reliable&&before.line===m.line&&after.line===m.line&&anchors[slot-1]===before&&anchors[slot]===after;
    c.soleDiagnostics={normalizedCenterDistance:m.normalizedCenterDistance,normalizedBaselineDistance:m.normalizedBaselineDistance,
      verticalOverlapRatio:m.verticalOverlapRatio,horizontalInsertionResolved:slot!==null,neighborSupport:!!neighborSupport,edgeArtifactRisk,
      neighboringLineConflict:conflictingLine,establishedAnchorCount:anchors.length};
    const strongFit=m.verticalOverlapRatio>=.5&&(m.normalizedCenterDistance<=.55||m.normalizedBaselineDistance<=.35);
    if(anchors.length<2||!strongFit||conflictingLine||slot===null||edgeArtifactRisk)continue;
    c.line=m.line;c.soleCandidate=true;c.reliable=false;c.line.words.push(c);delete c.reason;
  }
  if(candidates.some(c=>!c.line))return degraded(candidates.find(c=>!c.line).reason||'UNRESOLVED_OUTLIER');
  lines.sort((a,b)=>a.baseline-b.baseline||a.center-b.center);
  if(lines.some((line,i)=>i&&line.baseline-lines[i-1].baseline<h*.6)){
    for(const c of candidates){c.line=null;c.reason='OVERLAPPING_LINE_CLUSTERS';}
    return degraded('OVERLAPPING_LINE_CLUSTERS');
  }
  const pitches=lines.slice(1).map((l,i)=>l.baseline-lines[i].baseline).filter(p=>p>0).sort((a,b)=>a-b);
  // Estimate normal ruled-line spacing from the lower half of observed gaps.
  // Widely spaced handwriting is not, by itself, a series of paragraphs.
  const pitch=median(pitches.slice(0,Math.ceil(pitches.length/2)))||h*1.5;
  let text='',previous=null;const spans=[];
  for(const [i,line] of lines.entries()){
    const prior=lines[i-1],paragraph=prior&&line.baseline-prior.baseline>Math.max(h*2.3,pitch*1.6)&&line.top-prior.bottom>h*.9;
    const ordered=line.words.filter(c=>!c.structural&&!c.soleCandidate).sort(compare);
    for(const c of line.words.filter(c=>c.soleCandidate).sort((a,b)=>(a.box.x0+a.box.x1)-(b.box.x0+b.box.x1))){
      const slot=horizontalSlot(c,ordered);
      if(slot===null){c.line=null;c.reason='UNRESOLVED_OUTLIER';return degraded(c.reason);}
      ordered.splice(slot,0,c);
    }
    for(const c of line.words.filter(c=>c.structural).sort((a,b)=>a.sourceIndex-b.sourceIndex)){
      const left=ordered.indexOf(c.structural.before),right=ordered.indexOf(c.structural.after);
      if(left<0||right!==left+1){c.line=null;c.reason='UNRESOLVED_OUTLIER';return degraded(c.reason);}
      ordered.splice(right,0,c);
    }
    for(const [j,c] of ordered.entries()){
      const separatorBefore=!spans.length?'':j===0?(paragraph?'\n\n':'\n'):getOcrWordSeparator(previous.text,c.word.text,' ');
      text+=separatorBefore;const start=text.length;text+=c.word.text;
      spans.push({word:{...c.word},wordId:c.word.id,start,end:text.length,separatorBefore,fileId:c.word.fileId,page:c.word.page,bbox:c.word.bbox});previous=c.word;
    }
  }
  const stats=placementStats();
  if(stats.resolvedPlacementCoverage!==1||stats.unresolvedWordCount!==0||spans.length!==candidates.length||new Set(lines.flatMap(l=>l.words.map(c=>c.inputIndex))).size!==candidates.length)return degraded('UNRESOLVED_OUTLIER');
  return {text,words:spans.map(s=>s.word),spans,separators:spans.map(s=>s.separatorBefore),...stats,
    geometryCoverage:coverage,readingOrderStrategy:HANDWRITING_LAYOUT_VERSION,layoutDegraded:false,comparisonSlope:slope,
    mapping:{totalWords:source.length,mappedWords:spans.length,alignmentRatio:1}};
}

const CLOSING_PUNCTUATION = /^[,.!?:;%\)\]\}’”]/u;
const OPENING_PUNCTUATION = /[\(\[\{“]$/u;
const JOINING_PUNCTUATION = /^['’]/u;
const PREVIOUS_JOINING_PUNCTUATION = /['’\/-]$/u;

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function normalizeOcrTranscript(text) {
  if (typeof text !== 'string' || !text) return '';
  return text
    .replace(/\r\n?/gu, '\n')
    .replace(/[^\S\n]+/gu, ' ')
    .split('\n')
    .map((line) => line.trim()
      .replace(/ +([,.!?:;%\)\]\}’”])/gu, '$1')
      .replace(/([\(\[\{“]) +/gu, '$1'))
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function getOcrWordSeparator(previousText, currentText, preferredSeparator = ' ') {
  if (!previousText) return '';
  const previous = String(previousText || '');
  const current = String(currentText || '');
  if (CLOSING_PUNCTUATION.test(current) || JOINING_PUNCTUATION.test(current)) return '';
  if (OPENING_PUNCTUATION.test(previous) || PREVIOUS_JOINING_PUNCTUATION.test(previous)) return '';
  if (preferredSeparator === '\n\n') return '\n\n';
  return preferredSeparator === '\n' ? '\n' : ' ';
}

function bboxOf(word) {
  const box = word?.bbox;
  if (!box || typeof box !== 'object') return null;
  const x0 = Number.isFinite(Number(box.x0)) ? Number(box.x0) : Number(box.x);
  const y0 = Number.isFinite(Number(box.y0)) ? Number(box.y0) : Number(box.y);
  const x1 = Number.isFinite(Number(box.x1)) ? Number(box.x1) : x0 + Number(box.w);
  const y1 = Number.isFinite(Number(box.y1)) ? Number(box.y1) : y0 + Number(box.h);
  if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) return null;
  return { x0, y0, x1, y1, width: x1 - x0, height: y1 - y0, centerY: (y0 + y1) / 2 };
}

function sanitizeOcrMarginArtifacts(words) {
  const candidates = (Array.isArray(words) ? words : []).map((word, inputIndex) => ({ word, inputIndex, box: bboxOf(word),
    text: typeof word?.text === 'string' ? word.text.trim() : '' })).filter((item) => item.text);
  const geometric = candidates.filter((item) => item.box);
  if (geometric.length < 4) return candidates.map((item) => item.word);

  const suspicious = (item) => item.text.length <= 2 && /^[#DB0O|Il1]+$/u.test(item.text);
  const body = geometric.filter((item) => !suspicious(item) && item.text.length >= 2 && item.box.x0 < 88);
  if (body.length < 3) return candidates.map((item) => item.word);
  const heights = body.map((item) => item.box.height);
  const medianHeight = median(heights) || 2;
  const sortedRights = body.map((item) => item.box.x1).sort((a, b) => a - b);
  const mainRight = sortedRights[Math.min(sortedRights.length - 1, Math.floor(sortedRights.length * 0.9))];
  const edgeGlyphs = geometric.filter((item) => suspicious(item)
    && (item.box.x0 >= 88 || item.box.x0 > mainRight + Math.max(2.5, medianHeight * 0.8)));

  const clustered = new Set();
  for (const item of edgeGlyphs) {
    const peers = edgeGlyphs.filter((other) => other !== item
      && Math.abs(((other.box.x0 + other.box.x1) / 2) - ((item.box.x0 + item.box.x1) / 2)) <= Math.max(4, medianHeight * 1.5)
      && Math.abs(other.box.centerY - item.box.centerY) >= medianHeight * 0.8);
    if (peers.length) clustered.add(item.inputIndex);
  }

  // Single letters are legitimate in prose, initials, and grades. Remove them
  // only as part of a detached vertical edge cluster. A lone hash-like mark is
  // removed only when it is extremely far outside the established text column.
  return candidates.filter((item) => {
    if (!item.box || !suspicious(item)) return true;
    if (clustered.has(item.inputIndex)) return false;
    return !(item.text === '#' && item.box.x0 >= 94 && item.box.x0 > mainRight + Math.max(4, medianHeight * 1.5));
  }).map((item) => item.word);
}

function clusterVisualLines(words) {
  const candidates = words.map((word, inputIndex) => ({ word, inputIndex, box: bboxOf(word) }));
  const geometryCount = candidates.filter((item) => item.box).length;
  if (!candidates.length || geometryCount !== candidates.length) {
    return candidates.map((item, index) => ({ words: [item], inputIndex: index, geometry: false }));
  }

  // Estimate small page slope from forward neighbors in OCR order; wraps do not vote.
  // Geometry is unchanged. Deskew is used only to compare line membership.
  const slopes = [];
  for (let i = 1; i < candidates.length; i++) {
    const a = candidates[i - 1].box, b = candidates[i].box;
    const dx = (b.x0 + b.x1 - a.x0 - a.x1) / 2, dy = b.centerY - a.centerY;
    if (dx > Math.max(a.width, b.width) * 0.5 && Math.abs(dy) < Math.min(a.height, b.height) * 0.65
      && Math.abs(dy / dx) < 0.25) slopes.push(dy / dx);
  }
  const slope = slopes.length >= 3 ? median(slopes) : 0;
  const typicalHeight = median(candidates.map((item) => item.box.height));
  const center = (item) => item.box.centerY - slope * (item.box.x0 + item.box.x1) / 2;
  const byVerticalPosition = [...candidates].sort((a, b) => center(a) - center(b)
    || a.box.x0 - b.box.x0 || a.inputIndex - b.inputIndex);
  const lines = [];
  for (const candidate of byVerticalPosition) {
    const last = lines[lines.length - 1];
    // A fixed seed bounds the group: neither a tall word nor a chain can move it.
    const bestLine = last && Math.abs(center(candidate) - last.seedCenter) <= typicalHeight * 0.45 ? last : null;
    if (!bestLine) {
      lines.push({ words: [candidate], y0: candidate.box.y0, y1: candidate.box.y1,
        height: candidate.box.height, centerY: candidate.box.centerY, seedCenter: center(candidate), inputIndex: candidate.inputIndex, geometry: true });
      continue;
    }
    bestLine.words.push(candidate);
    bestLine.y0 = Math.min(bestLine.y0, candidate.box.y0);
    bestLine.y1 = Math.max(bestLine.y1, candidate.box.y1);
    bestLine.height = median(bestLine.words.slice(-32).map((item) => item.box.height));
    bestLine.centerY = median(bestLine.words.slice(-32).map((item) => item.box.centerY));
    bestLine.inputIndex = Math.min(bestLine.inputIndex, candidate.inputIndex);
  }

  return lines
    .sort((a, b) => a.y0 - b.y0 || a.inputIndex - b.inputIndex)
    .map((line) => ({ ...line, words: line.words.sort((a, b) => a.box.x0 - b.box.x0 || a.inputIndex - b.inputIndex) }));
}

function lineParagraphBoundary(previousLine, currentLine, context) {
  if (!previousLine?.geometry || !currentLine?.geometry) return false;
  const previousWords = previousLine.words;
  const currentWords = currentLine.words;
  const previousLast = previousWords[previousWords.length - 1]?.word;
  const currentFirst = currentWords[0]?.word;
  const gap = Math.max(0, currentLine.y0 - previousLine.y1);
  const previousLeft = Math.min(...previousWords.map((item) => item.box.x0));
  const currentLeft = Math.min(...currentWords.map((item) => item.box.x0));
  const paragraphMetadataChanged = previousLast?.paragraphIndex != null && currentFirst?.paragraphIndex != null
    && Number(previousLast.paragraphIndex) !== Number(currentFirst.paragraphIndex);
  const largeVerticalGap = gap > Math.max(context.medianHeight * 0.9, context.medianLineGap * 1.8);
  const indentationChanged = Math.abs(currentLeft - previousLeft) > Math.max(context.medianHeight * 1.25, 1.5);
  const shortLineBlock = (previousWords.length <= 2 || currentWords.length <= 2) && largeVerticalGap;
  const signals = Number(paragraphMetadataChanged) + Number(largeVerticalGap) + Number(indentationChanged) + Number(shortLineBlock);

  // OCR paragraph ids alone are only segmentation hints. Require corroborating
  // geometry, and keep normal-gap orphan fragments attached to the prose.
  return signals >= 2;
}

function orderWordsAndSeparators(words) {
  const sanitized = sanitizeOcrMarginArtifacts(words);
  const typicalHeight = median(sanitized.map((word) => bboxOf(word)?.height).filter(Number.isFinite));
  const cleaned = sanitized
    .map((word, index) => ({ ...word, text: typeof word?.text === 'string' ? word.text.trim() : '', __inputIndex: index }))
    .map((word) => ({ ...word, ocrLayoutSuspicious: word.ocrLayoutSuspicious === true
      || Boolean(typicalHeight && bboxOf(word)?.height > typicalHeight * 1.6) }))
    .filter((word) => word.text);
  const lines = clusterVisualLines(cleaned);
  const medianHeight = median(lines.filter((line) => line.geometry).map((line) => line.height)) || 1;
  const positiveGaps = [];
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index - 1].geometry && lines[index].geometry) {
      const gap = lines[index].y0 - lines[index - 1].y1;
      if (gap >= 0) positiveGaps.push(gap);
    }
  }
  const ordinaryGaps = positiveGaps.filter((gap) => gap <= medianHeight * 1.5);
  const medianLineGap = median(ordinaryGaps.length ? ordinaryGaps : positiveGaps) || medianHeight * 0.35;
  const ordered = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const paragraphBreak = lineIndex > 0 && lineParagraphBoundary(lines[lineIndex - 1], line, { medianHeight, medianLineGap });
    for (let wordIndex = 0; wordIndex < line.words.length; wordIndex += 1) {
      const item = line.words[wordIndex];
      ordered.push({ ...item.word, __lineIndex: lineIndex,
        __preferredSeparator: ordered.length ? (wordIndex === 0 && paragraphBreak ? '\n\n' : ' ') : '' });
    }
  }
  return ordered;
}

function assembleWords(orderedWords) {
  let text = '';
  let previous = null;
  const spans = [];
  for (const word of orderedWords) {
    const separatorBefore = getOcrWordSeparator(previous?.text, word.text, previous ? word.__preferredSeparator : '');
    text += separatorBefore;
    const start = text.length;
    text += word.text;
    const end = text.length;
    const cleanWord = { ...word };
    delete cleanWord.__inputIndex;
    delete cleanWord.__lineIndex;
    delete cleanWord.__preferredSeparator;
    spans.push({ word: cleanWord, wordId: cleanWord.id, start, end, separatorBefore,
      fileId: cleanWord.fileId, page: cleanWord.page, bbox: cleanWord.bbox });
    previous = cleanWord;
  }
  return { text, spans, separators: spans.map((span) => span.separatorBefore), words: spans.map((span) => span.word) };
}

function buildNormalizedTranscriptFromWords(words, isNewLine) {
  const ordered = (Array.isArray(words) ? words : []).map((word, index, list) => {
    const hint = index && typeof isNewLine === 'function' ? isNewLine(list[index - 1], word) : false;
    return { ...word, __preferredSeparator: hint === '\n\n' ? '\n\n' : hint ? '\n' : index ? ' ' : '' };
  }).filter((word) => typeof word.text === 'string' && word.text.trim()).map((word) => ({ ...word, text: word.text.trim() }));
  return assembleWords(ordered);
}

function paragraphsFromSpans(text, spans) {
  if (!text) return [];
  const paragraphs = [];
  let startChar = 0;
  for (let index = text.indexOf('\n\n'); index >= 0; index = text.indexOf('\n\n', index + 2)) {
    const endChar = index;
    paragraphs.push({ startChar, endChar, text: text.slice(startChar, endChar),
      wordIds: spans.filter((span) => span.start >= startChar && span.end <= endChar && span.wordId).map((span) => String(span.wordId)) });
    startChar = index + 2;
  }
  paragraphs.push({ startChar, endChar: text.length, text: text.slice(startChar),
    wordIds: spans.filter((span) => span.start >= startChar && span.end <= text.length && span.wordId).map((span) => String(span.wordId)) });
  return paragraphs.filter((paragraph) => paragraph.text);
}

function buildCanonicalPageFromWords(words) {
  const built = assembleWords(orderWordsAndSeparators(words));
  return { ...built, paragraphs: paragraphsFromSpans(built.text, built.spans), version: CANONICAL_TRANSCRIPT_LAYOUT_VERSION };
}

function alignWordsToAuthoritativeText(authoritativeText, words) {
  const text = normalizeLegacyDisplayText(authoritativeText || '');
  const sourceWords = (Array.isArray(words) ? words : []).filter((word) => typeof word?.text === 'string' && word.text.trim());
  const lower = text.toLocaleLowerCase();
  const spans = [];
  let cursor = 0;
  let mapped = 0;
  for (const word of sourceWords) {
    const token = word.text.trim();
    const index = lower.indexOf(token.toLocaleLowerCase(), cursor);
    if (index < 0) continue;
    const separatorBefore = spans.length ? text.slice(spans[spans.length - 1].end, index) : text.slice(0, index);
    const cleanWord = { ...word, text: text.slice(index, index + token.length) };
    spans.push({ word: cleanWord, wordId: cleanWord.id, start: index, end: index + token.length,
      separatorBefore, fileId: cleanWord.fileId, page: cleanWord.page, bbox: cleanWord.bbox });
    cursor = index + token.length;
    mapped += 1;
  }
  return { text, spans, words: spans.map((span) => span.word), separators: spans.map((span) => span.separatorBefore),
    mapping: { totalWords: sourceWords.length, mappedWords: mapped,
      alignmentRatio: sourceWords.length ? mapped / sourceWords.length : (text ? 0 : 1) } };
}

function assessCanonicalTranscriptQuality(canonical) {
  const pages = Array.isArray(canonical?.pages) ? canonical.pages : [];
  const diagnostics = pages.map((page) => ({ fileId: page.fileId, pageNumber: page.pageNumber,
    layoutDegraded:page.layoutDegraded===true,
    alignmentRatio: Number(page.mapping?.alignmentRatio ?? 1), mappedWords: Number(page.mapping?.mappedWords || 0),
    totalWords: Number(page.mapping?.totalWords || 0) }));
  const unreliable = diagnostics.find((item) => item.layoutDegraded||item.totalWords >= 8 && item.alignmentRatio < 0.6);
  return { reliable: !unreliable && Boolean(String(canonical?.text || '').trim()),
    code: unreliable ? 'OCR_READING_ORDER_UNRELIABLE' : (!String(canonical?.text || '').trim() ? 'OCR_TEXT_EMPTY' : null),
    diagnostics };
}

function normalizeLegacyDisplayText(value) {
  const lines = normalizeOcrTranscript(value).split('\n');
  const paragraphs = [];
  let current = [];
  const flush = () => { if (current.length) paragraphs.push(current.join(' ').replace(/\s+/gu, ' ').trim()); current = []; };
  for (const line of lines) {
    if (!line) flush(); else current.push(line);
  }
  flush();
  return paragraphs.filter(Boolean).join('\n\n');
}

function getNormalizedSubmissionTranscript(submission) {
  return buildCanonicalSubmissionTranscript(submission).text;
}

function buildCanonicalSubmissionTranscript(submission) {
  if (require('./sourceFidelity').isExact(submission)) return require('./sourceFidelity').canonical(submission);
  const empty = { text: '', pages: [], paragraphs: [], wordSpans: [], separators: [], source: 'none',
    isComplete: false, version: CANONICAL_TRANSCRIPT_LAYOUT_VERSION };
  if (!submission || typeof submission !== 'object') return empty;
  const explicitOrder = Array.isArray(submission.fileOrder) ? submission.fileOrder
    .map((entry) => ({ id: String(entry?.fileId?._id || entry?.fileId || ''), order: Number(entry?.order) }))
    .filter((entry) => entry.id && Number.isFinite(entry.order)).sort((a, b) => a.order - b.order) : [];
  // Legacy records fall back deterministically to the persisted Submission.files array order.
  const expected = (explicitOrder.length ? explicitOrder.map((entry) => entry.id)
    : (Array.isArray(submission.files) && submission.files.length ? submission.files : (submission.file ? [submission.file] : [])))
    .map((item) => String(item?._id || item));
  const order = new Map(expected.map((id, index) => [id, index]));
  const seen = new Set();
  const storedPages=Array.isArray(submission.ocrPages)?submission.ocrPages:[];
  const inputPages=!storedPages.length&&submission.ocrData?.readingOrderStrategy===HANDWRITING_LAYOUT_VERSION
    ?[{fileId:expected[0]||'legacy',pageNumber:1,pageIndex:0,words:submission.ocrData.words||[],ocrPipelineVersion:HANDWRITING_LAYOUT_VERSION,
      studentSourceVersion:submission.ocrData.studentSourceVersion,studentSourceTextSha256:submission.ocrData.studentSourceTextSha256}]:storedPages;
  const pages = inputPages
    .map((page, originalIndex) => ({ page, originalIndex, fileId: String(page?.fileId?._id || page?.fileId || ''),
      fileOrder: Number.isFinite(Number(page?.fileOrder)) ? Number(page.fileOrder) : null,
      pageNumber: Number(page?.pageNumber || 1), pageIndex: Number.isFinite(Number(page?.pageIndex)) ? Number(page.pageIndex) : null }))
    .filter(({ page, fileId, pageNumber }) => page && fileId && Number.isFinite(pageNumber))
    .sort((a, b) => (order.get(a.fileId) ?? a.fileOrder ?? Number.MAX_SAFE_INTEGER)
      - (order.get(b.fileId) ?? b.fileOrder ?? Number.MAX_SAFE_INTEGER)
      || (a.pageIndex ?? a.pageNumber - 1) - (b.pageIndex ?? b.pageNumber - 1)
      || a.pageNumber - b.pageNumber || a.originalIndex - b.originalIndex)
    .filter(({ fileId, pageNumber }) => { const key = `${fileId}:${pageNumber}`; if (seen.has(key)) return false; seen.add(key); return true; });
  const completed = new Set(pages.filter(({ page }) => page.ocrPipelineVersion===HANDWRITING_LAYOUT_VERSION
    ?!(page.studentSourceVersion?require('./legacyStudentSource').assembleActive(page.words||[],page.studentSourceTextSha256):buildHandwritingGeometryTranscript(page.words||[])).layoutDegraded:normalizeOcrTranscript(page.text || '') || buildCanonicalPageFromWords(page.words || []).text)
    .map(({ fileId }) => fileId));
  const isComplete = expected.length > 0 && expected.every((id) => completed.has(id));
  let text = '';
  let lastWordText = '';
  const manifest = [];
  const wordSpans = [];
  for (const entry of pages) {
    const identifiedWords = (Array.isArray(entry.page.words) ? entry.page.words : []).map((word, index) => ({
      ...word,
      id: canonicalOcrWordId({ fileId: entry.fileId, pageNumber: entry.pageNumber,
        storedWordId: word?.id, wordIndex: index }),
      fileId: entry.fileId,
      page: entry.pageNumber
    }));
    const handwriting=entry.page.ocrPipelineVersion===HANDWRITING_LAYOUT_VERSION;
    const structured = handwriting?(entry.page.studentSourceVersion?require('./legacyStudentSource').assembleActive(identifiedWords,entry.page.studentSourceTextSha256):buildHandwritingGeometryTranscript(identifiedWords)):buildCanonicalPageFromWords(identifiedWords);
    const authoritativeText = handwriting?'':normalizeLegacyDisplayText(entry.page.rawText || '');
    const authoritative = authoritativeText ? alignWordsToAuthoritativeText(authoritativeText, identifiedWords) : null;
    const selected = authoritative || structured;
    const pageText = handwriting?selected.text:selected.text || normalizeLegacyDisplayText(entry.page.text || '');
    if (!pageText){if(handwriting&&selected.layoutDegraded)manifest.push({fileId:entry.fileId,pageNumber:entry.pageNumber,text:'',layoutDegraded:true,mapping:{totalWords:identifiedWords.length,mappedWords:0,alignmentRatio:0}});continue;}
    const pageSeparator = text ? (handwriting?'\n\n':getOcrWordSeparator(lastWordText || text.slice(-1), pageText, ' ')) : '';
    text += pageSeparator;
    const startChar = text.length;
    text += pageText;
    const pageSpans = selected.spans.map((span, index) => ({ ...span,
      start: span.start + startChar, end: span.end + startChar,
      separatorBefore: index === 0 ? pageSeparator : span.separatorBefore,
      fileId: entry.fileId, page: entry.pageNumber }));
    wordSpans.push(...pageSpans);
    manifest.push({ fileId: entry.fileId,
      fileOrder: order.get(entry.fileId) ?? entry.fileOrder ?? Number.MAX_SAFE_INTEGER,
      pageNumber: entry.pageNumber, pageIndex: entry.pageIndex ?? entry.pageNumber - 1, text: pageText,
      source: handwriting?'handwritingGeometry':authoritative ? 'visionFullText' : 'wordReconstruction', mapping: selected.mapping || null,
      startChar, endChar: text.length, words: pageSpans.map((span) => ({ ...span.word, fileId: entry.fileId,
      page: entry.pageNumber, separatorBefore: span.separatorBefore })), paragraphs: paragraphsFromSpans(pageText, selected.spans).map((paragraph) => ({
        ...paragraph, startChar: paragraph.startChar + startChar, endChar: paragraph.endChar + startChar })) });
    lastWordText = selected.spans[selected.spans.length - 1]?.word?.text || pageText;
  }
  if (text||manifest.some(p=>p.layoutDegraded)) return { text, pages: manifest, paragraphs: paragraphsFromSpans(text, wordSpans), wordSpans,
    separators: wordSpans.map((span) => span.separatorBefore), source: 'ocrPages', isComplete,
    version: CANONICAL_TRANSCRIPT_LAYOUT_VERSION };
  const fallbacks = [['combinedOcrText', submission.combinedOcrText], ['transcriptText', submission.transcriptText], ['ocrText', submission.ocrText]];
  for (const [source, value] of fallbacks) {
    const fallbackText = normalizeLegacyDisplayText(value || '');
    if (fallbackText) return { ...empty, text: fallbackText, paragraphs: paragraphsFromSpans(fallbackText, []), source,
      isComplete: expected.length <= 1 };
  }
  return empty;
}

function withNormalizedWordSeparators(words) {
  return buildCanonicalPageFromWords(words).spans.map((span) => ({ ...span.word, separatorBefore: span.separatorBefore }));
}

module.exports = {
  CANONICAL_TRANSCRIPT_LAYOUT_VERSION,
  HANDWRITING_LAYOUT_VERSION,
  buildHandwritingGeometryTranscript,
  normalizeOcrTranscript,
  getOcrWordSeparator,
  buildNormalizedTranscriptFromWords,
  buildCanonicalPageFromWords,
  alignWordsToAuthoritativeText,
  assessCanonicalTranscriptQuality,
  sanitizeOcrMarginArtifacts,
  normalizeLegacyDisplayText,
  buildCanonicalSubmissionTranscript,
  getNormalizedSubmissionTranscript,
  withNormalizedWordSeparators
};
