'use strict';
const gateway=require('../src/services/aiGateway.service');
const client=require('../src/services/semanticAIClient.service');
const coordinator=require('../src/services/semanticCorrectionCoordinator.service');
const canonical=require('../src/services/correctionCanonical.service');
const semantic=require('../src/services/semanticWritingCorrections.service');
const wire=require('../src/services/compactCorrectionWire.service');
const logger=require('../src/utils/logger');
const {reviewPayload,finding}=require('./helpers/astraAssessmentFixtures.cjs');
const env={OPENROUTER_API_KEY:'offline-only-secret',ASSESSMENT_AI_PRIMARY_RETRIES:'0'};
const response=(content,model=gateway.ASSESSMENT_MODEL)=>({ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify({model,
  choices:[{finish_reason:'stop',message:{content}}],usage:{prompt_tokens:2000,completion_tokens:400,total_tokens:2400,
    completion_tokens_details:{reasoning_tokens:50}}})});
const strictSchema={type:'object',additionalProperties:false,properties:{ok:{type:'boolean'}},required:['ok']};

test('actual coordinator -> facade -> gateway payload has minimal Astra reasoning without changing contract, budget, coverage or calls',async()=>{
  const transcript='mispell he go. he go. '+Array.from({length:96},(_,i)=>'word'+i+(i===95?'.':'')).join(' ');
  const input={transcript,transcriptHash:'frozen',transcriptComplete:true};
  const verbose=reviewPayload(input.transcriptHash,undefined,[finding('MECHANICS','SP','mispell',{suggestedText:'misspell'}),
    finding('GRAMMAR','AGR','he go',{occurrence:1,suggestedText:'he goes'})]);
  const payload={reviewContract:wire.VERSION,transcriptHash:verbose.transcriptHash,categories:Object.fromEntries(
    Object.entries(verbose.categories).map(([category,r])=>[category,{reviewed:r.reviewed,reviewedSymbols:r.reviewedSymbols,
      corrections:r.corrections.map(({message,stylePreference,...item})=>item)}]))};
  const fetchImpl=jest.fn(async()=>response(JSON.stringify(payload))),logs=jest.spyOn(logger,'info').mockImplementation(()=>{});
  try{
    const result=await coordinator.analyze(input,{env,fetchImpl,config:client.getAssessmentAIConfig(env)});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url,options]=fetchImpl.mock.calls[0],body=JSON.parse(options.body);
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(body.model).toBe('openai/gpt-6-astra');expect(body.reasoning).toEqual({effort:'minimal'});
    expect(body.max_tokens).toBe(3328);expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema.reviewContract).toBeUndefined();
    expect(body.response_format.json_schema.schema.properties.reviewContract.const).toBe(wire.VERSION);
    expect(Object.keys(body).sort()).toEqual(['model','messages','temperature','max_tokens','response_format','reasoning'].sort());
    expect(body).not.toHaveProperty('googleThinkingLevel');expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('max_completion_tokens');expect(body).not.toHaveProperty('models');
    expect(client.getAssessmentAIConfig(env).chain).toEqual([{provider:'openrouter',model:'openai/gpt-6-astra',fallbackIndex:0}]);
    expect(result.coverage.complete).toBe(true);expect(result.diagnostics.reviewedCategories).toHaveLength(5);
    expect(result.corrections).toHaveLength(2);expect(canonical.statistics(result.corrections)).toMatchObject({grammar:1,mechanics:1,total:2});
    const correction=result.corrections.find(c=>c.symbol==='AGR');expect(correction.startChar).toBe(transcript.lastIndexOf('he go'));
    for(const c of result.corrections)expect(transcript.slice(c.startChar,c.endChar)).toBe(c.quotedText);
    expect(input.transcript).toBe(transcript);
    for(const text of ['COH (coherence)','CO (cohesion)','PU (paragraph unity)','TS (topic-sentence function)','CONC (closure)'])
      expect(body.messages[1].content).toContain(text);
    expect(result.metrics.thoughtsTokenCount).toBe(50);
    const diagnostic=logs.mock.calls.map(([value])=>value).find(v=>v.event==='correction_request_performance');
    expect(diagnostic).toMatchObject({correctionReasoningConfigured:true,correctionReasoningEffort:'minimal',
      correctionRequestEndpoint:'/chat/completions',correctionResponseFormat:'json_schema_strict',
      correctionRequestedOutputTokens:3328,correctionPrimaryOutcome:'completed',correctionReasoningTokens:50});
    const safe=JSON.stringify(diagnostic);expect(safe).not.toContain(transcript);expect(safe).not.toContain(env.OPENROUTER_API_KEY);
    expect(safe).not.toContain(JSON.stringify(payload));
  }finally{logs.mockRestore();}
});

test.each([
  ['openrouter','openai/gpt-6-astra','semantic_corrections',true],
  ['openrouter','openai/gpt-6-astra','semantic_corrections_category_audit',true],
  ['openrouter','openai/gpt-6-astra','semantic_rubric_assessment',false],
  ['openrouter','openai/gpt-6-astra','rubric_completion',false],
  ['openrouter','openai/gpt-6-astra','gpt_vision_exact',false],
  ['openrouter','openai/gpt-6-astra','source_fidelity',false],
  ['openrouter','openai/gpt-4.1-mini','semantic_corrections',false],
  ['openrouter','anthropic/claude-fable-5.1','semantic_corrections',false],
  ['google','gemini-3.6-flash','semantic_corrections',false]
])('%s %s %s: feature/model isolation in actual serialized payload',async(provider,model,feature,configured)=>{
  const fetchImpl=jest.fn(async()=>provider==='google'?{ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify({
    candidates:[{finishReason:'STOP',content:{parts:[{text:'{"ok":true}'}]}}]})}:response('{"ok":true}',model));
  const attempt=gateway.providerAttempt({entry:{provider,model},messages:[{role:'user',content:'offline fixture'}],maxOutputTokens:3328,
    temperature:0,responseFormat:'json',responseSchema:strictSchema,schemaName:'fixture',attemptTimeoutMs:1000,
    fetchImpl,env:{...env,GEMINI_API_KEY:'offline-google'},now:Date.now,googleThinkingLevel:'minimal',feature});
  if(provider==='openrouter' && model!==gateway.ASSESSMENT_MODEL && gateway.isAssessmentFeature(feature))
    await expect(attempt).rejects.toMatchObject({code:'AI_ASSESSMENT_MODEL_MISMATCH'});
  else await attempt;
  const body=JSON.parse(fetchImpl.mock.calls[0][1].body);
  if(configured)expect(body.reasoning).toEqual({effort:'minimal'});else expect(body).not.toHaveProperty('reasoning');
  expect(body).not.toHaveProperty('googleThinkingLevel');expect(body).not.toHaveProperty('reasoning_effort');
  if(provider==='google')expect(body.generationConfig.thinkingConfig).toEqual({thinkingLevel:'minimal'});
  else expect(body.response_format).toEqual({type:'json_schema',json_schema:{name:'fixture',strict:true,schema:strictSchema}});
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test('rubric compatibility facade leaves its successful default reasoning policy unchanged',async()=>{
  const fetchImpl=jest.fn(async()=>response('{"ok":true}'));
  await client.runSemanticCompletion({env,config:client.getAssessmentAIConfig(env),fetchImpl,feature:'semantic_rubric_assessment',
    messages:[{role:'user',content:'offline rubric fixture'}],responseSchema:strictSchema,schemaName:'semantic_rubric_assessment'});
  const body=JSON.parse(fetchImpl.mock.calls[0][1].body);
  expect(body.model).toBe('openai/gpt-6-astra');expect(body.max_tokens).toBe(8000);
  expect(body).not.toHaveProperty('reasoning');expect(body.response_format.json_schema.strict).toBe(true);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
