'use strict';
const fs=require('fs'),path=require('path'),sharp=require('sharp');
const {analyze}=require('../scripts/lib/targetedFailureAnalysis.cjs');
const {sanitizeTargeted,retrieve}=require('../scripts/targeted-v2-failure-audit.cjs');
const historical=require('./fixtures/source-fidelity/targeted-failed-run.cjs');
const t=require('../src/services/sourceFidelity/targetedVerification');
const source=require('../src/services/sourceFidelityOcr.service');
const reading=text=>({activeTranscript:text,segments:[{type:'ACTIVE_STUDENT_TEXT',text,confidence:.9,notes:''}],uncertainSpans:[]});
test('historical missing outcomes are unknown, not falsely called model disagreement or mapping-only failure',()=>{
  const before=JSON.stringify(historical),r=analyze(historical);
  expect(r.counts).toMatchObject({targetedRegions:6,resolved:0,readerDisagreementsConfirmed:0,readerUncertaintyConfirmed:0,
    mappingOnlyFailuresConfirmed:0,readerOutcomesUnknown:6,uniqueFirstPassMappings:3,unlocalizedSignals:3});
  expect(JSON.stringify(historical)).toBe(before);expect(r.sourceTextMutated).toBe(false);
  for(const row of r.pages[0].regions.filter(r=>r.targeted)){expect(row.comparison.activeTextExactEqual).toBeNull();expect(row.final.unresolvedReasonCodes).toContain('OTHER');}
});
test('exact agreement rejected by mapping is distinct from reader disagreement',()=>{
  const e=structuredClone(historical),r=e.pages[0].targeted.results[0];for(const reader of r.readers)reader.value=reading('of self?');
  // Use a known complete row so this test isolates mapping, not missing physical content.
  const valid=e.pages[0].targeted.results[1];r.region=structuredClone(valid.region);r.region.mapping={state:'MAPPING_WITHHELD'};
  for(const reader of r.readers)reader.value=reading(valid.region.mapping.original);
  const a=analyze(e).pages[0].regions[0];expect(a.comparison.activeTextExactEqual).toBe(true);expect(a.reconciliation.mappingOnlyFailure).toBe(true);
  r.readers[1].value=reading('different reading');expect(analyze(e).pages[0].regions[0].final.unresolvedReasonCodes).toContain('TARGETED_TEXT_DISAGREEMENT');
});
test('mapping diagnostics expose withheld boundaries, exact hashes and stale historical merge anchor IDs',()=>{
  const r=analyze(historical).pages[0].regions;
  expect(r[1].reconciliation).toMatchObject({uniqueMapping:true,originalTranscriptHashMatch:true,mappedStartOffset:140,mappedEndOffset:189});
  expect(r[0].reconciliation.mappingFailureReason).toContain('AMBIGUOUS_BOUNDARY');
  expect(r[3].reconciliation.rightAnchor).toMatchObject({id:'word_1_31',actualBoundaryId:'word_1_56'});
});
test('sanitizer excludes unrelated student fields, credentials and nested provenance extras',()=>{
  const v=structuredClone(historical.pages[0].targeted);v.jwt='secret-token';v.results[0].readers[0].apiKey='secret-key';
  v.results[0].reconciliation={provenance:{stage:'test',credentials:'secret-path'},targetedTranscript:'allowed'};
  const result=JSON.stringify(sanitizeTargeted(v));for(const secret of ['secret-token','secret-key','secret-path'])expect(result).not.toContain(secret);
});
test('read-only retrieval has no write methods and projects only audit source fields',async()=>{
  const id=historical.submissionId,p=historical.pages[0];const submission={_id:id,ocrJobId:historical.ocrJobId,sourceTranscriptExact:p.astra.activeTranscript,
    sourceTranscriptSha256:source.sha(p.astra.activeTranscript),sourceFidelityStatus:'OCR_UNCERTAIN',ocrPages:[{
      fileId:p.fileId,pageNumber:p.pageNumber,sourceInputSha256:p.inputSha256,sourceTextExact:p.exactText,sourceTextSha256:p.exactTextSha256}]};
  const findOne=jest.fn(async()=>submission),collection=jest.fn(name=>name==='sourcefidelityevidences'?{
    find:jest.fn(()=>({limit:()=>({toArray:async()=>[]})}))}:name==='files'?{findOne:async()=>null}:{findOne});
  const before=JSON.stringify(submission);const result=await retrieve({collection},id);expect(result.sourceTextMutated).toBe(false);
  expect(findOne.mock.calls[0][1].projection).not.toHaveProperty('guest');expect(JSON.stringify(submission)).toBe(before);
});
test('known usage survives targeted schema rejection; source acceptance and first-pass text stay unchanged',async()=>{
  const bytes=await sharp({create:{width:600,height:200,channels:3,background:'white'}}).png().toBuffer();
  const raw={width:600,height:200,dimensionsMatch:true,words:['start','sence','end'].map((text,i)=>({id:'w'+i,text,paragraphIndex:0,symbols:[],
    polygon:[{x:20+i*120,y:60},{x:110+i*120,y:60},{x:110+i*120,y:100},{x:20+i*120,y:100}]}))};
  const g={pages:[{words:[]}],words:raw.words.map(w=>({text:w.text,bbox:{x:1,y:1,w:2,h:2}}))};Object.defineProperty(g,require('../src/services/hybridSource/shadow').rawEvidence,{value:[raw]});
  const env={NODE_ENV:'test',OCR_SOURCE_MODE:'astra_verified',OCR_SOURCE_VERIFICATION_MODE:'targeted_v2',
    OCR_ASTRA_MODEL:'openai/gpt-6-astra',OCR_FABLE_MODEL:'anthropic/claude-fable-5.1',OPENROUTER_API_KEY:'mock'};
  const gateway=require('../src/services/aiGateway.service'),spy=jest.spyOn(gateway,'providerAttempt').mockImplementation(async options=>{
    const targeted=options.messages[0].content===t.PROMPT;
    const value=reading(options.entry.model===env.OCR_ASTRA_MODEL?'start sence end':'start sense end');
    if(targeted)value.activeTranscript='private invalid output';
    return {content:JSON.stringify(value),returnedModel:options.entry.model,usage:{cost:.25,total_tokens:23,apiKey:'never'},durationMs:99};
  });const persist=jest.fn();const logger=jest.spyOn(require('../src/utils/logger'),'info').mockImplementation(()=>{});
  try{const result=await source.readPage({bytes,mimeType:'image/png',identity:{fileId:'f',pageNumber:1},google:async()=>g,env,persistEvidence:persist});
    expect(result.fullText).toBe('start sence end');expect(result.source.sourceFidelityStatus).toBe('OCR_UNCERTAIN');
    const target=persist.mock.calls[0][0].payload.targeted;expect(target.summary.readers.map(r=>r.usage.cost)).toEqual([.25,.25]);
    for(const r of target.results[0].readers){expect(r).toMatchObject({value:null,validationStatus:'FAILED',failureCode:'OCR_SOURCE_TRANSCRIPT_MISMATCH',durationMs:99});}
    expect(JSON.stringify(logger.mock.calls)).not.toContain('private invalid output');expect(JSON.stringify(logger.mock.calls)).not.toContain('never');
    expect(result.source.sourceVerificationSummary).not.toHaveProperty('readers');expect(spy).toHaveBeenCalledTimes(4);
  }finally{spy.mockRestore();logger.mockRestore();}
});
test('merge anchor telemetry now reflects actual native boundary IDs without changing mapping policy',()=>{
  const p=historical.pages[0],plan=t.discover({astra:p.astra,fable:p.fable,google:p.google.nativePages[0],identity:{fileId:p.fileId,pageNumber:1,inputSha256:p.inputSha256}});
  const words=t.geometryWords(p.google.nativePages[0]);for(const r of plan.regions){const ws=words.filter(w=>r.sourceGeometryWordIds.includes(w.id));
    expect(r.leftAnchorId).toBe(ws[0].id);expect(r.rightAnchorId).toBe(ws.at(-1).id);}
  expect(plan.regions.find(r=>r.lineIds.length>1).mapping.state).toBe('MAPPING_WITHHELD');
});
test('explicit stored rejection codes distinguish provider, model and schema failures without guessing missing outcomes',()=>{
  for(const [code,classification] of [['AI_ATTEMPT_TIMEOUT','PROVIDER_FAILURE'],['OCR_SOURCE_MODEL_IDENTITY','MODEL_ID_MISMATCH'],['OCR_SOURCE_SCHEMA','SCHEMA_VALIDATION_FAILURE']]){
    const e=structuredClone(historical);e.pages[0].targeted.results[0].readers[0].failureCode=code;
    const r=analyze(e).pages[0].regions[0];expect(r.final.unresolvedReasonCodes).toContain(classification);
    expect(r.comparison.activeTextExactEqual).toBeNull();
  }
});
