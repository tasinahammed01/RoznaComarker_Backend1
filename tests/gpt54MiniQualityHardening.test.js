'use strict';
const semantic=require('../src/services/semanticWritingCorrections.service');
const coordinator=require('../src/services/semanticCorrectionCoordinator.service');
const client=require('../src/services/semanticAIClient.service');
const gateway=require('../src/services/aiGateway.service');
const wire=require('../src/services/compactCorrectionWire.service');
const {defaultLegend}=require('../src/services/writingCorrections.service');
const {finding}=require('./helpers/astraAssessmentFixtures.cjs');
const {defects,negativeControls,conclusionCases,opening,mixed}=require('./helpers/claudeQualityFixtures.cjs');
const model=process.env.TEST_STRICT_CORRECTION_MODEL||'openai/gpt-5.4-mini',env={OPENROUTER_API_KEY:'mock-only',CORRECTION_DETECTION_MODEL:model,ASSESSMENT_AI_PRIMARY_RETRIES:'0'};
const legend=semantic.compactSemanticLegend(defaultLegend());
function candidate(f){return finding(f.category,f.symbol,f.quote,{suggestedText:f.allowedSuggestions[0]});}
function payload(input,findings){return {reviewContract:wire.VERSION,transcriptHash:input.transcriptHash,categories:Object.fromEntries(legend.filter(g=>!(input.policy?.checks?.coherenceLogic===false&&['CONTENT','ORGANIZATION'].includes(g.category))).map(g=>[g.category,{reviewed:true,reviewedSymbols:Object.fromEntries(g.symbols.map(s=>[s.symbol,true])),corrections:findings.filter(f=>f.category===g.category).map(f=>Object.fromEntries(Object.entries(f).filter(([k])=>!['category','message','stylePreference'].includes(k))))}]))};}
async function run(input,findings,effort='medium',useCoordinator=false){const fetchImpl=jest.fn(async()=>({ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify({model,choices:[{finish_reason:'stop',message:{content:JSON.stringify(payload(input,findings))}}]})}));
 const result=await (useCoordinator?coordinator:semantic).analyze(input,{env:{...env,GPT54_MINI_CORRECTION_REASONING_EFFORT:effort},fetchImpl});return {result,fetchImpl};}
beforeAll(()=>jest.spyOn(require('../src/utils/logger'),'info').mockImplementation(()=>{}));
afterAll(()=>jest.restoreAllMocks());
test.each(['low','medium'])('%s sends exact isolated effort, strict schema and unchanged output envelope',async effort=>{
 const input={...mixed,disableCategoryAudit:true};const {result,fetchImpl}=await run(input,defects.map(candidate),effort);
 const body=JSON.parse(fetchImpl.mock.calls[0][1].body);if(model==='openai/gpt-4.1-mini')expect(body).not.toHaveProperty('reasoning');else expect(body.reasoning).toEqual({effort});expect(body.max_tokens).toBe(8000);
 expect(body.model).toBe(model);expect(body.provider).toEqual({require_parameters:true,allow_fallbacks:false});expect(body.response_format.json_schema.strict).toBe(true);
 expect(fetchImpl).toHaveBeenCalledTimes(1);expect(result.corrections).toHaveLength(7);
 const config=client.getCorrectionAIConfig({...env,GPT54_MINI_CORRECTION_REASONING_EFFORT:effort});expect(config.thinkingLevel).toBe(model==='openai/gpt-4.1-mini'?null:effort);
 expect(gateway.correctionRequestPolicy({provider:'openrouter',model:gateway.CLAUDE_CORRECTION_MODEL,feature:'teacher_comment_draft',env:{GPT54_MINI_CORRECTION_REASONING_EFFORT:effort}}).reasoning).toEqual({effort:'none'});
 expect(client.getAssessmentAIConfig({...env,GPT54_MINI_CORRECTION_REASONING_EFFORT:effort}).model).toBe('openai/gpt-6-astra');
 expect(require('../src/services/gptVisionExact/contract').config({...env,OCR_GPT_VISION_MODEL:'qwen/qwen3.8-27b',GPT54_MINI_CORRECTION_REASONING_EFFORT:effort}).model).toBe('qwen/qwen3.8-27b');
});
test('unsupported reasoning is rejected and effort partitions correction identity',()=>{
 expect(()=>client.getCorrectionAIConfig({...env,CORRECTION_DETECTION_MODEL:'openai/gpt-5.4-mini',GPT54_MINI_CORRECTION_REASONING_EFFORT:'invalid'})).toThrow();
 const keys=['low','medium'].map(e=>semantic.semanticSourceKey({correctionSourceHash:'same',config:client.getCorrectionAIConfig({...env,CORRECTION_DETECTION_MODEL:'openai/gpt-5.4-mini',GPT54_MINI_CORRECTION_REASONING_EFFORT:e})}));expect(new Set(keys).size).toBe(2);
});
test.each(['friendly','balanced','strict'])('%s mixed exact manifest preserves symbols, spans and finite suggestions in one call',async strictness=>{
 const {result,fetchImpl}=await run({...mixed,policy:{strictness}},defects.map(candidate),'medium',true);expect(fetchImpl).toHaveBeenCalledTimes(1);
 expect(result.corrections).toHaveLength(7);for(const f of defects){const c=result.corrections.find(c=>c.symbol===f.symbol);expect(c.category).toBe(f.category);expect(c.quotedText).toBe(f.quote);expect(mixed.transcript.slice(c.startChar,c.endChar)).toBe(f.quote);expect(f.allowedSuggestions).toContain(c.suggestedText);expect(c.message.length).toBeGreaterThan(0);}
 expect(JSON.parse(fetchImpl.mock.calls[0][1].body).messages[1].content).toContain(strictness);
 for(const control of negativeControls.slice(0,4)){const start=mixed.transcript.indexOf(control),end=start+control.length;
  expect(result.corrections.some(c=>c.startChar<end&&start<c.endChar)).toBe(false);}
});
test.each(negativeControls)('mock negative control stays empty: %s',async transcript=>{
 const {result,fetchImpl}=await run({transcript,transcriptHash:'negative',transcriptComplete:true},[]);expect(result.corrections).toEqual([]);expect(fetchImpl).toHaveBeenCalledTimes(1);
});
test.each(conclusionCases)('$kind ending: exact intended symbol, no CONC quota',async f=>{
 const transcript=opening+' '+('Students compare accounts and explain their evidence. '.repeat(8))+f.ending;
 const findings=f.symbol?[finding(f.symbol==='REL'?'CONTENT':'ORGANIZATION',f.symbol,f.ending)]:[];
 const {result}=await run({transcript,transcriptHash:'conclusion',transcriptComplete:true},findings);
 expect(result.corrections.map(c=>c.symbol)).toEqual(f.symbol?[f.symbol]:[]);
 if(f.symbol)expect(result.corrections[0]).toMatchObject({quotedText:f.ending,endChar:transcript.length});
});
test('P and SPC are independent, disjoint and never remapped',async()=>{
 const selected=defects.filter(f=>['P','SPC'].includes(f.symbol)),transcript=selected.map(f=>f.text).join(' ');
 const {result}=await run({transcript,transcriptHash:'mechanics',transcriptComplete:true},selected.map(candidate));
 expect(result.corrections.map(c=>c.symbol)).toEqual(['P','SPC']);expect(result.corrections[0].endChar).toBeLessThan(result.corrections[1].startChar);
});
test.each(['P','SPC'])('%s isolated defect has its own exact correction',async symbol=>{
 const f=defects.find(f=>f.symbol===symbol);const {result}=await run({transcript:f.text,transcriptHash:'isolated',transcriptComplete:true},[candidate(f)]);
 expect(result.corrections).toHaveLength(1);expect(result.corrections[0]).toMatchObject({symbol,category:'MECHANICS',quotedText:f.quote,suggestedText:f.allowedSuggestions[0]});
});
test('future counts distinguish absent CONC from rejected CONC without retaining text',()=>{
 const findings=[candidate(defects[1]),{...candidate(defects[6]),confidence:.1}];
 const rejected=semantic.validateCorrections(findings,{...mixed,legend});
 expect(rejected.diagnostics.rawSymbolCounts.CONC).toBe(1);expect(rejected.diagnostics.acceptedSymbolCounts.CONC).toBe(0);
 expect(rejected.diagnostics.rejectionReasonsBySymbol.CONC).toEqual({LOW_CONFIDENCE:1});
 const absent=semantic.validateCorrections(findings.slice(0,1),{...mixed,legend});expect(absent.diagnostics.rawSymbolCounts.CONC).toBe(0);
 expect(JSON.stringify({raw:rejected.diagnostics.rawSymbolCounts,accepted:rejected.diagnostics.acceptedSymbolCounts,reasons:rejected.diagnostics.rejectionReasonsBySymbol})).not.toContain(defects[6].quote);
});

test('structurally accepted AGR on a correct control is a wrong defect and false positive, not a benchmark pass',()=>{
 const control=negativeControls.filter(text=>mixed.transcript.includes(text))[0];
 const value=semantic.validateCorrections([finding('GRAMMAR','AGR',control,{suggestedText:'A different synthetic suggestion.'})],{...mixed,legend});
 expect(value.corrections).toHaveLength(1);
 const c=value.corrections[0],expected=defects.find(f=>f.symbol==='AGR');
 const targetStart=mixed.transcript.indexOf(expected.quote),controlStart=mixed.transcript.indexOf(control);
 expect(c.symbol).toBe('AGR');
 expect(c.startChar<targetStart+expected.quote.length&&targetStart<c.endChar).toBe(false);
 expect(c.startChar<controlStart+control.length&&controlStart<c.endChar).toBe(true);
});
test.each(['friendly','balanced','strict'])('%s all 28 enabled states and exact normalized symbol/category contracts',strictness=>{
 for(const group of legend)for(const symbol of group.symbols){const transcript='A controlled source phrase.';const f=finding(group.category,symbol.symbol,transcript,{suggestedText:'A revised source phrase.'});
  const input={transcript,transcriptComplete:true,legend,policy:{strictness}};
  const value=semantic.validateCorrections([f],input).corrections[0];expect(value).toMatchObject({category:group.category,symbol:symbol.symbol,quotedText:transcript,startChar:0,endChar:transcript.length});expect(value.suggestedText).toBe(f.suggestedText);
  if(group.category!=='VOCABULARY'){const checks=['CONTENT','ORGANIZATION'].includes(group.category)?{coherenceLogic:false}:{grammarSpelling:false};
   try{semantic.validateCorrections([f],{...input,policy:{strictness,checks}});throw Error('not rejected');}catch(e){expect(e.diagnostics.rejectionReasons).toEqual({CATEGORY_DISABLED_BY_POLICY:1});}}
 }
});
test('all confusion pairs explicit, whole-document and no-quota instructions retained',()=>{
 const prompt=semantic.buildSemanticRequest(mixed).messages[1].content;
 for(const text of ['P is missing','SPC is incorrect whitespace','COH concerns','CO concerns','TS concerns','CONC concerns','REL concerns','TA concerns','WC concerns','COL concerns','SP concerns','WF concerns','FRAG is','RO joins','not representative examples','Insufficient evidence means no finding','Never return CONC when transcriptComplete=false'])expect(prompt).toContain(text);
});
test('valid sparse review never buys a GPT54 Mini quality audit even on long source',async()=>{
 const input={transcript:('A clear complete sentence. ').repeat(130),transcriptHash:'sparse',transcriptComplete:true};
 const {result,fetchImpl}=await run(input,[]);expect(result.corrections).toEqual([]);expect(fetchImpl).toHaveBeenCalledTimes(1);expect(result.diagnostics.categoryAudit.requested).toBe(false);
});
test('safe diagnostics exclude arbitrary provider/source keys and distinguish rejection stages',()=>{
 const {project}=require('../src/services/correctionQualityDiagnostics.service');
 const value=project({rawSymbolCounts:{CONC:1,privateSource:9},acceptedSymbolCounts:{CONC:0},rejectedCorrectionCount:1,
  rejectionReasons:{LOW_CONFIDENCE:1},rejectionReasonsBySymbol:{CONC:{LOW_CONFIDENCE:1}},raw:'privateSource',quotedText:'privateSource'},['CONC','privateSource']);
 expect(value.expectedSymbolPresence).toEqual([{symbol:'CONC',presentBeforeValidation:true,acceptedAfterValidation:false}]);
 expect(JSON.stringify(value)).not.toContain('privateSource');expect(value.rejectionReasonCounts.LOW_CONFIDENCE).toBe(1);
});
test.each([
 ['COH','ORGANIZATION','The result happened before its cause.',''],['CO','ORGANIZATION','It was raining. Therefore, it was dry.',''],
 ['TS','ORGANIZATION','Several unrelated details appear here.',''],['CONC','ORGANIZATION','That is all I know.',''],
 ['REL','CONTENT','My shoe is blue.',''],['TA','CONTENT','I will not discuss the assigned question.',''],
 ['WC','VOCABULARY','The idea tasted loud.','The idea sounded bold.'],['COL','VOCABULARY','We made attention.','We paid attention.'],
 ['SP','MECHANICS','mispell','misspell'],['WF','VOCABULARY','It is a benefit plan.','It is a beneficial plan.'],
 ['FRAG','GRAMMAR','Because it rained.','We stayed because it rained.'],['RO','GRAMMAR','It rained we stayed.','It rained, so we stayed.']
 ])('%s distinction retains exact category/quote/suggestion',async(symbol,category,transcript,suggestedText)=>{
 const {result}=await run({transcript,transcriptHash:'pair',transcriptComplete:true},[finding(category,symbol,transcript,{suggestedText})]);
 expect(result.corrections[0]).toMatchObject({symbol,category,quotedText:transcript,suggestedText,startChar:0,endChar:transcript.length});
});
