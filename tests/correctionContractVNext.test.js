'use strict';
const next=require('../src/services/correctionContractVNext.service');
const old=require('../src/services/semanticWritingCorrections.service');
const canonical=require('../src/services/correctionCanonical.service');
const {fallbackLegend,REQUIRED}=require('../src/services/correctionLegendResolver.service');
const {digest,evidenceKey}=require('../src/services/hybridSource/reconcile');
const identity={submissionId:'synth-s',fileId:'synth-f',runId:'synth-r',pageNumber:1,sourceSha256:'a'.repeat(64),inputSha256:'b'.repeat(64),width:800,height:300,orientation:1};
const input=(transcript='speling',assignment={})=>({transcript,transcriptHash:digest(transcript),identity:{...identity},legend:fallbackLegend(),assignment});
const category=code=>Object.keys(REQUIRED).find(k=>REQUIRED[k].includes(code))||'MECHANICS';
const record=(quote='speling',suggestion='spelling',code='SP',occurrence=0)=>({category:category(code),symbol:code,quotedText:quote,suggestedText:suggestion,occurrence,
 message:'Synthetic demonstrable error.',correctionKind:'localized',confidence:1,severity:'low',stylePreference:false,
 evidence:{sourceQuote:quote,sourceOccurrence:occurrence,assignmentQuote:'',rationale:'Synthetic reference reason.'}});
const normalize=(i,corrections,options)=>next.normalize(i,{transcriptHash:i.transcriptHash,corrections},options);
function proof(i){
 const words=i.transcript.split(' ').map((text,n)=>({id:`word_synth-f_1_${n+1}`,text,confidence:1,polygon:[{x:20+n*130,y:20},{x:120+n*130,y:20},{x:120+n*130,y:60},{x:20+n*130,y:60}]}));
 let offset=0;
 const bindings=words.map((w,index)=>{const b={regionId:`synthetic-${index}`,identity:i.identity,sourceTranscriptSha256:i.transcriptHash,
   transcriptStart:offset,transcriptEnd:offset+w.text.length,sourceText:w.text,classification:'STUDENT_ACTIVE_TEXT',
   geometryUnique:true,state:'VERIFIED_SOURCE',mappedWordIds:[w.id],wordIds:[w.id],mappedPolygons:[w.polygon]};offset+=w.text.length+1;return b;});
 const attestations=bindings.map(b=>({kind:'HUMAN_REVIEWED',reviewer:'synthetic reference',reviewId:b.regionId,identity:i.identity,evidenceKey:evidenceKey(i.identity),wordIds:b.mappedWordIds,classification:b.classification,text:b.sourceText}));
 return {identity:i.identity,transcript:i.transcript,nativeWords:words,attestations,bindings};
}
const envelope=(i,corrections=[])=>({transcriptHash:i.transcriptHash,reviews:Object.fromEntries(Object.entries(REQUIRED).map(([key,symbols])=>[key,{reviewed:true,reviewedSymbols:[...symbols],noFindingReason:'Reviewed with no unsupported finding.'}])),corrections});
test.each([['SP','VF','speling','spelling'],['SP','WC','speling','spelling'],['PREP','SP','near of','near to'],['PREP','COL','near of','near to'],['CAP','SP','winter','Winter']])(
 'competing %s/%s for one repair cannot reach authority',(a,b,q,s)=>{
 const i=input(q),result=normalize(i,[record(q,s,a),record(q,s,b)]);
 expect(result.records.every(r=>r.reasons.includes('TAXONOMY_AMBIGUITY'))).toBe(true);
 expect(result.candidates).toHaveLength(0);
 for(const r of result.records)expect(next.authority(r,result,proof(i)).eligibleOffline).toBe(false);
});
test('phrase/subword aliases have same repair footprint but are never shrunk',()=>{
 const i=input('stand off'),result=normalize(i,[record('stand off','stand of','PREP'),record('off','of','SP')]);
 expect(result.candidates).toHaveLength(0);expect(result.records[0].raw.quotedText).toBe('stand off');
 expect(result.records.every(r=>!r.reasons.includes('COMPETING_REPAIR_AMBIGUITY'))).toBe(true);
});
test('identical duplicate keeps raw records and marks only later duplicate',()=>{
 const i=input(),result=normalize(i,[record(),record()]);expect(result.candidates).toHaveLength(1);
 expect(result.records[1].reasons).toContain('IDENTICAL_DUPLICATE');expect(result.records).toHaveLength(2);
});
test('same code with competing suggestions is withheld',()=>{
 const i=input('cot'),r=normalize(i,[record('cot','cat'),record('cot','cut')]);
 expect(r.candidates).toHaveLength(0);expect(r.records.every(x=>x.reasons.includes('COMPETING_REPAIR_AMBIGUITY'))).toBe(true);
});
test('different repair extents on the same word/code remain competing alternatives',()=>{
 const i=input('wrod'),r=normalize(i,[record('wrod','word'),record('wrod','wrote')]);
 expect(r.candidates).toHaveLength(0);expect(r.records.every(c=>c.reasons.includes('COMPETING_REPAIR_AMBIGUITY'))).toBe(true);
});
test('overlapping quotes with genuinely distinct edits do not conflict',()=>{
 const i=input('They walks ofthen');const r=normalize(i,[record('They walks ofthen','They walk ofthen','AGR'),record('ofthen','often','SP')]);
 expect(r.candidates).toHaveLength(2);expect(r.records.every(x=>!x.reasons.includes('TAXONOMY_AMBIGUITY'))).toBe(true);
});
test('repeated source uses the requested occurrence with distinct offsets',()=>{
 const i=input('speling speling');const r=normalize(i,[record('speling','spelling','SP',0),record('speling','spelling','SP',1)]);
 expect(r.candidates.map(c=>c.start)).toEqual([0,8]);
});
test('invalid explicit unique occurrence is diagnostic, not repaired',()=>{
 const i=input(),r=normalize(i,[record('speling','spelling','SP',7)]);
 expect(r.records[0].start).toBeNull();expect(r.records[0].reasons).toContain('INVALID_EXPLICIT_OCCURRENCE');
 expect(next.authority(r.records[0],r,proof(i)).eligibleOffline).toBe(false);
 // Frozen v12 helper still reproduces its old behavior.
 expect(canonical.locateQuote('speling','speling',7)).toEqual({start:0,end:7});
});
test('broad literal CAP stays diagnostic; quote is never narrowed',()=>{
 const i=input('winter is cold'),r=normalize(i,[record('winter is cold','Winter is cold','CAP')]);
 expect(r.records[0].reasons).toContain('MINIMAL_WORD_QUOTE_REQUIRED');expect(r.records[0].raw.quotedText).toBe('winter is cold');
});
test.each([['bright\nstars','bright stars'],['quiet night','invented source']])('nonliteral %s is never repaired', (source,quote)=>{
 const i=input(source),r=normalize(i,[record(quote,'replacement','WC')]);expect(r.records[0].reasons).toContain('NONLITERAL_QUOTE');
});
test.each([['I finished\nyou started','I finished.\nYou started'],['Birds flew the rain stopped','Birds flew. The rain stopped'],['We arrived\nthey left','We arrived;\nthey left']])(
 'RO can preserve exact multiline boundary and complete repair: %s',(quote,suggestion)=>{
 const i=input(quote),r=normalize(i,[record(quote,suggestion,'RO')]);expect(r.candidates).toHaveLength(1);expect(r.records[0].raw.suggestedText).toBe(suggestion);
});
test('separate CAP component of same RO repair cannot obtain authority',()=>{
 const i=input('I finished\nyou started');const r=normalize(i,[record(i.transcript,'I finished.\nYou started','RO'),record('you','You','CAP')]);
 expect(r.candidates).toHaveLength(0);expect(r.records.every(c=>c.reasons.includes('TAXONOMY_AMBIGUITY'))).toBe(true);
});
test.each(['DEV','CONC','TS','SD'])('speculative %s without assignment evidence is withheld',code=>{
 const i=input('Trees help.'),c={...record('Trees help.','',code),correctionKind:'global'};const r=normalize(i,[c]);
 expect(r.records[0].reasons).toContain('ASSIGNMENT_CONTEXT_REQUIRED');expect(r.candidates).toHaveLength(0);
});
test('context categories remain available with concrete supplied assignment/source evidence',()=>{
 const i=input('Trees help.',{instructions:'Support your main claim with a measured example.'});
 const c={...record('Trees help.','','SD'),correctionKind:'global'};c.evidence.assignmentQuote='a measured example';
 const r=normalize(i,[c]);expect(r.candidates).toHaveLength(1);
 expect(next.authority(r.records[0],r,proof(i)).reason).toBe('INDEPENDENT_CONTEXTUAL_REVIEW_REQUIRED');
});
test('awkward understandable wording marked style-only is not counted',()=>{
 const i=input('The morning was rather pleasant.'),c={...record(i.transcript,'The morning was lovely.','WC'),stylePreference:true};
 expect(normalize(i,[c]).records[0].reasons).toContain('STYLE_PREFERENCE');
});
test('context-dependent lexical rewrite requires independent review for authority',()=>{
 const i=input('pleasant'),r=normalize(i,[record('pleasant','lovely','WC')]);
 expect(r.candidates).toHaveLength(1);expect(next.authority(r.records[0],r,proof(i)).reason).toBe('INDEPENDENT_LEXICAL_REVIEW_REQUIRED');
});
test.each([['speling','speling','SP','NO_OP_CORRECTION'],['winter','Winter','SP','CASE_CHANGE_REQUIRES_CAP'],['stone','stove','CAP','CAP_NOT_CASE_ONLY'],['stone','stove','BAD','UNSUPPORTED_CODE']])(
 'rejects generic taxonomy/no-op defect %s/%s/%s',(q,s,code,reason)=>{const i=input(q);expect(normalize(i,[record(q,s,code)]).records[0].reasons).toContain(reason);});
test('code-owned category mismatch is rejected, never remapped',()=>{
 const i=input(),c={...record(),category:'GRAMMAR'},r=normalize(i,[c]);expect(r.records[0].reasons).toContain('CODE_CATEGORY_CONFLICT');expect(r.records[0].raw.category).toBe('GRAMMAR');
});
test('strict exact source/geometry gate can be eligible offline, always unpublished',()=>{
 const i=input(),r=normalize(i,[record()]);const gate=next.authority(r.records[0],r,proof(i));
 expect(gate).toMatchObject({eligibleOffline:true,publishable:false,wordIds:['word_synth-f_1_1']});
});
test.each(['runId','sourceSha256','inputSha256','fileId'])('foreign %s is denied at final gate',key=>{
 const i=input(),r=normalize(i,[record()]),context=proof(i);context.identity={...i.identity,[key]:'foreign'};
 expect(next.authority(r.records[0],r,context).eligibleOffline).toBe(false);
});
test('stale transcript, uncertain source and missing geometry are withheld separately',()=>{
 const i=input(),r=normalize(i,[record()]),context=proof(i);
 expect(next.authority(r.records[0],r,{...context,transcript:'changed'}).reason).toBe('STALE_TRANSCRIPT');
 expect(next.authority(r.records[0],r,{...context,attestations:[]}).eligibleOffline).toBe(false);
 expect(next.authority(r.records[0],r,{...context,nativeWords:[]}).reason).toBe('EXACT_NATIVE_GEOMETRY_REQUIRED');
 const words=JSON.parse(JSON.stringify(context.nativeWords));words[0].polygon[0].x++;
 expect(next.authority(r.records[0],r,{...context,nativeWords:words}).eligibleOffline).toBe(false);
});
test.each(['Printed question','deleted draft','CAMERA'])('excluded %s cannot become source correction',quote=>{
 const i=input('Active response'),r=normalize(i,[record(quote,'replacement','WC')]);expect(r.records[0].reasons).toContain('NONLITERAL_QUOTE');
});
test.each(['PROMPT_OR_INSTRUCTION','STUDENT_CROSSED_OUT','WATERMARK_OR_CAMERA_BRANDING'])('even a literal %s binding cannot receive student authority',classification=>{
 const i=input(),r=normalize(i,[record()]),context=proof(i);context.bindings=context.bindings.map(b=>({...b,classification}));
 expect(next.authority(r.records[0],r,context).reason).toBe('EXCLUDED_SOURCE');
});
test('RO label without a complete punctuation boundary repair is withheld',()=>{
 const i=input('they left'),r=normalize(i,[record('they left','They left','RO')]);expect(r.records[0].reasons).toContain('COMPLETE_BOUNDARY_REPAIR_REQUIRED');
});
test('versioned replay adapter preserves saved legacy raw fields without corrections',()=>{
 const i=input(),e=envelope(i);const c=record();delete c.category;delete c.evidence;
 const saved={transcriptHash:i.transcriptHash,categories:Object.fromEntries(Object.entries(e.reviews).map(([key,r])=>[key,{...r,noFindingReason:key==='MECHANICS'?'':r.noFindingReason,corrections:key==='MECHANICS'?[c]:[]}]))};
 const result=next.replayLegacy(JSON.stringify(saved),i);expect(result.records[0].raw.quotedText).toBe('speling');expect(result.candidates).toHaveLength(1);
});
test('stale input hash aborts; no model geometry is requested',()=>{
 expect(()=>next.buildRequest({...input(),transcriptHash:'old'})).toThrow();
 const r=next.buildRequest(input());expect(r.responseSchema.properties.corrections.items.properties).not.toHaveProperty('geometry');
 expect(r.responseSchema.properties).not.toHaveProperty('categories');
 expect(r.messages[1].content).toContain('ONE primary');
});
test('flat schema preserves exact 28-symbol coverage with zero findings allowed',()=>{
 const i=input();const e=envelope(i);expect(Object.values(e.reviews).reduce((n,c)=>n+c.reviewedSymbols.length,0)).toBe(28);
 expect(next.parse(JSON.stringify(e),i).candidates).toHaveLength(0);
 e.reviews.MECHANICS.reviewedSymbols[0]='CAP';expect(()=>next.parse(JSON.stringify(e),i)).toThrow();
});
test('closed new contract rejects injected fields and preserves raw diagnostics',()=>{
 const i=input(),e=envelope(i,[record()]);e.corrections[0].geometry={x:1};expect(()=>next.parse(JSON.stringify(e),i)).toThrow();
 const r=normalize(i,[record()]);expect(Object.isFrozen(r.records[0].raw)).toBe(true);
});
test('new analyze makes one explicit adapter invocation and disables generation expansion',async()=>{
 const i=input(),runCompletion=jest.fn(async request=>({content:JSON.stringify(envelope(i,[record()])),value:request.validate(JSON.stringify(envelope(i,[record()])))}));
 await next.analyze(i,{config:{provider:'openrouter',model:'same-model',chain:[{provider:'openrouter',model:'same-model'},{provider:'openrouter',model:'fallback'}],primaryRetries:1},runCompletion});
 expect(runCompletion).toHaveBeenCalledTimes(1);expect(runCompletion.mock.calls[0][0].config).toMatchObject({primaryRetries:0,fallbackRetries:0,fallback:null});
 expect(runCompletion.mock.calls[0][0].config.chain).toHaveLength(1);
 await expect(next.analyze(i)).rejects.toMatchObject({code:'HARDENED_COMPLETION_ADAPTER_REQUIRED'});
});
test('new entry/version do not overwrite frozen legacy experiments',()=>{
 expect(old.SEMANTIC_PROMPT_VERSION).toBe('semantic-corrections-astra-v12-compact-organization-closure');expect(old.SEMANTIC_SCHEMA_VERSION).toBe('semantic-corrections-v14-compact-reviewed');
 expect(next.PROMPT_VERSION).not.toBe(old.SEMANTIC_PROMPT_VERSION);expect(typeof old.analyzeHardened).toBe('function');
});
