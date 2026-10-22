'use strict';
const {buildHandwritingGeometryTranscript:build}=require('../src/utils/ocrTranscriptNormalizer');
const w=(id,text,x,y,h=10,width=20)=>({id,text,bbox:{x0:x,y0:y,x1:x+width,y1:y+h}});
const anchors=()=>[w('a','left',0,10,10,40),w('b','right',60,10)];
const outlier=(text='?')=>w('o',text,30,14,3,5);
test.each(['?','rEtraced, preception'])('sole-candidate geometry is glyph/length independent: %s',text=>{
  const input=[outlier(text),...anchors(),w('n','Next',0,30),w('e','row',60,30)],r=build(input);
  expect(r.layoutDegraded).toBe(false);expect(r.soleCandidateOutlierPlacementCount).toBe(1);expect(r.lineCount).toBe(2);
  expect(r.words.map(w=>w.id)).toEqual(['a','o','b','n','e']);expect(r.resolvedPlacementCoverage).toBe(1);expect(r.unresolvedWordCount).toBe(0);
  expect(r.words.map(w=>w.text)).toEqual(['left',text,'right','Next','row']);expect(r.text).toContain('\nNext row');
  expect(new Set(r.words.map(w=>w.id)).size).toBe(input.length);expect(r.spans).toHaveLength(input.length);
  for(const s of r.spans)expect(r.text.slice(s.start,s.end)).toBe(s.word.text);
});
test('sole candidate with weak vertical fit remains unresolved with numeric diagnostics',()=>{
  const r=build([w('o','?',30,18,10,5),...anchors()]);expect(r.layoutDegraded).toBe(true);expect(r.reason).toBe('UNRESOLVED_OUTLIER');
  const d=r.unresolvedDescriptors.find(d=>d.inputIndex===0);expect(d.candidateLineCount).toBe(1);expect(d.normalizedCenterDistance).toBeGreaterThan(.55);expect(d.verticalOverlapRatio).toBeLessThan(.5);
});
test('a sole plausible line cannot override substantial overlap with another physical line',()=>{
  const r=build([w('o','?',30,-10,40,5),...anchors(),w('u','upper',0,-5,10,40),w('v','row',60,-5)]);
  expect(r.layoutDegraded).toBe(true);expect(r.unresolvedDescriptors.find(d=>d.inputIndex===0).candidateLineCount).toBe(1);expect(r.soleCandidateOutlierPlacementCount).toBe(0);
});
test('detached page-margin geometry is not authorized by its sole vertical candidate',()=>{
  const r=build([w('o','?',-100,14,3,160),w('a','left',40,10),w('b','right',80,10)]);
  expect(r.layoutDegraded).toBe(true);const d=r.unresolvedDescriptors.find(d=>d.inputIndex===0);expect(d.candidateLineCount).toBe(1);expect(d.edgeArtifactRisk).toBe(true);
});
test('equal horizontal centers do not establish a deterministic insertion',()=>{
  const r=build([w('o','?',17.5,14,3,5),...anchors()]);expect(r.layoutDegraded).toBe(true);
  expect(r.unresolvedDescriptors.find(d=>d.inputIndex===0).horizontalInsertionResolved).toBe(false);
});
test('supporting immediate neighbors retain the existing proven local structural placement',()=>{
  const [a,b]=anchors(),r=build([a,outlier('X'),b]);expect(r.layoutDegraded).toBe(false);expect(r.words.map(w=>w.id)).toEqual(['a','o','b']);expect(r.fallbackPlacementCount).toBe(1);
});
test('conflicting source traversal cannot move a sole outlier away from its geometry slot',()=>{
  const [a,b]=anchors(),r=build([b,outlier('X'),a]);expect(r.layoutDegraded).toBe(false);expect(r.words.map(w=>w.id)).toEqual(['a','o','b']);expect(r.soleCandidateOutlierPlacementCount).toBe(1);
});
test('resolved sole outliers cannot become recursive fallback anchors',()=>{
  const r=build([outlier('X'),{id:'missing',text:'unknown'},...anchors()]);
  expect(r.layoutDegraded).toBe(true);expect(r.soleCandidateOutlierPlacementCount).toBe(1);expect(r.reason).toBe('MISSING_GEOMETRY_UNRESOLVED');expect(r.unresolvedWordCount).toBe(1);
});
test('zero candidates and genuinely competing lines retain rejection',()=>{
  const zero=build([w('o','?',30,100,2,5),...anchors()]);expect(zero.layoutDegraded).toBe(true);expect(zero.unresolvedDescriptors[0].candidateLineCount).toBe(0);
  const tied=build([w('o','?',30,5),w('a','top',0,0),w('b','row',60,0),w('c','bottom',0,10),w('d','row',60,10)]);
  expect(tied.layoutDegraded).toBe(true);expect(tied.soleCandidateOutlierPlacementCount).toBe(0);
});
