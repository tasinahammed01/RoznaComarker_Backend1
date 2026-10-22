'use strict';
const {diff,classify,geometryCoverage,exportEvidence,reviewState,sha}=require('../scripts/lib/ocrSourceAudit.cjs');
const {retrieve}=require('../scripts/ocr-source-audit.cjs');
test('case-sensitive exact diff and reconstruction preserve all input characters',()=>{
  const result=diff('Shape\nSocial','shape\nSocial','character');
  expect(result.hunks[0]).toMatchObject({left:'S',right:'s',categories:['CAPITALIZATION_ONLY']});
  expect(result.operations.map(o=>o.left?.text||'').join('')).toBe('Shape\nSocial');
});
test.each([['to divote','to be divote','INSERTION'],['to be divote','to divote','DELETION'],['free,','free.','PUNCTUATION'],['free,free','free, free','INSERTION']])('%s -> %s exposes %s without repair',(a,b,category)=>{
  expect(diff(a,b,'character').operations.some(o=>o.category===category)).toBe(true);
});
test('whitespace replacement stays separate and lexical differences are explicit',()=>{
  expect(diff('a\nb','a b','character').hunks[0].categories).toContain('WHITESPACE');
  expect(diff('wemen','women').hunks[0].categories).toContain('LEXICAL_SUBSTITUTION');
});
test.each([['sense','sense','BOTH_MODELS_SAME_WRONG'],['sense','sence','ASTRA_ONLY_ERROR'],['sence','sense','FABLE_ONLY_ERROR'],['sense','scene','ASTRA_FABLE_DISAGREEMENT']])('shared/independent errors: %s, %s',(a,b,classification)=>{
  expect(classify('sence',a,b).findings.some(f=>f.classification===classification)).toBe(true);
});
test('pending human spans never become counted confirmed gold errors',()=>{
  const findings=classify('marrid wemen','women','women',[{start:0,end:6,quote:'marrid',status:'PROVISIONAL_HUMAN_READ'}]).findings;
  expect(findings.some(f=>f.classification==='HUMAN_GOLD_PENDING')).toBe(true);
  expect(classify('marrid','marrid','marrid',[{start:0,end:6,quote:'marrid'}]).counts.HUMAN_GOLD_PENDING).toBe(1);
});
const boxes=['shift','The','Judiment','of','any'].map((text,i)=>({id:'g'+i,text,paragraphIndex:1,
  polygon:[{x:i*30,y:10},{x:i*30+20,y:10},{x:i*30+20,y:25},{x:i*30,y:25}]}));
test('distinct middle word box creates possible omission, not replacement authority',()=>{
  const reader='shift The of any',before=JSON.stringify(boxes);const result=geometryCoverage(boxes,reader);
  expect(result.wordBoxCount).toBe(5);expect(result.readerTokenCount).toBe(4);
  expect(result.gaps[0]).toMatchObject({type:'POSSIBLE_READER_OMISSION',geometryWordIds:['g2'],replacement:null,sourceAuthority:false,leftAnchor:'The',rightAnchor:'of'});
  expect(reader).toBe('shift The of any');expect(JSON.stringify(boxes)).toBe(before);
});
test('separate punctuation box is not reported as an omitted word',()=>{
  const words=['wemen',',','such'].map((text,i)=>({...boxes[i],id:'p'+i,text}));
  expect(geometryCoverage(words,'wemen, such').gaps).toEqual([]);
});
test('substitution beside an unoccupied box exposes the entire anchored interval without choosing a missing word',()=>{
  const words=['context','mmakrid','wemen','such'].map((text,i)=>({...boxes[i],id:'a'+i,text}));
  const gap=geometryCoverage(words,'context women such').gaps[0];
  expect(gap).toMatchObject({assignmentIsProven:false,replacement:null,sourceAuthority:false,
    anchoredInterval:{geometryWordIds:['a1','a2'],geometryBoxCount:2,readerLexicalTokenCount:1,boxCountDeficit:1}});
});
test('diagnostics can only preserve or increase uncertainty, including legacy absence',()=>{
  expect(reviewState('MODEL_AGREED',true)).toBe('OCR_UNCERTAIN');
  for(const status of ['OCR_UNCERTAIN','PROVIDER_FAILED','SOURCE_UNREADABLE',undefined])expect(reviewState(status,false)).toBe(status);
});
test('export uses current job/file/page/hash identity and allowlists private output',()=>{
  const text='sence',p={fileId:'f',pageNumber:1,sourceInputSha256:'hash',sourceTextExact:text,sourceTextSha256:sha(text),words:[]};
  const submission={_id:'s',ocrJobId:'job',sourceTranscriptExact:text,ocrPages:[p],guest:{normalizedEmail:'secret@example.test'},jwt:'secret-jwt'};
  const value={activeTranscript:text,segments:[],uncertainSpans:[],apiKey:'must-not-export'};
  const evidence=[{identity:{submissionId:'s',runId:'old-job',fileId:'f',pageNumber:1,inputSha256:'hash'},payload:{primary:{...value,activeTranscript:'old'}}},
    {identity:{submissionId:'s',runId:'job',fileId:'f',pageNumber:1,inputSha256:'hash',credentialPath:'secret-path'},payload:{primary:value,secondary:value,readers:[{requestedModel:'astra',usage:{cost:.1,apiKey:'secret'}},{}],authorization:'secret'}}];
  const before=JSON.stringify(submission);const result=exportEvidence(submission,evidence);
  expect(result.pages[0].astra.activeTranscript).toBe(text);
  for(const secret of ['secret@example.test','secret-jwt','must-not-export','secret-path','authorization','apiKey'])expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(submission)).toBe(before);
});
test('Mongo retrieval only uses projected find operations, never source writes/providers',async()=>{
  const id='6ad7bfaa7ee2b01125accf51',submission={_id:id,ocrJobId:'job',ocrPages:[]};
  const findOne=jest.fn(async()=>submission),find=jest.fn(()=>({limit:()=>({toArray:async()=>[]})}));
  const collection=jest.fn(()=>({findOne,find}));
  expect((await retrieve({collection},id)).submissionId).toBe(id);
  expect(collection.mock.calls.map(c=>c[0])).toEqual(['submissions','sourcefidelityevidences','submissions']);
  expect(findOne.mock.calls[0][1].projection).not.toHaveProperty('student');
});
