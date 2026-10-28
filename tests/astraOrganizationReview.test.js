'use strict';
const semantic=require('../src/services/semanticWritingCorrections.service');
const coordinator=require('../src/services/semanticCorrectionCoordinator.service');
const canonical=require('../src/services/correctionCanonical.service');
const teacher=require('../src/services/teacherEvaluationPolicy.service');
const client=require('../src/services/semanticAIClient.service');
const {defaultLegend}=require('../src/services/writingCorrections.service');
const {reviewPayload,finding}=require('./helpers/astraAssessmentFixtures.cjs');
const env={OPENROUTER_API_KEY:'offline-only',ASSESSMENT_AI_PRIMARY_RETRIES:'0'};
const opening='Public rules can restrict a character\'s choices.';
const example='For instance, she turns away a visitor to keep the quiet room to herself.';
const synthesis='Her choice connects public expectations with her private need for independence.';
function source(ending=example,policy={}){
  const transcript=opening+' '+'A demand for obedience limits her freedom. '.repeat(8)+ending;
  const spans=[...transcript.matchAll(/\S+/gu)].map((m,i)=>({start:m.index,end:m.index+m[0].length,
    fileId:'f',page:1,wordId:'word_f_1_gpt_'+(i+1),word:{id:'word_f_1_gpt_'+(i+1),text:m[0],bbox:null}}));
  return {transcript,transcriptHash:'frozen-organization-source',transcriptComplete:true,spans,legend:defaultLegend(),
    policy:teacher.normalizeTeacherEvaluationPolicy(policy),pageManifest:[{fileId:'f',pageNumber:1,startChar:0,endChar:transcript.length}],
    assignment:{title:'Explain public expectations and individual freedom',instructions:'Analyze the relationship using examples.'}};
}
function completion(input,findings=[]){
  const payload=reviewPayload(input.transcriptHash,teacher.enabledCorrectionCategories(input.policy),findings);
  if(payload.categories.ORGANIZATION&&!findings.some(c=>c.category==='ORGANIZATION'))payload.categories.ORGANIZATION.noFindingReason=
    'Coherence, cohesion, unity, opening claim and closure were reviewed; no defensible structural correction was found.';
  return jest.fn(async request=>({value:request.validate(JSON.stringify(payload)),content:JSON.stringify(payload),
    provider:'openrouter',model:'openai/gpt-6-astra',metrics:{attempts:[]}}));
}
const validate=(input,findings)=>semantic.validateCorrections(findings,{...input,env,legend:semantic.compactSemanticLegend(input.legend)});
function rejected(input,findings){
  let error;try{validate(input,findings);}catch(e){error=e;}
  expect(error).toMatchObject({code:'SEMANTIC_SCHEMA_INVALID',diagnostics:{acceptedCorrectionCount:0}});return error;
}
describe('primary Organization review prompt contract',()=>{
  test('all five distinct checks, implicit closure and source-grounded CONC are explicit without quotas',()=>{
    const input=source(),request=semantic.buildSemanticRequest(input),prompt=request.messages[1].content;
    for(const text of ['COH (coherence)','CO (cohesion)','PU (paragraph unity)','TS (topic-sentence function)',
      'CONC (closure)','actual final passage','final example','meaningful synthesis/closure','closure can be implicit',
      'no quota','Shortness alone never justifies CONC','separate concluding paragraph','correctionKind="global"',
      'smallest exact existing final sentence','Never invent missing conclusion text','Content/DEV','Content/TA',
      'genuinely independent problems','naturally phrased opening claim'])expect(prompt).toContain(text);
    expect(prompt).toContain('transcriptComplete=true');expect(prompt).toContain('complete symbol list in reviewedSymbols');
    expect(prompt).not.toContain('noFindingReason');expect(prompt).toContain('Never return CONC when transcriptComplete=false');
    expect(prompt).not.toContain('comfortable Moment');
    const definition=require('../src/services/writingCategoryDefinitions.service').DEFINITIONS.ORGANIZATION;
    for(const symbol of ['COH','CO','PU','TS','CONC'])expect(definition).toContain('('+symbol+')');
  });
  test('targeted audit uses the same checklist without adding a request',()=>{
    const input=source();
    const prompt=semantic.buildCategoryAuditRequest(input,semantic.buildSemanticRequest(input),['ORGANIZATION'])[1].content;
    expect(prompt).toContain('CONC (closure)');expect(prompt).toContain('Zero findings is valid after all five checks');
  });
  test('prompt/review identities advance while JSON response shape stays unchanged',()=>{
    expect(semantic.SEMANTIC_PROMPT_VERSION).toBe('semantic-corrections-v13-distinct-symbols');
    expect(semantic.CATEGORY_REVIEW_POLICY_VERSION).toBe('astra-category-review-v7-organization-checklist');
    expect(semantic.SEMANTIC_SCHEMA_VERSION).toBe('semantic-corrections-v14-compact-reviewed');
  });
});
describe('unchanged Organization grounding and canonical statistics',()=>{
  test.each(['friendly','balanced','strict'])('mock final-example CONC accepted under %s policy with no fabricated DEV',async strictness=>{
    const input=source(example,{strictness}),candidate=finding('ORGANIZATION','CONC',example,{
      message:'Reconnect the final example to the controlling claim.',suggestedText:'Add a synthesis explaining how this example supports the main claim.'});
    const runCompletion=completion(input,[candidate]);
    const result=await coordinator.analyze(input,{env,config:client.getAssessmentAIConfig(env),runCompletion});
    expect(runCompletion).toHaveBeenCalledTimes(1);expect(result.status).toBe('completed');
    expect(result.corrections).toHaveLength(1);expect(result.corrections[0]).toMatchObject({symbol:'CONC',category:'ORGANIZATION',
      correctionKind:'global',quotedText:example,startChar:input.transcript.lastIndexOf(example),endChar:input.transcript.length});
    expect(canonical.statistics(result.corrections)).toMatchObject({organization:1,content:0,total:1});
    expect(result.metrics).toMatchObject({mode:'single',mainCorrectionRequestCount:1,auditRequestCount:0,recoveryRequestCount:0});
  });
  test('incomplete source rejects a CONC even with exact final evidence',()=>{
    const input={...source(),transcriptComplete:false};const result=rejected(input,[finding('ORGANIZATION','CONC',example)]);
    expect(result.diagnostics.rejectionReasons.INCOMPLETE_TRANSCRIPT_CONCLUSION).toBe(1);
  });
  test('CONC near the opening retains CONCLUSION_NOT_AT_END rejection',()=>{
    const result=rejected(source(),[finding('ORGANIZATION','CONC',opening)]);
    expect(result.diagnostics.rejectionReasons.CONCLUSION_NOT_AT_END).toBe(1);
  });
  test('invented conclusion text never becomes source evidence',()=>{
    const result=rejected(source(),[finding('ORGANIZATION','CONC','A made-up final synthesis.')]);
    expect(result.diagnostics.rejectionReasons.QUOTE_NOT_FOUND).toBe(1);
  });
  test.each([example,synthesis])('schema-reviewed zero stays complete, without server inference or extra audit: %s',async ending=>{
    const input=source(ending),runCompletion=completion(input);
    const result=await coordinator.analyze(input,{env,config:client.getAssessmentAIConfig(env),runCompletion});
    expect(runCompletion).toHaveBeenCalledTimes(1);expect(result.corrections).toEqual([]);
    expect(result.status).toBe('completed');expect(result.coverage.categoryCoverageComplete.ORGANIZATION).toBe(true);
    expect(result.diagnostics.categoryReviewStatus.ORGANIZATION).toBe('ZERO_AFTER_REVIEW');
    expect(result.diagnostics.symbolReviewCoverage.ORGANIZATION.complete).toBe(true);
    expect(canonical.statistics(result.corrections)).toMatchObject({organization:0,content:0,total:0});
    expect(result.metrics.auditRequestCount).toBe(0);
  });
  test('coherenceLogic disabled omits Organization checklist and rejects injected structural findings',async()=>{
    const input=source(example,{checks:{coherenceLogic:false}}),prompt=semantic.buildSemanticRequest(input).messages[1].content;
    expect(prompt).not.toContain('COH (coherence)');expect(prompt).not.toContain('CONC (closure)');
    expect(rejected(input,[finding('ORGANIZATION','CONC',example)]).diagnostics.rejectionReasons.CATEGORY_DISABLED_BY_POLICY).toBe(1);
    const runCompletion=completion(input),result=await coordinator.analyze(input,{env,config:client.getAssessmentAIConfig(env),runCompletion});
    expect(runCompletion).toHaveBeenCalledTimes(1);expect(result.status).toBe('completed');
    expect(result.diagnostics.reviewedCategories).not.toContain('ORGANIZATION');expect(result.corrections).toEqual([]);
  });
});
