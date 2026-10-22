'use strict';
const sharp=require('sharp');
const source=require('../src/utils/legacyStudentSource');
const {buildCanonicalSubmissionTranscript,HANDWRITING_LAYOUT_VERSION}=require('../src/utils/ocrTranscriptNormalizer');
const prompt="How do social and cultural expectations shape Louise Mallard's choices, feelings, and sense of self?";
function spans(lines){let text='',id=0;return lines.flatMap((line,row)=>line.split(' ').map((word,col)=>{const separatorBefore=id?(col?' ':'\n'):'';text+=separatorBefore;const start=text.length;text+=word;const w={id:'word_f_1_'+(++id),text:word,bbox:{x:5+col*10,y:5+row*10,w:8,h:5},page:1};return {word:w,wordId:w.id,bbox:w.bbox,start,end:text.length,separatorBefore};}));}
const header=["How do social and cultural expectations","shape Louise Mallard's choices, feelings",', and sense of self?'];
test.each([[header],[["HOW do Social and cultural expectations.","shape Louise Mallard's choices, feelings 2.",', and sense of SELF?']]])('exact/stored noisy prompt is matched only at the leading boundary',lines=>{
  const s=spans([...lines,'Social and cultural expectations','shape Louise Mallard because the']);const r=source.promptBoundary(s,{instructions:prompt});
  expect(r.promptLinesExcluded).toBe(3);expect(r.studentTranscriptStartLine).toBe(4);expect(r.promptCandidateDetected).toBe(true);
  expect(r.excludedIds.has(s[lines.join(' ').split(' ').length].wordId)).toBe(false);
});
test('prompt-like body text, absent/short references, and non-top regions are never guessed away',()=>{
  expect(source.promptBoundary(spans(['Student opening words',...header]),{instructions:prompt}).excludedIds.size).toBe(0);
  expect(source.promptBoundary(spans(header),{})).toMatchObject({sourceBoundaryUncertain:true,promptLinesExcluded:0});
  expect(source.promptBoundary(spans(header),{title:'Essay'}).excludedIds.size).toBe(0);
  const lower=spans(header).map(s=>({...s,bbox:{...s.bbox,y:50}}));expect(source.promptBoundary(lower,{question:prompt}).excludedIds.size).toBe(0);
});
function image(){const width=200,height=100,data=Buffer.alloc(width*height,255);return {width,height,data};}
function line(im,x0,y0,x1,y1,thickness=1){const n=Math.max(Math.abs(x1-x0),Math.abs(y1-y0));for(let i=0;i<=n;i++){const x=Math.round(x0+(x1-x0)*i/n),y=Math.round(y0+(y1-y0)*i/n);for(let dy=0;dy<thickness;dy++)for(let dx=0;dx<thickness;dx++)if(x+dx>=0&&x+dx<im.width&&y+dy>=0&&y+dy<im.height)im.data[(y+dy)*im.width+x+dx]=0;}}
function handwriting(im){for(const x of [55,65,75,85,100])line(im,x,32,x,57,3);return im;}
const box={x:25,y:30,w:30,h:30};
test('an obvious local body strikethrough with ink above/below is visually deleted',()=>{const im=handwriting(image());line(im,38,44,122,44);expect(source.deletionEvidence(im,box,.1).status).toBe('VISUALLY_DELETED');});
test('dense multiple crossing strokes are visually deleted without word semantics',()=>{const im=image();for(let y=32;y<=57;y++)line(im,50,y,110,y);expect(source.deletionEvidence(im,box,.1).status).toBe('VISUALLY_DELETED');});
test('a notebook rule alone and ordinary ascenders/descenders are not deletion',()=>{
  const ruled=handwriting(image());line(ruled,0,44,199,44);expect(source.deletionEvidence(ruled,box,.1).status).toBe('ACTIVE');
  const ordinary=handwriting(image());line(ordinary,55,22,55,68,2);expect(source.deletionEvidence(ordinary,box,.1).status).toBe('ACTIVE');
  const underlined=handwriting(image());line(underlined,38,62,122,62);expect(source.deletionEvidence(underlined,box,.1).status).toBe('ACTIVE');
});
test('borderline interior strokes remain uncertain, never automatically deleted',()=>{const im=handwriting(image());line(im,50,44,110,44);expect(source.deletionEvidence(im,box,.1).status).toBe('DELETION_UNCERTAIN');});
test('prompt evidence is private source material; active IDs/boxes/text/newlines/hash survive canonical reconstruction',async()=>{
  const s=spans([...header,'Social and cultural expectations','shape Louise Mallard because the']);const bytes=await sharp({create:{width:200,height:100,channels:3,background:'white'}}).png().toBuffer();
  const r=await source.selectStudentSource({bytes,spans:s,assignment:{instructions:prompt}});
  expect(r.text).toBe('Social and cultural expectations\nshape Louise Mallard because the');expect(r.evidence.excludedPromptCount).toBe(s.length-r.words.length);
  expect(r.words[0].id).toBe(s.find(s=>s.word.text==='Social').wordId);expect(r.words[0].bbox).toEqual(s.find(s=>s.word.text==='Social').bbox);
  const p={fileId:'f',pageNumber:1,ocrPipelineVersion:HANDWRITING_LAYOUT_VERSION,studentSourceVersion:r.version,studentSourceTextSha256:r.textSha256,words:r.words,rawText:prompt};
  const canonical=buildCanonicalSubmissionTranscript({files:['f'],ocrPages:[p]});expect(canonical.text).toBe(r.text);expect(canonical.wordSpans.map(s=>s.wordId)).toEqual(r.words.map(w=>w.id));
  expect(r.textSha256).toBe(source.sha(r.text));expect(r.textSha256).not.toBe(source.sha(prompt+'\n'+r.text));
  const {buildCorrectionSourceHash}=require('../src/services/canonicalCorrectionsPipeline.service');
  const hash=buildCorrectionSourceHash({transcript:canonical.text,pages:canonical.pages});
  const withPrivateEvidence={...p,studentSourceEvidence:{occurrences:[{text:'DIFFERENT PRIVATE PROMPT TEXT'}]}};
  const again=buildCanonicalSubmissionTranscript({files:['f'],ocrPages:[withPrivateEvidence]});
  expect(buildCorrectionSourceHash({transcript:again.text,pages:again.pages})).toBe(hash);
});
test('strong deleted word is excluded; uncertain deletion stays active with original ID and bbox',async()=>{
  for(const strong of [true,false]){
    const im=handwriting(image());line(im,strong?38:50,44,strong?122:110,44);
    const bytes=await sharp(im.data,{raw:{width:im.width,height:im.height,channels:1}}).png().toBuffer();
    const words=[{id:'word_f_1_1',text:'other',bbox:box},{id:'word_f_1_2',text:'Louise',bbox:{x:70,y:30,w:20,h:30}}];
    const s=words.map((word,i)=>({word,wordId:word.id,bbox:word.bbox,separatorBefore:i?' ':''}));const r=await source.selectStudentSource({bytes,spans:s,assignment:{}});
    expect(r.text).toBe(strong?'Louise':'other Louise');expect(r.evidence.occurrences[0].status).toBe(strong?'VISUALLY_DELETED':'DELETION_UNCERTAIN');
    expect(r.evidence.occurrences[0]).toMatchObject({wordId:words[0].id,text:'other',bbox:box});
  }
});
test('source hash mismatch fails without reintroducing private/raw prompt text',()=>{
  const r=source.assembleActive([{id:'x',text:'student',studentSourceStatus:'ACTIVE',separatorBefore:''}],'a'.repeat(64));expect(r.layoutDegraded).toBe(true);expect(r.text).toBe('');
});
test('new private evidence is removed even when serializing a freshly constructed document',()=>{
  const Submission=require('../src/models/Submission');const d=new Submission({ocrPages:[{studentSourceEvidence:{occurrences:[{text:'PRIVATE_DELETED'}]}}]});expect(JSON.stringify(d)).not.toContain('PRIVATE_DELETED');
});
test('historical geometry records are not automatically filtered without the new source marker',()=>{
  const old=buildCanonicalSubmissionTranscript({files:['f'],ocrPages:[{fileId:'f',pageNumber:1,ocrPipelineVersion:HANDWRITING_LAYOUT_VERSION,words:[{id:'a',text:'Question',bbox:{x:5,y:5,w:10,h:5}},{id:'b',text:'student',bbox:{x:5,y:15,w:10,h:5}}]}]});
  expect(old.text).toBe('Question\nstudent');
});
