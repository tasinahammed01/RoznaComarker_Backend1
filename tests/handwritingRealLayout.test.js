'use strict';
const {buildHandwritingGeometryTranscript:build}=require('../src/utils/ocrTranscriptNormalizer');
const w=(id,text,x,y,h=10,width=18)=>({id,text,bbox:{x0:x,y0:y,x1:x+width,y1:y+h}});
test('one missing box between immediate same-line anchors resolves exactly once',()=>{
  const input=[w('a','relize',0,0),{id:'b',text:'Social,'},w('c','preception',60,0)];
  const r=build(input);expect(r.layoutDegraded).toBe(false);expect(r.text).toBe('relize Social, preception');
  expect(r.rawGeometryCoverage).toBeCloseTo(2/3);expect(r.resolvedPlacementCoverage).toBe(1);expect(r.fallbackPlacementCount).toBe(1);expect(r.unresolvedWordCount).toBe(0);
  expect(r.words.map(w=>w.id)).toEqual(['a','b','c']);expect(r.words.map(w=>w.text)).toEqual(input.map(w=>w.text));
});
test('missing box with different-line neighbors rejects without dropping the word',()=>{
  const r=build([w('a','first',0,0),{id:'b',text:'SECRET STUDENT WORD'},w('c','next',0,20)]);
  expect(r.layoutDegraded).toBe(true);expect(r.reason).toBe('MISSING_GEOMETRY_UNRESOLVED');expect(r.unresolvedWordCount).toBe(1);expect(r.resolvedWordCount).toBe(2);expect(r.detectedWordCount).toBe(3);expect(r.text).toBe('');
});
test('reversed or nonconsecutive geometric neighbors do not prove a source-order slot',()=>{
  expect(build([w('r','right',60,0),{text:'middle'},w('l','left',0,0)]).layoutDegraded).toBe(true);
  expect(build([w('l','left',0,0),{text:'unknown'},w('r','right',60,0),w('m','middle',30,0)]).layoutDegraded).toBe(true);
});
test('normal/tall/short punctuation boxes use second-pass geometric attachment',()=>{
  const input=[w('a','FIRST',0,10),w('t','Tall',25,0,20),w('p',',',46,18,2,2),w('b','sence',60,10),w('c','Next',0,30),w('d','line',60,30)];
  const r=build(input);expect(r.text).toBe('FIRST Tall, sence\nNext line');expect(r.resolvedPlacementCoverage).toBe(1);expect(r.words).toHaveLength(input.length);
});
test('large retraced box with a proven neighbor slot does not create a line or override its position',()=>{
  const r=build([w('a','left',10,10),w('r','rETraced',0,6,18,80),w('b','right',70,10),w('c','Next',10,30),w('d','line',70,30)]);
  expect(r.layoutDegraded).toBe(false);expect(r.text).toBe('left rETraced right\nNext line');expect(r.lineCount).toBe(2);expect(r.fallbackPlacementCount).toBe(1);
});
function tied(neighbors=true){const c=w('t','relizing',30,5);return neighbors?[w('a','left',0,0),c,w('b','right',60,0),w('c','lower',0,10),w('d','row',60,10)]:[c,w('a','left',0,0),w('b','right',60,0),w('c','lower',0,10),w('d','row',60,10)];}
test('near-tied geometry resolves only through same-line immediate reliable neighbors',()=>{
  const r=build(tied());expect(r.layoutDegraded).toBe(false);expect(r.text).toBe('left relizing right\nlower row');expect(r.ambiguousWordCount).toBe(1);expect(r.fallbackPlacementCount).toBe(1);
});
test('genuinely tied geometry without proven neighbors still rejects',()=>{
  const r=build(tied(false));expect(r.layoutDegraded).toBe(true);expect(r.reason).toBe('AMBIGUOUS_LINE_MEMBERSHIP');expect(r.unresolvedWordCount).toBe(1);
});
test('slight overlap and repeated literal words neither drop nor duplicate detections',()=>{
  const input=[w('a','same',0,0,10,22),w('b','same',20,0,10,22),{id:'c',text:'"same?"'},w('d','same',80,0,10,22)];
  const r=build(input);expect(r.layoutDegraded).toBe(false);expect(r.words.map(w=>w.id)).toEqual(['a','b','c','d']);expect(new Set(r.words.map(w=>w.id)).size).toBe(input.length);
  for(const s of r.spans)expect(r.text.slice(s.start,s.end)).toBe(s.word.text);
});
test('missing boundary words and chains without two immediate reliable neighbors remain unresolved',()=>{
  for(const input of [[{text:'start'},w('a','anchor',0,0)],[w('a','left',0,0),{text:'one'},{text:'two'},w('b','right',80,0)]])expect(build(input).layoutDegraded).toBe(true);
});
test('invalid geometry is structurally resolvable, not silently discarded',()=>{
  const r=build([w('a','got',0,0),w('bad','rid off',30,0,-2),w('b','preception',60,0)]);
  expect(r.text).toBe('got rid off preception');expect(r.rawGeometryCoverage).toBeLessThan(1);expect(r.resolvedPlacementCoverage).toBe(1);
});
