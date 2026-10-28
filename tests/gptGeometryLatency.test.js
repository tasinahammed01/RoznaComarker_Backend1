'use strict';
const {alignGeometry}=require('../src/services/gptVisionExact/alignment');
const normalizer=require('../src/utils/ocrTranscriptNormalizer');
const {normalizeOcrWordsFromStored}=require('../src/services/ocrCorrections.service');
const {buildCanonicalCorrectionRenderModels}=require('../src/services/canonicalCorrectionRender.service');
const sf=require('../src/utils/sourceFidelity');
const identity={fileId:'f',pageNumber:1};
const geometry=tokens=>({words:tokens.map((text,i)=>({id:'google_'+i,text,page:1,
  bbox:{x:3+(i%10)*8,y:3+Math.floor(i/10)*7,w:6,h:4}}))});
function canonical(text,words){
  const page={fileId:'f',pageNumber:1,pageIndex:0,fileOrder:0,coordinateSpace:'display-image',
    sourceTextExact:text,sourceTextSha256:sf.sha(text),sourceFidelityMode:'gpt_vision_exact',sourceFidelityVersion:'gpt-vision-exact-v1',
    sourceFidelityStatus:'GPT_SOURCE_ACCEPTED',sourceInputSha256:sf.sha('pixels'),sourceSha256:sf.sha('original'),
    words:words.map(w=>({...w,bbox:w.bbox?{x0:w.bbox.x,y0:w.bbox.y,x1:w.bbox.x+w.bbox.w,y1:w.bbox.y+w.bbox.h}:null}))};
  const doc={files:['f'],sourceFidelityMode:'gpt_vision_exact',ocrPages:[page]};Object.assign(doc,sf.aggregate(doc));
  return {value:sf.canonical(doc),page};
}
test.each([null,{x:95,y:80,w:2,h:18}])('strict lexical layout remains all-or-nothing; optional geometry salvages resolved words only (%j)',bbox=>{
  const google=geometry(['Alpha','Beta','Gamma']);google.words.push({text:'unplaced',bbox});
  expect(normalizer.buildHandwritingGeometryTranscript(google.words).layoutDegraded).toBe(true);
  const result=alignGeometry('Alpha Beta Gamma unplaced',google,identity);
  expect(result.words.map(w=>!!w.bbox)).toEqual([true,true,true,false]);
  expect(result.diagnostics.safeOutcomeCode).toBe('GEOMETRY_PARTIAL');
  expect(result.words.map(w=>w.separatorBefore+w.text).join('')).toBe('Alpha Beta Gamma unplaced');
});
test('110 tokens survive partial layout, API conversion and exact correction rendering',()=>{
  const tokens=Array.from({length:110},(_,i)=>'token'+String(i).padStart(3,'0'));
  const text=tokens.map((t,i)=>(i?i%10===0?'\n':' ':'')+t).join('');
  const google=geometry(tokens.slice(0,95));google.words.push({text:'unplaced',bbox:null});
  const result=alignGeometry(text,google,identity), {value,page}=canonical(text,result.words);
  const publicWords=normalizeOcrWordsFromStored(value.pages[0].words,{fileId:'f',preserveSourceTokens:true});
  expect(publicWords).toHaveLength(110);expect(publicWords.filter(w=>w.bbox)).toHaveLength(95);
  expect(publicWords.filter(w=>w.bbox===null)).toHaveLength(15);expect(publicWords.map(w=>w.text)).toEqual(tokens);
  expect(publicWords.map(w=>w.id)).toEqual(tokens.map((_,i)=>`word_f_1_gpt_${i+1}`));
  const corrections=[0,109].map((index,i)=>{const span=value.wordSpans[index];return {id:'c'+i,fileId:'f',page:1,
    category:'MECHANICS',symbol:'SP',wordIds:[span.wordId],quotedText:span.word.text,originalText:span.word.text,startChar:span.start,endChar:span.end};});
  const rendered=buildCanonicalCorrectionRenderModels(corrections,value,[page]);
  expect(rendered[0].renderTarget.source).toBe('wordIds');expect(rendered[0].renderTarget.boxes).toHaveLength(1);
  expect(rendered[1].renderTarget.source).toBe('none');expect(rendered[1].renderTarget.boxes).toEqual([]);
  expect(rendered[1].renderTarget.textRanges).toHaveLength(1);
  const cc=require('../src/services/correctionCanonical.service'),legend=require('../src/services/writingCorrections.service').defaultLegend();
  const finding={symbol:'SP',category:'MECHANICS',quotedText:tokens[0],suggestedText:'replacement',confidence:.99};
  const mapped=cc.normalizeCorrection(finding,text,value.wordSpans,legend,'AI');
  expect(mapped.bboxList).toHaveLength(1);
  const unmapped=cc.normalizeCorrection(finding,text,canonical(text,alignGeometry(text,null,identity).words).value.wordSpans,legend,'AI');
  expect(unmapped.bboxList).toEqual([]);
  expect(cc.canonicalFingerprint([mapped],'source')).toBe(cc.canonicalFingerprint([unmapped],'source'));
});
test('fully mapped case/edit comparison never changes literal GPT spelling or punctuation',()=>{
  const result=alignGeometry('Alpha powerfull Omega',geometry(['ALPHA','powerful','Omega']),identity);
  expect(result.words.every(w=>w.bbox)).toBe(true);expect(result.words.map(w=>w.text)).toEqual(['Alpha','powerfull','Omega']);
});
test('unresolved duplicate geometry never creates false uniqueness',()=>{
  const google=geometry(['echo','Beta','Gamma']);google.words.push({text:'echo',bbox:null});
  const result=alignGeometry('echo Beta Gamma',google,identity);
  expect(result.words[0].bbox).toBeNull();expect(result.words[1].bbox).not.toBeNull();
});
test('no geometry retains all exact tokens and text-only correction evidence',()=>{
  const result=alignGeometry('Alpha\nBeta',null,identity);
  expect(result.words).toHaveLength(2);expect(result.words.every(w=>w.bbox===null)).toBe(true);
  expect(result.words.map(w=>w.separatorBefore+w.text).join('')).toBe('Alpha\nBeta');
});
test('assessment prompt transmits each legend definition once without reducing authority or output capacity',()=>{
  const semantic=require('../src/services/semanticWritingCorrections.service');
  const request=semantic.buildSemanticRequest({transcript:'Exact literal source.',transcriptHash:'hash'});
  const duplicated=request.legend.map(g=>({...g,symbols:g.symbols.map(s=>({...s,rule:s.description}))}));
  expect(JSON.stringify(request.legend).length).toBeLessThan(JSON.stringify(duplicated).length);
  for(const group of request.legend)for(const symbol of group.symbols){expect(symbol.description).toBeTruthy();expect(symbol).not.toHaveProperty('rule');}
  const prompt=request.messages[1].content;
  for(const required of ['reviewedSymbols','including zero findings','teacherEvaluationPolicy=','transcript=Exact literal source.'])expect(prompt).toContain(required);
  expect(prompt).not.toContain('noFindingReason'); // Server derives prose only after explicit reviewed-symbol evidence.
  expect(require('../src/services/semanticAIClient.service').getAssessmentAIConfig({OPENROUTER_API_KEY:'mock-only'})).toMatchObject({model:'google/gemini-3.8-flash',maxOutputTokens:8000});
});
