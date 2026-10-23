'use strict';
const next=require('../src/services/correctionSourceLocator.service');
const prior=require('../src/services/correctionContractVNext.service');
const legacy=require('../src/services/semanticWritingCorrections.service');
const {fallbackLegend,REQUIRED}=require('../src/services/correctionLegendResolver.service');
const {digest,evidenceKey}=require('../src/services/hybridSource/reconcile');
const identity={submissionId:'s',fileId:'f',runId:'r',pageNumber:1,sourceSha256:'a'.repeat(64),inputSha256:'b'.repeat(64),width:800,height:300,orientation:1};
const input=(transcript='speling',assignment={})=>({transcript,transcriptHash:digest(transcript),identity:{...identity},legend:fallbackLegend(),assignment});
const codeCategory=code=>Object.keys(REQUIRED).find(k=>REQUIRED[k].includes(code));
const locator=(i,q,lines=[0],localAnchorId=null)=>({sourceLineIds:lines.map(n=>next.sourceDocument(i.transcript).lines[n].id),exactQuote:q,localAnchorId});
const record=(i,q='speling',s='spelling',code='SP',lines=[0],anchor=null)=>({category:codeCategory(code),symbol:code,message:'Synthetic exact error.',suggestedText:s,
 correctionKind:'localized',confidence:1,severity:'low',stylePreference:false,sourceEvidence:locator(i,q,lines,anchor),assignmentEvidence:{criterionId:null},rationale:'Synthetic demonstrable error.'});
const envelope=(i,corrections)=>({transcriptHash:i.transcriptHash,reviews:Object.fromEntries(Object.entries(REQUIRED).map(([key,symbols])=>[key,{reviewed:true,reviewedSymbols:[...symbols],noFindingReason:'Review complete without forced findings.'}])),corrections});
const normalize=(i,records)=>next.normalize(i,envelope(i,records));
function proof(i){
 const polygon=[{x:10,y:10},{x:100,y:10},{x:100,y:60},{x:10,y:60}],id='word_f_1_1';
 const binding={identity:i.identity,sourceTranscriptSha256:i.transcriptHash,transcriptStart:0,transcriptEnd:i.transcript.length,sourceText:i.transcript,
  classification:'STUDENT_ACTIVE_TEXT',state:'VERIFIED_SOURCE',geometryUnique:true,mappedWordIds:[id],wordIds:[id],mappedPolygons:[polygon]};
 return {identity:i.identity,transcript:i.transcript,bindings:[binding],nativeWords:[{id,polygon}],attestations:[{kind:'HUMAN_REVIEWED',reviewer:'synthetic reference',reviewId:'review',
  identity:i.identity,evidenceKey:evidenceKey(i.identity),wordIds:[id],classification:binding.classification,text:i.transcript}]};
}
test('unique misspelling derives exact offsets and canonical occurrence, never provider counts',()=>{
 const i=input(),r=normalize(i,[record(i)]);expect(r.records[0]).toMatchObject({start:0,end:7,canonicalOccurrence:0,status:'CANDIDATE'});
 expect(r.records[0].raw.occurrence).toBe(0);expect(next.authority(r.records[0],r,proof(i)).eligibleOffline).toBe(true);
});
test('same misspelling on separate lines derives independent global identities',()=>{
 const i=input('speling\nspeling'),r=normalize(i,[record(i,'speling','spelling','SP',[0]),record(i,'speling','spelling','SP',[1])]);
 expect(r.candidates.map(c=>[c.start,c.canonicalOccurrence])).toEqual([[0,0],[8,1]]);
});
test('same word twice on one line is ambiguous without a supplied local anchor',()=>{
 const i=input('speling speling'),r=normalize(i,[record(i)]);expect(r.records[0].reasons).toContain('AMBIGUOUS_LOCAL_QUOTE');expect(r.candidates).toHaveLength(0);
});
test('code-owned local anchors distinguish repetitions on the same line',()=>{
 const i=input('speling speling'),anchors=next.sourceDocument(i.transcript).lines[0].localAnchors;
 const r=normalize(i,anchors.map(a=>record(i,'speling','spelling','SP',[0],a.id)));
 expect(r.candidates.map(c=>c.canonicalOccurrence)).toEqual([0,1]);
});
test('overlapping repeated phrases require an anchor at their own first nonspace character',()=>{
 const i=input('go go go'),doc=next.sourceDocument(i.transcript),anchor=doc.lines[0].localAnchors[1];
 const location=next.locate(doc,locator(i,'go go',[0],anchor.id),i.transcript);expect(location).toMatchObject({valid:true,start:3,end:8,occurrence:1});
});
test('line representation preserves mixed newline styles, blank lines, trailing space and final empty line',()=>{
 const text='  Alpha \r\n\rBeta\n\n',doc=next.sourceDocument(text);expect(doc.lines.map(l=>l.text+l.eol).join('')).toBe(text);
 expect(next.providerSource(doc).lines.map(l=>l.text+l.eol).join('')).toBe(text);expect(doc.lines.at(-1).text).toBe('');
 expect(next.sourceDocument(text)).toEqual(doc);expect(next.sourceDocument(text+'x').lines[0].id).not.toBe(doc.lines[0].id);
});
test.each([['winter','Winter','CAP'],['near of','near to','PREP']])('%s is a valid minimal word/necessary phrase', (q,s,c)=>{
 const i=input(q),r=normalize(i,[record(i,q,s,c)]);expect(r.candidates).toHaveLength(1);
});
test.each([['I stayed\nyou left','I stayed.\nYou left'],['Birds flew\nthe storm ended','Birds flew;\nthe storm ended'],['We waited\r\nthey ran','We waited.\r\nThey ran']])(
 'multiline RO preserves exact boundary and whole punctuation/case repair: %s',(q,s)=>{
 const i=input(q),r=normalize(i,[record(i,q,s,'RO',[0,1])]);expect(r.candidates).toHaveLength(1);expect(r.records[0].raw.suggestedText).toBe(s);
});
test.each(['wrong','source-line:fake:0001'])('wrong/nonexistent line ID %s is not rescued',id=>{
 const i=input(),c=record(i);c.sourceEvidence.sourceLineIds=[id];expect(normalize(i,[c]).records[0].reasons).toContain('UNKNOWN_SOURCE_LINE_ID');
});
test('noncontiguous and reversed line selections are rejected',()=>{
 const i=input('one\ntwo\nthree');for(const ids of [[0,2],[1,0]])expect(next.locate(next.sourceDocument(i.transcript),locator(i,'one',ids),i.transcript).reason).toBe('NONCONTIGUOUS_SOURCE_LINES');
});
test('quote present elsewhere cannot rescue wrong selected line',()=>{
 const i=input('speling\ncorrect'),r=normalize(i,[record(i,'speling','spelling','SP',[1])]);expect(r.records[0].reasons).toContain('QUOTE_ABSENT_IN_SELECTED_LINES');
});
test('quote absent from selected document is rejected',()=>{
 const i=input('correct'),r=normalize(i,[record(i,'invented','replacement')]);expect(r.candidates).toHaveLength(0);
});
test('unnecessarily broad line selection is not silently narrowed',()=>{
 const i=input('speling\nelsewhere'),r=normalize(i,[record(i,'speling','spelling','SP',[0,1])]);expect(r.records[0].reasons).toContain('NONMINIMAL_SOURCE_LINES');
});
test('broad CAP quote remains diagnostic and unchanged',()=>{
 const i=input('winter is cold'),r=normalize(i,[record(i,i.transcript,'Winter is cold','CAP')]);expect(r.records[0].reasons).toContain('MINIMAL_WORD_QUOTE_REQUIRED');expect(r.records[0].raw.quotedText).toBe(i.transcript);
});
test('collapsed newline quote is not repaired',()=>{
 const i=input('We stayed\nthey left'),r=normalize(i,[record(i,'We stayed they left','We stayed. They left','RO',[0,1])]);expect(r.records[0].reasons).toContain('QUOTE_ABSENT_IN_SELECTED_LINES');
});
test.each(['off','word'])('no-op %s is invalid independently of confidence',q=>{
 const i=input(q),r=normalize(i,[record(i,q,q)]);expect(r.records[0].reasons).toContain('NO_OP_CORRECTION');expect(next.authority(r.records[0],r,proof(i)).eligibleOffline).toBe(false);
});
test('confidence zero is ineligible even with valid source and a changed suggestion',()=>{
 const i=input(),c={...record(i),confidence:0},r=normalize(i,[c]);expect(r.records[0].reasons).toContain('ZERO_CONFIDENCE');expect(r.candidates).toHaveLength(0);
});
test.each([['SP','VF','speling','spelling'],['SP','WC','speling','spelling'],['PREP','COL','near of','near to'],['CAP','SP','winter','Winter']])('same intent %s/%s is withheld without remap',(a,b,q,s)=>{
 const i=input(q),r=normalize(i,[record(i,q,s,a),record(i,q,s,b)]);expect(r.candidates).toHaveLength(0);expect(r.records.every(c=>c.reasons.includes('TAXONOMY_AMBIGUITY'))).toBe(true);
});
test('overlapping source phrases with distinct real edits stay distinct',()=>{
 const i=input('They walks ofthen'),r=normalize(i,[record(i,i.transcript,'They walk ofthen','AGR'),record(i,'ofthen','often','SP')]);expect(r.candidates).toHaveLength(2);
});
test('CONTENT without real supplied criterion cannot become a candidate',()=>{
 const i=input('Trees help.'),c={...record(i,i.transcript,'','SD'),correctionKind:'global'},r=normalize(i,[c]);expect(r.records[0].reasons).toContain('REAL_ASSIGNMENT_CRITERION_REQUIRED');
});
test('CONTENT with supplied criterion ID and exact source is available for independent review',()=>{
 const i=input('Trees help.',{instructions:'Support your claim with a measured example.'});const c={...record(i,i.transcript,'','SD'),correctionKind:'global',assignmentEvidence:{criterionId:next.assignmentCriteria(i.assignment)[0].id}};
 const r=normalize(i,[c]);expect(r.candidates).toHaveLength(1);expect(r.records[0].assignmentCriterion.text).toBe(i.assignment.instructions);
 expect(next.authority(r.records[0],r,proof(i)).reason).toBe('INDEPENDENT_CONTEXTUAL_REVIEW_REQUIRED');
});
test('legend definition cannot masquerade as assignment criterion, including free-text injection',()=>{
 const i=input('Trees help.'),c={...record(i,i.transcript,'','DEV'),correctionKind:'global',assignmentEvidence:{criterionId:'The word is spelled incorrectly.'}};
 expect(normalize(i,[c]).records[0].reasons).toContain('REAL_ASSIGNMENT_CRITERION_REQUIRED');
 const injected={...c,assignmentEvidence:{criterionId:null,assignmentQuote:'The word is spelled incorrectly.'}};
 expect(normalize(i,[injected]).records[0].reasons).toContain('UNSUPPORTED_PROVIDER_FIELDS');
});
test('literal correction needs no assignment evidence and cannot inject irrelevant criterion',()=>{
 const i=input();expect(normalize(i,[record(i)]).candidates).toHaveLength(1);
 const c=record(i);c.assignmentEvidence.criterionId='legend-SP';expect(normalize(i,[c]).records[0].reasons).toContain('ASSIGNMENT_EVIDENCE_NOT_APPLICABLE');
});
test('style-only wording does not become counted correction authority',()=>{
 const i=input('pleasant'),c={...record(i,'pleasant','lovely','WC'),stylePreference:true},r=normalize(i,[c]);expect(r.records[0].reasons).toContain('STYLE_PREFERENCE');
});
test('provider cannot return or override occurrence/offset/legend metadata',()=>{
 const i=input();for(const field of ['occurrence','canonicalOccurrence','start','end','codeDefinition']){
  const c={...record(i),[field]:0},r=normalize(i,[c]);expect(r.records[0].reasons).toContain('UNSUPPORTED_PROVIDER_FIELDS');expect(r.candidates).toHaveLength(0);
 }
 const schema=next.buildRequest(i).responseSchema.properties.corrections.items.properties;expect(schema).not.toHaveProperty('occurrence');expect(schema).not.toHaveProperty('quotedText');
});
test('stale transcript hash and foreign line/anchor IDs are withheld',()=>{
 const i=input('speling speling'),doc=next.sourceDocument(i.transcript),e=locator(i,'speling',[0],doc.lines[0].localAnchors[0].id);
 expect(()=>next.buildRequest({...i,transcriptHash:'old'})).toThrow();
 expect(next.locate(doc,e,'changed').reason).toBe('STALE_SOURCE_DOCUMENT');
 e.localAnchorId='invented';expect(next.locate(doc,e,i.transcript).reason).toBe('UNKNOWN_OR_FOREIGN_LOCAL_ANCHOR');
});
test.each(['fileId','runId','sourceSha256','inputSha256'])('foreign current %s cannot use derived locator as authority',key=>{
 const i=input(),r=normalize(i,[record(i)]),context=proof(i);context.identity={...i.identity,[key]:'foreign'};expect(next.authority(r.records[0],r,context).eligibleOffline).toBe(false);
});
test('uncertain source and missing native geometry remain withheld',()=>{
 const i=input(),r=normalize(i,[record(i)]),context=proof(i);expect(next.authority(r.records[0],r,{...context,attestations:[]}).eligibleOffline).toBe(false);
 expect(next.authority(r.records[0],r,{...context,nativeWords:[]}).reason).toBe('EXACT_NATIVE_GEOMETRY_REQUIRED');
});
test.each(['PROMPT_OR_INSTRUCTION','STUDENT_CROSSED_OUT','WATERMARK_OR_CAMERA_BRANDING'])('line IDs do not turn %s into student authority',classification=>{
 const i=input(),r=normalize(i,[record(i)]),context=proof(i);context.bindings=context.bindings.map(b=>({...b,classification}));expect(next.authority(r.records[0],r,context).reason).toBe('EXCLUDED_SOURCE');
});
test('local anchor from another selected region cannot be borrowed',()=>{
 const i=input('go go\nstop stop'),doc=next.sourceDocument(i.transcript),l=locator(i,'go',[0],doc.lines[1].localAnchors[0].id);expect(next.locate(doc,l,i.transcript).reason).toBe('UNKNOWN_OR_FOREIGN_LOCAL_ANCHOR');
});
test('provider request reconstructs exact source and preserves all 28 review symbols',()=>{
 const i=input('hello \r\nworld'),r=next.buildRequest(i);expect(r.document.lines.map(l=>l.text+l.eol).join('')).toBe(i.transcript);
 expect(Object.values(r.responseSchema.properties.reviews.properties).reduce((n,c)=>n+c.properties.reviewedSymbols.minItems,0)).toBe(28);
 expect(next.parse(JSON.stringify(envelope(i,[])),i).candidates).toHaveLength(0);
 expect(JSON.stringify(next.providerSource(r.document))).not.toMatch(/start|polygon|wordIds/);
});
test('one-generation entry uses explicit adapter once without audit/fallback/retry',async()=>{
 const i=input(),payload=envelope(i,[record(i)]),runCompletion=jest.fn(async options=>({content:JSON.stringify(payload),value:options.validate(JSON.stringify(payload))}));
 await next.analyze(i,{config:{model:'same',provider:'openrouter',chain:[{model:'same',provider:'openrouter'},{model:'other',provider:'openrouter'}]},runCompletion});
 expect(runCompletion).toHaveBeenCalledTimes(1);expect(runCompletion.mock.calls[0][0].config.chain).toHaveLength(1);
 expect(runCompletion.mock.calls[0][0].config).toMatchObject({primaryRetries:0,fallbackRetries:0,fallback:null});await expect(next.analyze(i)).rejects.toThrow('EXPLICIT_COMPLETION');
});
test('old v9/v13 outputs cannot be upgraded by silently deriving new locator',()=>{
 const i=input();expect(()=>next.parse(JSON.stringify({transcriptHash:i.transcriptHash,reviews:{},corrections:[{quotedText:'speling',occurrence:7}]}),i)).toThrow();
 expect(prior.SCHEMA_VERSION).toBe('semantic-corrections-v13-single-list');expect(legacy.SEMANTIC_SCHEMA_VERSION).toBe('semantic-corrections-v13-astra-reviewed');expect(typeof legacy.analyzeSourceLocated).toBe('function');
});
test('pathological source/assignment metadata is bounded offline',()=>{
 expect(()=>next.sourceDocument('\n'.repeat(2001))).toThrow('LIMIT');const a={};a.rubric=a;expect(()=>next.assignmentCriteria(a)).toThrow('CYCLE');
});
