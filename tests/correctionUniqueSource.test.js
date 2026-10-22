'use strict';
const next=require('../src/services/correctionUniqueSource.service');
const {fallbackLegend,REQUIRED}=require('../src/services/correctionLegendResolver.service');
const {digest,evidenceKey}=require('../src/services/hybridSource/reconcile');
const identity={submissionId:'s',fileId:'f',runId:'r',pageNumber:1,sourceSha256:'a'.repeat(64),inputSha256:'b'.repeat(64),width:800,height:300,orientation:1};
const input=(transcript='speling',assignment={})=>({transcript,transcriptHash:digest(transcript),identity:{...identity},legend:fallbackLegend(),assignment});
const record=(i,exactQuote='speling',suggestion='spelling',code='SP',lines=[0])=>({sourceLineIds:lines.map(n=>next.sourceDocument(i.transcript).lines[n].id),exactQuote,code,suggestion,confidence:1,rationale:'Synthetic reviewed error.',criterionId:null});
const envelope=corrections=>({reviews:Object.fromEntries(Object.entries(REQUIRED).map(([k,v])=>[k,{reviewed:true,reviewedSymbols:v,noFindingReason:'No forced findings.'}])),corrections});
const norm=(i,rows)=>next.parse(JSON.stringify(envelope(rows)),i);
function proof(i){
 const polygon=[{x:10,y:10},{x:100,y:10},{x:100,y:60},{x:10,y:60}],id='word_f_1_1';
 const binding={identity:i.identity,sourceTranscriptSha256:i.transcriptHash,transcriptStart:0,transcriptEnd:i.transcript.length,sourceText:i.transcript,
  classification:'STUDENT_ACTIVE_TEXT',state:'VERIFIED_SOURCE',geometryUnique:true,mappedWordIds:[id],wordIds:[id],mappedPolygons:[polygon]};
 return {identity:i.identity,transcript:i.transcript,bindings:[binding],nativeWords:[{id,polygon}],attestations:[{kind:'HUMAN_REVIEWED',reviewer:'synthetic reference',reviewId:'review',
  identity:i.identity,evidenceKey:evidenceKey(i.identity),wordIds:[id],classification:binding.classification,text:i.transcript}]};
}

test.each([
 ['speling','speling','spelling','SP',null],
 ['speling','speling','speling','SP','NO_OP_CORRECTION'],
 ['rain','rain','Rain','CAP',null],['Rain','Rain','rain','CAP',null],
 ['Rain','Rain','Rain','CAP','NO_OP_CORRECTION'],['rain','rain','Rain.','CAP','CAP_NOT_CASE_ONLY'],
 ['rain','rain','Rain','SP','CASE_CHANGE_REQUIRES_CAP'],
 ['depend of','depend of','depend on','PREP',null],['of','of','of','PREP','NO_OP_CORRECTION'],
 ['Birds sing clouds drift','Birds sing clouds drift','Birds sing. Clouds drift','RO',null],
 ['We waited\nrain arrived','We waited\nrain arrived','We waited.\nRain arrived','RO',null],
 ['I waved, she smiled','I waved, she smiled','I waved; she smiled','RO',null],
 ['We waited. rain arrived','rain','Rain','CAP',null],
 ['We waited. rain arrived','We waited. rain arrived','We waited. Rain arrived','RO','RO_MATERIAL_BOUNDARY_CHANGE_REQUIRED'],
 ['We waited rain arrived','We waited rain arrived','We waited. rain arrived','RO','RO_COMPLETE_CAPITALIZATION_REQUIRED'],
 ['speling','speling','spelling','UNKNOWN','UNSUPPORTED_CODE']
])('%s / %s -> %s (%s)',(text,q,s,code,reason)=>{const i=input(text),r=norm(i,[record(i,q,s,code,q.includes("\n")?[0,1]:[0])]);if(reason)expect(r.records[0].reasons).toContain(reason);else expect(r.candidates).toHaveLength(1);});
test('unique quote needs no provider anchor, category or hash',()=>{const i=input(),r=norm(i,[record(i)]);expect(r.records[0]).toMatchObject({category:'MECHANICS',start:0,end:7,canonicalOccurrence:0});expect(next.authority(r.records[0],r,proof(i)).eligibleOffline).toBe(true);const req=next.buildRequest(i);expect(Object.keys(req.responseSchema.properties)).toEqual(['reviews','corrections']);expect(JSON.stringify(next.providerSource(req.document))).not.toMatch(/localAnchor|transcriptHash|start/);});
test('same quote twice same line is withheld',()=>{const i=input('speling speling');expect(norm(i,[record(i)]).records[0].reasons).toContain('AMBIGUOUS_LOCAL_QUOTE');});
test('same quote on two selected lines is ambiguous',()=>{const i=input('speling\nspeling');expect(norm(i,[record(i,'speling','spelling','SP',[0,1])]).records[0].reasons).toContain('AMBIGUOUS_LOCAL_QUOTE');});
test('repeated words on different lines resolve independently',()=>{const i=input('speling\nspeling');expect(norm(i,[record(i),record(i,'speling','spelling','SP',[1])]).candidates.map(r=>r.canonicalOccurrence)).toEqual([0,1]);});
test.each(['category','localAnchorId','occurrence','transcriptHash','start','codeDefinition'])('provider-injected %s rejected and raw retained',field=>{const i=input(),c={...record(i),[field]:'injected'},r=norm(i,[c]);expect(r.candidates).toHaveLength(0);expect(r.records[0].reasons).toContain('UNSUPPORTED_PROVIDER_FIELDS');expect(r.records[0].providerRecord).toEqual(c);});
test('wrong line never rescued from elsewhere',()=>{const i=input('fine\nspeling');expect(norm(i,[record(i)]).records[0].reasons).toContain('QUOTE_ABSENT_IN_SELECTED_LINES');});
test('unknown line ID fails closed',()=>{const i=input(),c=record(i);c.sourceLineIds=['foreign'];expect(norm(i,[c]).records[0].reasons).toContain('UNKNOWN_SOURCE_LINE_ID');});
test.each([['PREP','COL'],['SP','PREP']])('competing %s/%s retained diagnostically',(a,b)=>{const i=input('depend of'),r=norm(i,[record(i,'depend of','depend on',a),record(i,'depend of','depend on',b)]);expect(r.candidates).toHaveLength(0);r.records.forEach(c=>expect(c.reasons).toContain('TAXONOMY_AMBIGUITY'));});
test('CAP and false RO competition remains visible',()=>{const i=input('We waited. rain arrived'),r=norm(i,[record(i,'rain','Rain','CAP'),record(i,i.transcript,'We waited. Rain arrived','RO')]);expect(r.candidates).toHaveLength(0);expect(r.records[0].reasons).toContain('TAXONOMY_AMBIGUITY');});
test('independent SP CAP PREP RO coexist',()=>{const i=input('teh map\nwe slept.\nThey depend of maps.\nBirds sing clouds drift.');const r=norm(i,[record(i,'teh','the'),record(i,'we','We','CAP',[1]),record(i,'depend of','depend on','PREP',[2]),record(i,'Birds sing clouds drift','Birds sing. Clouds drift','RO',[3])]);expect(r.candidates).toHaveLength(4);});
test('criterion valid supports contextual candidate, authority still needs review',()=>{const i=input('A claim',{instructions:'Support each claim with evidence.'}),c=record(i,'A claim','A supported claim','DEV');c.criterionId=next.buildRequest(i).criteria[0].id;const r=norm(i,[c]);expect(r.candidates).toHaveLength(1);expect(next.authority(r.records[0],r,proof(i)).reason).toBe('INDEPENDENT_CONTEXTUAL_REVIEW_REQUIRED');});
test.each([null,'invented'])('CONTENT without real criterion %s withheld',criterionId=>{const i=input(),c={...record(i,'speling','spelling','DEV'),criterionId};expect(norm(i,[c]).records[0].reasons).toContain('REAL_ASSIGNMENT_CRITERION_REQUIRED');});
test('style-only provider flag unsupported',()=>{const i=input(),r=norm(i,[{...record(i),stylePreference:true}]);expect(r.candidates).toHaveLength(0);});
test('stale transcript authority withheld',()=>{const i=input(),r=norm(i,[record(i)]);expect(next.authority(r.records[0],r,{...proof(i),transcript:'changed'}).reason).toBe('STALE_TRANSCRIPT');});
test('foreign identity withheld',()=>{const i=input(),r=norm(i,[record(i)]),ctx=proof(i);ctx.identity={...ctx.identity,runId:'foreign'};expect(next.authority(r.records[0],r,ctx).reason).toBe('STALE_OR_FOREIGN_IDENTITY');});
test('missing geometry withheld',()=>{const i=input(),r=norm(i,[record(i)]);expect(next.authority(r.records[0],r,{...proof(i),nativeWords:[]}).reason).toBe('EXACT_NATIVE_GEOMETRY_REQUIRED');});
test('uncertain source withheld',()=>{const i=input(),r=norm(i,[record(i)]),ctx=proof(i);ctx.bindings[0].state='UNCERTAIN';expect(next.authority(r.records[0],r,ctx).eligibleOffline).toBe(false);});
test.each(['PROMPT_OR_INSTRUCTION','STUDENT_CROSSED_OUT','WATERMARK_OR_CAMERA_BRANDING'])('excluded %s cannot gain authority',classification=>{const i=input(),r=norm(i,[record(i)]),ctx=proof(i);ctx.bindings[0].classification=classification;expect(next.authority(r.records[0],r,ctx).reason).toBe('EXCLUDED_SOURCE');});
test('zero confidence withheld',()=>{const i=input(),r=norm(i,[{...record(i),confidence:0}]);expect(r.records[0].reasons).toContain('ZERO_CONFIDENCE');});
test('hash mismatch rejected',()=>{expect(()=>next.buildRequest({...input(),transcriptHash:'stale'})).toThrow('CURRENT_TRANSCRIPT_REQUIRED');});
test('explicit mock adapter only, one invocation, no retry/fallback',async()=>{const i=input(),runCompletion=jest.fn(async options=>({content:JSON.stringify(envelope([record(i)])),value:options.validate(JSON.stringify(envelope([record(i)])))}));const r=await next.analyze(i,{config:{model:'mock',provider:'mock'},runCompletion});expect(runCompletion).toHaveBeenCalledTimes(1);expect(runCompletion.mock.calls[0][0].config).toMatchObject({fallback:null,maxRetries:0});expect(r.publishable).toBe(false);});
