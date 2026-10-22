'use strict';
const {alignGeometry}=require('../src/services/gptVisionExact/alignment');
const {normalizeOcrWordsFromStored}=require('../src/services/ocrCorrections.service');
const sf=require('../src/utils/sourceFidelity');
const {buildCorrectionSourceHash}=require('../src/services/canonicalCorrectionsPipeline.service');
const {buildCanonicalCorrectionRenderModels}=require('../src/services/canonicalCorrectionRender.service');
function fixture(){
  const first='Social and cultural expectations shape Louise Mallard because the society'.split(' ');
  const tokens=Array.from({length:100},(_,i)=>first[i]||`word${String(i).padStart(3,'0')}`);
  const text=tokens.map((t,i)=>(i?i%10===0?'\n':' ':'')+t).join('');
  const google={words:tokens.slice(20,80).map((text,i)=>({text:i===0?text.toUpperCase():text,id:`google_${i}`,page:1,
    bbox:{x:3+(i%10)*8,y:10+Math.floor(i/10)*10,w:6,h:5}}))};
  return {text,tokens,google};
}
function canonicalFor(text,words){
  const doc={files:['f'],sourceFidelityMode:'gpt_vision_exact',ocrPages:[{fileId:'f',pageNumber:1,pageIndex:0,fileOrder:0,
    sourceTextExact:text,sourceTextSha256:sf.sha(text),sourceFidelityMode:'gpt_vision_exact',sourceFidelityVersion:'gpt-vision-exact-v1',sourceFidelityStatus:'GPT_SOURCE_ACCEPTED',
    sourceInputSha256:sf.sha('pixels'),sourceSha256:sf.sha('original'),words}]};
  Object.assign(doc,sf.aggregate(doc));return sf.canonical(doc);
}
test('100 active tokens with 60 boxes retain exact source/order/IDs and all 40 null-box words in the public converter',()=>{
  const f=fixture(),r=alignGeometry(f.text,f.google,{fileId:'f',pageNumber:1});
  expect(r.words).toHaveLength(100);expect(r.coverage).toBe(.6);expect(r.words.filter(w=>!w.bbox)).toHaveLength(40);
  const stored=r.words.map(w=>({...w,bbox:w.bbox?{x0:w.bbox.x,y0:w.bbox.y,x1:w.bbox.x+w.bbox.w,y1:w.bbox.y+w.bbox.h}:null}));
  const canonical=canonicalFor(f.text,stored),page=canonical.pages[0];
  const publicWords=normalizeOcrWordsFromStored(page.words,{fileId:'f',preserveSourceTokens:true});
  expect(publicWords).toHaveLength(100);expect(publicWords.filter(w=>w.bbox===null)).toHaveLength(40);expect(publicWords[0].text).toBe('Social');
  expect(publicWords.map(w=>w.text)).toEqual(f.tokens);expect(publicWords.map(w=>w.id)).toEqual(canonical.wordSpans.map(s=>s.wordId));
  for(const span of canonical.wordSpans)expect(publicWords.filter(w=>w.id===span.wordId)).toHaveLength(1);
  expect(publicWords.map(w=>w.separatorBefore+w.text).join('')).toBe(f.text);
  expect(publicWords[20]).toMatchObject({text:'word020',fileId:'f',page:1,bbox:{x:3,y:10,w:6,h:5}});
  expect(publicWords[10].separatorBefore).toBe('\n');expect(publicWords[0].bbox).toBeNull();
  expect(r.words.map(w=>w.separatorBefore+w.text).join('')).toBe(f.text);
  const empty=alignGeometry(f.text,null,{fileId:'f',pageNumber:1}),without=canonicalFor(f.text,empty.words);
  expect(empty.words.map(w=>w.id)).toEqual(r.words.map(w=>w.id));expect(without.text).toBe(canonical.text);expect(empty.textSha256).toBe(r.textSha256);
  expect(buildCorrectionSourceHash({transcript:without.text,pages:without.pages})).toBe(buildCorrectionSourceHash({transcript:canonical.text,pages:canonical.pages}));
  const span=canonical.wordSpans[0],correction={id:'c',fileId:'f',page:1,symbol:'SP',wordIds:[span.wordId],quotedText:'Social',originalText:'Social',startChar:span.start,endChar:span.end};
  const rendered=buildCanonicalCorrectionRenderModels([correction],canonical)[0];
  expect(rendered.wordIds).toEqual([span.wordId]);expect(rendered.quotedText).toBe('Social');expect(rendered.renderTarget.boxes).toEqual([]);
});
test('legacy/default and Astra geometry-only converter behavior is unchanged',()=>{
  const words=[{id:'word_f_1_gpt_1',text:'Social',page:1,bbox:null},{id:'word_f_1_gpt_2',text:'and',page:1,bbox:{x0:1,y0:2,x1:3,y1:4}}];
  expect(normalizeOcrWordsFromStored(words,{fileId:'f'}).map(w=>w.text)).toEqual(['and']);
  expect(normalizeOcrWordsFromStored(words,{fileId:'f',preserveSourceTokens:true}).map(w=>w.text)).toEqual(['Social','and']);
});
test('exact leading/inter-token whitespace is carried in source token separators without text repair',()=>{
  const text='  Society\nSay  powerfull , society',r=alignGeometry(text,null,{fileId:'f',pageNumber:1});
  expect(r.words.map(w=>w.separatorBefore+w.text).join('')).toBe(text);
  const words=normalizeOcrWordsFromStored(r.words,{fileId:'f',preserveSourceTokens:true});expect(words.map(w=>w.separatorBefore+w.text).join('')).toBe(text);
});
