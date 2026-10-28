'use strict';
const gateway=require('../src/services/aiGateway.service');
const client=require('../src/services/semanticAIClient.service');
const rubric=require('../src/services/semanticRubricAssessment.service');
const wire=require('../src/services/rubricWireValidation.service');
const {semanticRubricAssessmentSchema}=require('../src/services/structuredOutputSchemas.service');
const {generationSchema}=require('../src/services/geminiRubricWireSchema.service');
const model='google/gemini-3.8-flash';
const env={OPENROUTER_API_KEY:'mock-only',ASSESSMENT_AI_MODEL:model,GEMINI_RUBRIC_REASONING_EFFORT:'low',ASSESSMENT_AI_PRIMARY_RETRIES:'0'};
const input={transcript:'Public transport reduces traffic. Reliable schedules help workers arrive on time.',sourceHash:'synthetic-hash',
  assignment:{title:'Public transport',instructions:'Explain one benefit with support.'},transcriptComplete:true,includeLanguageCategories:true,
  policy:{strictness:'balanced',checks:{grammarSpelling:true,coherenceLogic:true,factChecking:false}},corrections:[]};
const request=rubric.buildRequest(input,model);
const payload=()=>({sourceHash:input.sourceHash,categories:Object.fromEntries(rubric.DEGRADED_CATEGORIES.map(category=>[category,{
  score:20,maxScore:20,comment:'The brief response clearly supports its relevant idea.',strengthEvidence:[{evidenceId:request.evidenceCatalog[0].evidenceId,explanation:'The opening directly answers the task.'}],improvementEvidence:[]}]))});
const schema=semanticRubricAssessmentSchema(input.sourceHash,{categories:rubric.DEGRADED_CATEGORIES,transcriptEvidenceIds:request.evidenceCatalog.map(x=>x.evidenceId)});
const reply=(content=JSON.stringify(payload()),returnedModel=model,finish='stop',status=200)=>({ok:status===200,status,headers:{get:()=>null},text:async()=>JSON.stringify({model:returnedModel,
  choices:[{finish_reason:finish,message:{content}}],usage:{prompt_tokens:1000,completion_tokens:600,total_tokens:1600,cost:.003,completion_tokens_details:{reasoning_tokens:100}}})});
const run=fetchImpl=>rubric.assess(input,{env,fetchImpl,disableEvidenceRepair:true});
test('independent approved scoring selection and explicit Astra rollback',()=>{
  expect(client.getAssessmentAIConfig(env)).toMatchObject({model,thinkingLevel:'low',fallback:null,maxOutputTokens:8000});
  expect(client.getAssessmentAIConfig({...env,ASSESSMENT_AI_MODEL:gateway.ASSESSMENT_MODEL}).model).toBe(gateway.ASSESSMENT_MODEL);
  expect(gateway.getCorrectionAIConfig({...env,CORRECTION_DETECTION_MODEL:model,GEMINI_RUBRIC_REASONING_EFFORT:'invalid'}).chain[0].model).toBe(model);
  expect(client.getCorrectionAIConfig({...env,CORRECTION_DETECTION_MODEL:model,GEMINI_CORRECTION_REASONING_EFFORT:'high'}).thinkingLevel).toBe('high');
  expect(client.getAssessmentAIConfig({...env,GEMINI_CORRECTION_REASONING_EFFORT:'high'}).thinkingLevel).toBe('low');
  expect(()=>client.getAssessmentAIConfig({...env,ASSESSMENT_AI_MODEL:'unapproved/model'})).toThrow();
  expect(()=>client.getAssessmentAIConfig({...env,GEMINI_RUBRIC_REASONING_EFFORT:'minimal'})).toThrow();
  expect(gateway.getTeacherCommentAIConfig(env).chain[0].model).toBe('anthropic/claude-haiku-5.5');
});
test('one complete rubric request has strict schema, low reasoning, isolated prompt, usage and no fallback',async()=>{
  const fetchImpl=jest.fn(async()=>reply());const result=await run(fetchImpl);
  expect(fetchImpl).toHaveBeenCalledTimes(1);const body=JSON.parse(fetchImpl.mock.calls[0][1].body);
  expect(body).toMatchObject({model,reasoning:{effort:'low'},max_tokens:8000,provider:{require_parameters:true,allow_fallbacks:false},response_format:{type:'json_schema',json_schema:{strict:true,schema:generationSchema(schema)}}});
  expect(body).not.toHaveProperty('temperature');expect(body.messages[0].content).toContain('senior English writing assessment specialist');
  expect(JSON.stringify(body.messages)).not.toContain('semantic-corrections-');
  expect(result).toMatchObject({model,returnedModel:model,httpStatus:200,finishReason:'stop',promptVersion:rubric.GEMINI_PROMPT_VERSION,
    metrics:{attemptCount:1,thoughtsTokenCount:100,providerCostUSD:.003}});
  expect(Object.keys(result.categories)).toEqual(rubric.DEGRADED_CATEGORIES);
});
test.each([undefined,'openai/gpt-6-astra','google/gemini-wrong'])('missing/substituted identity %s never falls back',async identity=>{
  const fetchImpl=jest.fn(async()=>({...reply(),text:async()=>JSON.stringify({...(identity?{model:identity}:{}),choices:[{finish_reason:'stop',message:{content:JSON.stringify(payload())}}]})}));
  await expect(run(fetchImpl)).rejects.toMatchObject({finalFailureCode:'AI_ASSESSMENT_MODEL_MISMATCH'});expect(fetchImpl).toHaveBeenCalledTimes(1);
});
test.each([
  ['missing category',p=>{delete p.categories.GRAMMAR;}],['extra category',p=>{p.categories.PRESENTATION=p.categories.GRAMMAR;}],
  ['extra field',p=>{p.overallScore=100;}],['extra nested field',p=>{p.categories.GRAMMAR.fabricated=true;}],
  ['negative',p=>{p.categories.GRAMMAR.score=-1;}],['above maximum',p=>{p.categories.GRAMMAR.score=21;}],
  ['string score',p=>{p.categories.GRAMMAR.score='20';}],['NaN',p=>{p.categories.GRAMMAR.score=NaN;}],
  ['infinite',p=>{p.categories.GRAMMAR.score=Infinity;}],['wrong maximum',p=>{p.categories.GRAMMAR.maxScore=25;}],
  ['empty comment',p=>{p.categories.GRAMMAR.comment='';}],['long comment',p=>{p.categories.GRAMMAR.comment='x'.repeat(321);}],
  ['wrong source',p=>{p.sourceHash='other';}],['invented evidence',p=>{p.categories.GRAMMAR.strengthEvidence[0].evidenceId='invented';}],
  ['too many evidence entries',p=>{p.categories.GRAMMAR.strengthEvidence=Array(21).fill(p.categories.GRAMMAR.strengthEvidence[0]);}],
  ['invented nullable correction ID',p=>{p.categories.GRAMMAR.improvementEvidence=[{findingScope:'localized',evidenceType:'correction',
    correctionId:'invented',evidenceId:null,explanation:'A claim.',suggestion:'A suggestion.'}];}]
])('strict wire rejects %s without producing a grade',async(_,mutate)=>{
  const p=payload();mutate(p);expect(()=>wire.validateWire(JSON.stringify(p),schema)).toThrow();
  const fetchImpl=jest.fn(async()=>reply(JSON.stringify(p)));await expect(run(fetchImpl)).rejects.toBeDefined();expect(fetchImpl).toHaveBeenCalledTimes(1);
});
test('duplicate categories, including escaped JSON keys, cannot be silently overwritten',async()=>{
  const text=JSON.stringify(payload()),value=JSON.stringify(payload().categories.CONTENT);
  for(const key of ['CONTENT','CONT\\u0045NT']) {
    const duplicate=text.replace('"categories":{','"categories":{"'+key+'":'+value+',');
    expect(()=>wire.validateWire(duplicate,schema)).toThrow();
    const fetchImpl=jest.fn(async()=>reply(duplicate));await expect(run(fetchImpl)).rejects.toBeDefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  }
});
test.each([['invalid JSON','{','stop',200],['truncated',JSON.stringify(payload()),'length',200],['unsupported provider parameters','{}','stop',400],['rate limit','{}','stop',429],['outage','{}','stop',503]])('%s fails once without Astra fallback',async(_,content,finish,status)=>{
  const fetchImpl=jest.fn(async()=>reply(content,model,finish,status));await expect(run(fetchImpl)).rejects.toBeDefined();expect(fetchImpl).toHaveBeenCalledTimes(1);
});
test('timeout remains bounded and buys no retry',async()=>{
  const fetchImpl=jest.fn((url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'})))));
  await expect(rubric.assess(input,{env,fetchImpl,config:{...client.getAssessmentAIConfig(env),attemptTimeoutMs:15,totalBudgetMs:100},disableEvidenceRepair:true})).rejects.toBeDefined();
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
test.each(['friendly','balanced','strict'])('%s teacher settings and page boundaries reach the scoring prompt unchanged',strictness=>{
  const source={...input,transcript:input.transcript+'\n\n\f\n\nAnother page.',policy:{...input.policy,strictness},
    pageManifest:[{fileId:'image-1',pageNumber:1,startChar:0,endChar:input.transcript.length},{fileId:'pdf-2',pageNumber:2,startChar:input.transcript.length+5,endChar:input.transcript.length+18}]};
  const built=rubric.buildRequest(source,model);expect(built.messages[1].content).toContain('"strictness":"'+strictness+'"');
  expect(built.messages[1].content).toContain('pdf-2');expect(built.evidenceCatalog.every(e=>source.transcript.slice(e.startChar,e.endChar)===e.quotedText)).toBe(true);
});
test('model and reasoning change cache/runtime identity, not source or historical record',()=>{
  const {analysisInputHash}=require('../src/services/canonicalEvaluation.service'),{runtimeContractFingerprint}=require('../src/services/runtimeContractFingerprint.service');
  const old=process.env.ASSESSMENT_AI_MODEL,reasoning=process.env.GEMINI_RUBRIC_REASONING_EFFORT;
  try{
    const identity={sourceHash:'source',rubricHash:'rubric',policyHash:'policy',contextHash:'context'};
    process.env.ASSESSMENT_AI_MODEL=gateway.ASSESSMENT_MODEL;const a=analysisInputHash(identity);
    process.env.ASSESSMENT_AI_MODEL=model;process.env.GEMINI_RUBRIC_REASONING_EFFORT='low';const b=analysisInputHash(identity);
    process.env.GEMINI_RUBRIC_REASONING_EFFORT='medium';expect(analysisInputHash(identity)).not.toBe(b);expect(a).not.toBe(b);
    expect(runtimeContractFingerprint(env).contractHash).not.toBe(runtimeContractFingerprint({...env,ASSESSMENT_AI_MODEL:gateway.ASSESSMENT_MODEL}).contractHash);
    expect(identity).toEqual({sourceHash:'source',rubricHash:'rubric',policyHash:'policy',contextHash:'context'});
  }finally{if(old===undefined)delete process.env.ASSESSMENT_AI_MODEL;else process.env.ASSESSMENT_AI_MODEL=old;if(reasoning===undefined)delete process.env.GEMINI_RUBRIC_REASONING_EFFORT;else process.env.GEMINI_RUBRIC_REASONING_EFFORT=reasoning;}
});
test('rubric-only QA requires authorization, consumes one marker, and cannot invoke other assessment stages',async()=>{
  const {runRubricOnly}=require('../scripts/liveGeminiSemanticSmoke');
  const consume=jest.fn(),fetchImpl=jest.fn(async(url,{body})=>{
    const request=JSON.parse(body),prompt=request.messages[1].content;
    const line=prefix=>prompt.split('\n').find(s=>s.startsWith(prefix)).slice(prefix.length);
    const evidence=JSON.parse(line('evidenceCatalog='));
    const value={sourceHash:line('sourceHash='),categories:Object.fromEntries(rubric.DEGRADED_CATEGORIES.map(category=>[category,{
      score:20,maxScore:20,comment:'The concise response supports a relevant benefit.',strengthEvidence:[{evidenceId:evidence[0].evidenceId,explanation:'The opening identifies a benefit.'}],improvementEvidence:[]}]))};
    return reply(JSON.stringify(value));
  });
  await expect(runRubricOnly({env,fetchImpl,consume})).rejects.toMatchObject({code:'RUBRIC_QA_AUTHORIZATION_REQUIRED'});
  expect(fetchImpl).not.toHaveBeenCalled();expect(consume).not.toHaveBeenCalled();
  const result=await runRubricOnly({authorized:true,env,fetchImpl,consume});
  expect(result).toMatchObject({status:'completed',providerCallCount:1,schemaValidation:'PASS',quality:'UNPROVEN'});
  expect(fetchImpl).toHaveBeenCalledTimes(1);expect(consume).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toMatch(/Public transport|opening identifies|mock-only|Bearer/);
  const blocked=await runRubricOnly({authorized:true,env,fetchImpl,consume:()=>{throw Object.assign(Error('consumed'),{code:'EEXIST'});}});
  expect(blocked).toMatchObject({status:'failed',providerCallCount:0});expect(fetchImpl).toHaveBeenCalledTimes(1);
});
test('concurrent scoring sources stay isolated and do not borrow correction admission slots',async()=>{
  const admission=jest.spyOn(require('../src/services/correctionAdmission.service').shared,'acquire').mockRejectedValue(Error('correction queue full'));
  const fetchImpl=jest.fn(async(url,{body})=>{
    const prompt=JSON.parse(body).messages[1].content,p=payload();p.sourceHash=prompt.split('\n').find(s=>s.startsWith('sourceHash=')).slice(11);
    return reply(JSON.stringify(p));
  });
  try{
    const results=await Promise.all(['student-a','student-b'].map(sourceHash=>rubric.assess({...input,sourceHash},{env,fetchImpl,disableEvidenceRepair:true})));
    expect(results.map(r=>r.sourceHash)).toEqual(['student-a','student-b']);expect(fetchImpl).toHaveBeenCalledTimes(2);expect(admission).not.toHaveBeenCalled();
  }finally{admission.mockRestore();}
});
test.each(['valid','duplicate','unconfigured percentage'])('Gemini preserves configured custom levels: %s',async mode=>{
  const customRubric={criteria:[{id:'teacher-criterion',title:'Content',weight:100,
    levels:[{title:'Developed',percentage:90,description:'Explains several supported benefits.'},{title:'Basic',percentage:60,description:'Explains one relevant benefit.'}]}]};
  const p=payload();p.customCriteria=[{criterionId:'teacher-criterion',percentage:60,levelTitle:'Basic',
    comment:'One benefit is supported; several supported benefits are needed for the higher level.',evidenceIds:[request.evidenceCatalog[0].evidenceId]}];
  if(mode==='duplicate')p.customCriteria.push({...p.customCriteria[0]});
  if(mode==='unconfigured percentage')p.customCriteria[0].percentage=70;
  const fetchImpl=jest.fn(async()=>reply(JSON.stringify(p)));
  const pending=rubric.assess({...input,customRubric},{env,fetchImpl,disableEvidenceRepair:true});
  if(mode==='valid')expect((await pending).customCriteria[0]).toMatchObject({criterionId:'teacher-criterion',percentage:60,levelTitle:'Basic'});
  else await expect(pending).rejects.toBeDefined();
  expect(fetchImpl).toHaveBeenCalledTimes(1);expect(customRubric.criteria[0].levels[0].percentage).toBe(90);
});

test.each(rubric.DEGRADED_CATEGORIES)('%s deduction without evidence reproduces the consistency failure without altering its score',async category=>{
  const p=payload();p.categories[category].score=18;
  const fetchImpl=jest.fn(async()=>reply(JSON.stringify(p)));
  await expect(run(fetchImpl)).rejects.toMatchObject({code:'SEMANTIC_RUBRIC_EVIDENCE_REQUIRED',
    validationStage:'consistency_validation',jsonPath:`$.categories.${category}.improvementEvidence`});
  expect(p.categories[category].score).toBe(18);expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test('correct prose with zero canonical corrections permits full Grammar marks without invented improvement',async()=>{
  const p=payload(),fetchImpl=jest.fn(async()=>reply(JSON.stringify(p)));
  const result=await run(fetchImpl);
  expect(result.categories.GRAMMAR).toMatchObject({score:20,issueCount:0,improvementEvidence:[]});
  expect(result.categories.MECHANICS).toMatchObject({score:20,issueCount:0,improvementEvidence:[]});
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test.each([
  ['CONTENT','Buses are useful.','holistic','The benefit is asserted without the requested supporting example.','Add a concrete example showing how buses help.'],
  ['GRAMMAR','Buses is useful.','localized','The plural subject uses a singular verb.','Use a plural verb with the plural subject.'],
  ['MECHANICS','Buses are usefull.','localized','The adjective has an extra final letter.','Spell the adjective with one final l.']
])('%s genuine weakness accepts exact transcript evidence with zero corrections',async(category,transcript,findingScope,explanation,suggestion)=>{
  const source={...input,transcript},built=rubric.buildRequest(source,model),p=payload();
  for(const item of Object.values(p.categories))item.strengthEvidence=[];
  p.categories[category].score=18;p.categories[category].comment=explanation;
  p.categories[category].improvementEvidence=[{findingScope,evidenceType:'transcript',correctionId:null,
    evidenceId:built.evidenceCatalog[0].evidenceId,explanation,suggestion}];
  const fetchImpl=jest.fn(async()=>reply(JSON.stringify(p)));
  const result=await rubric.assess(source,{env,fetchImpl,disableEvidenceRepair:true});
  expect(result.categories[category]).toMatchObject({score:18,issueCount:0,improvementEvidence:[{
    findingScope,evidenceType:'transcript',correctionId:null,quotedText:transcript,startChar:0,endChar:transcript.length}]});
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test.each(['same category','wrong category','invented ID'])('canonical correction evidence: %s',async mode=>{
  const transcript='Buses is useful.',correction={id:'grammar-1',category:'GRAMMAR',symbol:'AGR',quotedText:'Buses is',startChar:0,endChar:8};
  const source={...input,transcript,corrections:[correction]},p=payload();
  for(const item of Object.values(p.categories))item.strengthEvidence=[];
  const category=mode==='wrong category'?'VOCABULARY':'GRAMMAR';
  p.categories[category].score=18;
  p.categories[category].improvementEvidence=[{findingScope:'localized',evidenceType:'correction',
    correctionId:mode==='invented ID'?'invented':'grammar-1',evidenceId:'correction:grammar-1',
    explanation:'Plural subject and singular verb disagree.',suggestion:'Use a plural verb.'}];
  const fetchImpl=jest.fn(async()=>reply(JSON.stringify(p)));
  const pending=rubric.assess(source,{env,fetchImpl,disableEvidenceRepair:true});
  if(mode==='same category')expect((await pending).categories.GRAMMAR).toMatchObject({score:18,issueCount:1,
    improvementEvidence:[{correctionId:'grammar-1',evidenceId:'correction:grammar-1',quotedText:'Buses is',startChar:0,endChar:8}]});
  else await expect(pending).rejects.toMatchObject({code:'SEMANTIC_RUBRIC_SCHEMA_INVALID'});
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test.each(['missing array','unknown ID','missing identity'])('malformed deduction fails before evidence-required consistency: %s',async mode=>{
  const p=payload();p.categories.GRAMMAR.score=18;
  p.categories.GRAMMAR.improvementEvidence=[{findingScope:'holistic',evidenceType:'transcript',correctionId:null,
    evidenceId:'not-in-catalog',explanation:'A claim.',suggestion:'A suggestion.'}];
  if(mode==='missing array')delete p.categories.GRAMMAR.improvementEvidence;
  if(mode==='missing identity')delete p.sourceHash;
  const fetchImpl=jest.fn(async()=>reply(JSON.stringify(p)));
  await expect(run(fetchImpl)).rejects.toMatchObject({code:'SEMANTIC_RUBRIC_SCHEMA_INVALID',validationStage:'schema_validation'});
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test('Gemini-only instruction reinforces deduction evidence without changing Astra or cache source identity',()=>{
  const prompt=request.messages[0].content;
  expect(prompt).toContain('score < maxScore requires at least one appropriate source-grounded improvementEvidence');
  expect(prompt).toContain('never invent a weakness or automatically raise a score');
  expect(prompt).toContain('correctionId=null');expect(prompt).toContain('same-category correctionCatalog');
  expect(prompt).toContain('scores and evidence items are placeholders');
  expect(prompt).toContain('every selected level requires relevant transcript evidence');
  const astra=rubric.buildRequest(input,gateway.ASSESSMENT_MODEL);
  expect(astra.messages[0].content).toBe('You are a strict evidence-grounded writing rubric assessor. Output one JSON object only.');
  expect(astra.evidenceCatalog).toEqual(request.evidenceCatalog);expect(astra.allowedCorrectionIds).toEqual(request.allowedCorrectionIds);
  expect(astra.messages[1].content).not.toContain(rubric.GEMINI_PROMPT_VERSION);
});
