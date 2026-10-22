'use strict';
const {buildHandwritingGeometryTranscript:build,HANDWRITING_LAYOUT_VERSION,buildCanonicalSubmissionTranscript,assessCanonicalTranscriptQuality}=require('../src/utils/ocrTranscriptNormalizer');
const w=(text,x,y,h=10,width=18)=>({text,id:text+'-'+x+'-'+y,bbox:{x0:x,y0:y,x1:x+width,y1:y+h}});
test('wobbling baselines, shuffled native order, and adjacent lines remain physical lines',()=>{
  const input=[w('line.',65,32),w('sence',35,12),w('Another',5,30),w('Social',5,10),w('relize',65,8),w('wemen',35,28)];
  const r=build(input);expect(r.layoutDegraded).toBe(false);expect(r.text).toBe('Social sence relize\nAnother wemen line.');expect(r.lineCount).toBe(2);
  expect(build([...input].reverse()).text).toBe(r.text);
});
test('ascenders/tall letters cannot create false lines or bridge to neighboring text',()=>{
  const r=build([w('Tall',30,0,20),w('first',5,10),w('line',60,10),w('second',5,30),w('stays',30,30),w('separate',60,30)]);
  expect(r.layoutDegraded).toBe(false);expect(r.text).toBe('first Tall line\nsecond stays separate');
});
test('same-line high and low words rejoin the nearest robust baseline',()=>{
  const r=build([w('One',5,10),w('high',35,5),w('low',65,15),w('end',95,10),w('Next',5,32),w('row',35,32)]);
  expect(r.text).toBe('One high low end\nNext row');
});
test('normal line spacing stays single newline; strong paragraph gap adds blank line without paragraph ids',()=>{
  const r=build([w('First',5,10),w('row',35,10),w('second',5,28),w('row',35,28),w('New',5,75),w('paragraph',35,75)]);
  expect(r.text).toBe('First row\nsecond row\n\nNew paragraph');
});
test('all punctuation, case, spelling and repeated words remain literal',()=>{
  const r=build([w('"relize,"',5,10),w('Social',35,10),w('got rid off',65,10),w('preception!',5,30),w('relizing',35,30),w('relizing',65,30)]);
  expect(r.text).toBe('"relize," Social got rid off\npreception! relizing relizing');
  expect(r.spans.map(s=>r.text.slice(s.start,s.end))).toEqual(r.words.map(w=>w.text));
});
test('line-start punctuation does not eat a physical newline; whitespace inside word text is not normalized',()=>{
  expect(build([w('Hi',5,10),w(',',5,30),w('  Exact  ',35,30)]).text).toBe('Hi\n,   Exact  ');
});
test('missing/invalid geometry degrades without a native-order transcript',()=>{
  for(const word of [{text:'missing'},w('invalid',5,10,-1)]){
    const r=build([w('known',5,10),word]);expect(r.layoutDegraded).toBe(true);expect(r.text).toBe('');expect(r.geometryCoverage.ratio).toBe(.5);
  }
});
test('paragraph index changes never override physical line order',()=>{
  const r=build([{...w('left',5,10),paragraphIndex:999},{...w('right',35,10),paragraphIndex:0},{...w('next',5,30),paragraphIndex:999}]);
  expect(r.text).toBe('left right\nnext');
});
test('canonical persisted handwriting never collapses physical lines or uses raw Google text',()=>{
  const r=buildCanonicalSubmissionTranscript({files:['f'],ocrPages:[{fileId:'f',pageNumber:1,ocrPipelineVersion:HANDWRITING_LAYOUT_VERSION,rawText:'row two row one',words:[w('one',35,10),w('two',35,30),w('row',5,30),w('row',5,10)]}]});
  expect(r.text).toBe('row one\nrow two');expect(r.pages[0].source).toBe('handwritingGeometry');
});
test('persisted incomplete handwriting never falls back to raw text/combined text',()=>{
  const r=buildCanonicalSubmissionTranscript({files:['f'],combinedOcrText:'BAD NATIVE ORDER',ocrPages:[{fileId:'f',pageNumber:1,ocrPipelineVersion:HANDWRITING_LAYOUT_VERSION,rawText:'BAD NATIVE ORDER',words:[{text:'missing'}]}]});
  expect(r.text).toBe('');expect(assessCanonicalTranscriptQuality(r).reliable).toBe(false);
});
test('unmarked printed/historical native transcript compatibility remains',()=>{
  const r=buildCanonicalSubmissionTranscript({files:['f'],ocrPages:[{fileId:'f',pageNumber:1,rawText:'Printed\nwrap.',words:[]}]});expect(r.text).toBe('Printed wrap.');
});
test('deskew compares spatial neighbors without modifying original word boxes',()=>{
  const words=[];
  for(let row=0;row<3;row++)for(let col=0;col<6;col++)words.push(w(`r${row}c${col}`,col*30,10+row*20+col*30*.08));
  const before=JSON.stringify(words),r=build([...words].reverse());
  expect(r.lineCount).toBe(3);expect(r.words.map(w=>w.id)).toEqual(words.map(w=>w.id));expect(r.comparisonSlope).toBeCloseTo(.08);expect(JSON.stringify(words)).toBe(before);
});
test('indistinguishable overlapping boxes are not ordered by their English content',()=>{
  const r=build([w('Zebra',5,10),w('Apple',5,10)]);expect(r.layoutDegraded).toBe(true);expect(r.text).toBe('');
});
test('single-file handwriting metadata also prevents display normalization of physical newlines',()=>{
  const r=buildCanonicalSubmissionTranscript({file:'f',ocrData:{readingOrderStrategy:HANDWRITING_LAYOUT_VERSION,words:[w('first',5,10),w('next',5,30)]},ocrText:'first next'});
  expect(r.text).toBe('first\nnext');expect(r.pages[0].source).toBe('handwritingGeometry');
});
test('widely but uniformly spaced ruled lines do not become false paragraphs',()=>{
  expect(build([w('one',5,10),w('two',5,45),w('three',5,80)]).text).toBe('one\ntwo\nthree');
});
