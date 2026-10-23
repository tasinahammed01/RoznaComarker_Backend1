'use strict';
jest.mock('../src/models/SubmissionFeedback',()=>({findOne:jest.fn(),findOneAndUpdate:jest.fn(),updateOne:jest.fn()}));
jest.mock('../src/models/class.model',()=>({findById:()=>({select:()=>({lean:async()=>({teacher:'teacher'})})})}));
jest.mock('../src/models/user.model',()=>({findById:()=>({select:()=>({lean:async()=>null})})}));
const policy=require('../src/services/assessmentExecutionPolicy.service');
const accounting=require('../src/services/providerAttemptAccounting.service');
const semantic=require('../src/services/semanticWritingCorrections.service');
const gateway=require('../src/services/aiGateway.service');
const {reviewPayload,finding}=require('./helpers/astraAssessmentFixtures.cjs');
const transcript=Array.from({length:101},(_,i)=>(i===0?'mispell':'word'+i)+([32,65,100].includes(i)?'.':'')).join(' ');
function delay(ms,signal){return new Promise((resolve,reject)=>{
  const abort=()=>{clearTimeout(timer);reject(Object.assign(Error('cancelled'),{name:'AbortError'}));};
  const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
});}
describe('production-shaped bounded Astra correction requests',()=>{
  const oldEnv={...process.env};let oldFetch;
  beforeEach(()=>{jest.useFakeTimers({now:1000});oldFetch=global.fetch;
    Object.assign(process.env,{OPENROUTER_API_KEY:'offline-key',ASSESSMENT_AI_ATTEMPT_TIMEOUT_MS:'90000',
      ASSESSMENT_AI_TOTAL_BUDGET_MS:'300000',ASSESSMENT_CORRECTION_BUDGET_MS:'180000',ASSESSMENT_RUBRIC_RESERVED_BUDGET_MS:'90000',
      ASSESSMENT_AI_PRIMARY_RETRIES:'0'});});
  afterEach(()=>{global.fetch=oldFetch;jest.useRealTimers();for(const k of Object.keys(process.env))if(!(k in oldEnv))delete process.env[k];Object.assign(process.env,oldEnv);});
  test.each([1000,38000,46000,55000,60001])('%ims: one uninterrupted short correction attempt, then rubric',async correctionDuration=>{
    const timedOut=correctionDuration>60000;
    const feedback=require('../src/models/SubmissionFeedback');let stored=null,correctionCalls=0,rubricCalls=0;
    const requests=[];
    const state={_id:'submission',class:'class',student:'student',files:['f'],ocrJobId:'ocr',ocrStatus:'completed',writingCorrections:[],
      ocrPages:[{fileId:'f',pageNumber:1,text:transcript,sourceVerificationSummary:{performance:{preflightSourceMs:57093,
        sourceReuseMs:140,geometryMs:605,sourceMs:140,sourceReused:true,sourceProviderCallCount:0,geometryProviderCallCount:1}}}]};
    const apply=(object,update)=>{Object.assign(object,update.$set||{});for(const key of Object.keys(update.$unset||{}))delete object[key];};
    const model={updateOne:jest.fn(async(_q,u)=>{apply(state,u);return {modifiedCount:1};}),
      findById:jest.fn(async()=>({...state,constructor:model})),exists:jest.fn().mockResolvedValue({})};
    feedback.findOne.mockImplementation(()=>({lean:async()=>stored}));
    feedback.updateOne.mockImplementation(async(_q,u)=>{if(stored)apply(stored,u);return {modifiedCount:1};});
    feedback.findOneAndUpdate.mockImplementation(async(_q,u)=>{stored||={};apply(stored,u);return stored;});
    global.fetch=jest.fn(async(_url,options)=>{
      const body=JSON.parse(options.body),prompt=body.messages[1].content;requests.push(body);
      expect(body.model).toBe('openai/gpt-6-astra');let payload;
      if(prompt.includes('transcriptHash=')){
        correctionCalls++;
        await delay(correctionDuration,options.signal);
        payload=reviewPayload(prompt.match(/^transcriptHash=(.+)$/mu)[1],undefined,[finding('MECHANICS','SP','mispell',{suggestedText:'misspell'})]);
        payload={reviewContract:require('../src/services/compactCorrectionWire.service').VERSION,transcriptHash:payload.transcriptHash,
          categories:Object.fromEntries(Object.entries(payload.categories).map(([category,r])=>[category,{reviewed:r.reviewed,
            reviewedSymbols:r.reviewedSymbols,corrections:r.corrections.map(({message,stylePreference,...item})=>item)}]))};
      }else{
        rubricCalls++;await delay(44000,options.signal);
        const catalog=JSON.parse(prompt.split('\n').find(l=>l.startsWith('evidenceCatalog=')).slice('evidenceCatalog='.length));
        payload={sourceHash:prompt.match(/^sourceHash=(.+)$/mu)[1],categories:Object.fromEntries(
          ['CONTENT','ORGANIZATION','VOCABULARY','GRAMMAR','MECHANICS'].map((category,i)=>[category,{
            score:i<3?20-(20-[13,14,15][i])/.85:category==='GRAMMAR'?12:11,maxScore:20,comment:'Grounded holistic review.',
            strengthEvidence:[{evidenceId:catalog[0].evidenceId,explanation:'The response states a point.'}],
            improvementEvidence:[{findingScope:'holistic',evidenceType:'transcript',correctionId:null,evidenceId:catalog[0].evidenceId,
              explanation:'The claim could be connected more clearly.',suggestion:'Explain the connection.'}]}]))};
      }
      return {ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify({model:body.model,choices:[{finish_reason:'stop',message:{content:JSON.stringify(payload)}}]})};
    });
    let counters;
    const work=accounting.run(async()=>{
      await new Promise(resolve=>setTimeout(resolve,140));const done=accounting.begin('google_geometry','google_vision');
      await new Promise(resolve=>setTimeout(resolve,605));done('completed');
      await require('../src/services/canonicalCorrectionsPipeline.service').generateAndPersist({...state,constructor:model},{assignment:{title:'Explain a claim',instructions:'Use examples.'}});
      counters=accounting.snapshot();
    });
    await jest.runAllTimersAsync();await work;
    expect(correctionCalls).toBe(1);expect(rubricCalls).toBe(1);
    const correctionRequests=requests.filter(r=>r.messages[1].content.includes('transcriptHash='));
    for(const body of correctionRequests)expect(body.reasoning).toEqual({effort:'minimal'});
    for(const body of requests.filter(r=>!r.messages[1].content.includes('transcriptHash=')))expect(body).not.toHaveProperty('reasoning');
    expect(correctionRequests[0].max_tokens).toBe(3328);
    expect(correctionRequests).toHaveLength(1);
    expect(counters).toMatchObject({sourceProviderCalls:0,geometryProviderCalls:1,correctionProviderAttempts:correctionCalls,
      correctionRecoveryCalls:0,rubricAssessmentCalls:1,rubricDesignerCalls:0,totalProviderAttempts:3});
    expect(state.semanticMetrics.performance).toMatchObject({preflightSourceMs:57093,sourceReuseMs:140,geometryMs:605,
      providerCallCount:correctionCalls+2,rubricProviderAttempts:1,rubricDesignerAttempts:0});
    expect(state.evaluationStatus).toBe('completed');expect(stored.evaluationStatus).toBe('completed');
    expect(state.semanticMetrics.performance.totalResultReadyMs).toBe(Math.min(correctionDuration,60000)+44000);
    expect(state.semanticMetrics.rubricRemainingBudgetAtStart).toBeGreaterThanOrEqual(90000);
    expect(state.semanticMetrics.performance.correctionRecoveryMs).toBe(0);
    if(timedOut){
      expect(state.semanticStatus).toBe('failed');expect(state.semanticErrorCode).toBe('AI_ATTEMPT_TIMEOUT');
      expect(state.semanticMetrics.performance).toMatchObject({correctionPrimaryMs:60000,correctionRecoveryMs:0,
        correctionRecoveryStrategy:'short_timeout_no_auto_recovery',correctionPrimaryOutcome:'AI_ATTEMPT_TIMEOUT',correctionRecoveryOutcome:'not_attempted'});
      expect(state.writingCorrections).toEqual([]);
      const current=require('../src/services/canonicalResultState.service').buildCanonicalResultState({submission:state,feedback:stored});
      expect(current.categoryAvailability.organization).toBe('failed');expect(current.evaluationStatus).toBe('completed');
      expect(stored.overallScore).toBe(67);
    }else{
      expect(state.semanticStatus).toBe('completed');expect(state.semanticMetrics.correctionCoverageComplete).toBe(true);
      expect(state.correctionStatistics).toMatchObject({mechanics:1,organization:0});
      expect(state.semanticMetrics.detailedFeedbackFresh).toBe(true);
    }
    const before=global.fetch.mock.calls.length;
    const reload=require('../src/services/canonicalEvaluation.service').generate({submission:{...state,constructor:model},assignment:{title:'Explain a claim',instructions:'Use examples.'}});
    await jest.runAllTimersAsync();expect((await reload).status).toBe(timedOut?'superseded':'reused');expect(global.fetch).toHaveBeenCalledTimes(before);
    expect(jest.getTimerCount()).toBe(0);
  });
});
describe('safe output and configuration envelopes',()=>{
  test('one resolved short policy reuses 60s envelope and respects configured/stage/reserve limits',()=>{
    expect(policy.validateConfiguration({}).settings).toMatchObject({shortCorrectionAttemptTimeoutMs:60000,
      shortCorrectionAutoRecoveryEnabled:false,correctionStageBudgetMs:180000,rubricReservedBudgetMs:90000});
    expect(policy.shortCorrectionPolicy({attemptTimeoutMs:40000}).shortCorrectionAttemptTimeoutMs).toBe(40000);
    expect(policy.shortCorrectionPolicy({env:{ASSESSMENT_CORRECTION_BUDGET_MS:'50000'}}).shortCorrectionAttemptTimeoutMs).toBe(50000);
    expect(policy.shortCorrectionPolicy({env:{ASSESSMENT_AI_TOTAL_BUDGET_MS:'120000'}}).shortCorrectionAttemptTimeoutMs).toBe(30000);
  });
  test('short 101-word response has a generous dynamic allowance, long/multipage retains ceiling',()=>{
    const short=policy.correctionOutputBudget({transcript}),long=policy.correctionOutputBudget({transcript:transcript.repeat(10),pageCount:2});
    expect(short.requestedOutputTokenBudget).toBeLessThan(8000);expect(short.requestedOutputTokenBudget).toBeGreaterThan(short.estimatedRequiredOutputTokens);
    expect(long.requestedOutputTokenBudget).toBe(8000);
    const data=require('./fixtures/astraCoverageFeedback.cjs').fixture();
    const payload=JSON.stringify(reviewPayload('hash',undefined,data.findings));
    expect(Math.ceil(payload.length/4)).toBeLessThan(policy.correctionOutputBudget({transcript:data.transcript}).requestedOutputTokenBudget);
  });
  test('unsafe startup math is explicit, without changing valid default budgets',()=>{
    expect(policy.validateConfiguration({}).errors).toEqual([]);
    expect(policy.validateConfiguration({ASSESSMENT_RUBRIC_RESERVED_BUDGET_MS:'300000'}).errors).toContain('RUBRIC_RESERVE_EXHAUSTS_OVERALL');
    expect(policy.validateConfiguration({ASSESSMENT_AI_ATTEMPT_TIMEOUT_MS:'200000'}).errors).toContain('ATTEMPT_EXCEEDS_CORRECTION_WINDOW');
    expect(policy.validateConfiguration({SEMANTIC_AI_MAX_OUTPUT_TOKENS:'500'}).errors).toContain('OUTPUT_LIMIT_BELOW_REVIEW_SAFE_FLOOR');
  });
  test('compact prompt preserves Organization v11, teacher policy, all review declarations and exact source',()=>{
    const input={transcript,transcriptHash:'hash',transcriptComplete:true};
    const main=semantic.buildSemanticRequest(input),compact=semantic.buildSemanticRequest({...input,analysisMode:'compact_recovery'});
    expect(compact.promptCharacters).toBeLessThan(main.promptCharacters*.85);
    for(const value of [transcript,'teacherEvaluationPolicy','reviewedSymbols','COH','CONC','PU','TS'])expect(compact.messages[1].content).toContain(value);
    expect(semantic.SEMANTIC_PROMPT_VERSION).toBe('semantic-corrections-astra-v12-compact-organization-closure');
    expect(main.tokenProfile).toMatchObject({estimation:'characters_divided_by_four',responseSchemaTokens:expect.any(Number)});
  });
});
describe('abort cleanup',()=>{
  afterEach(()=>jest.useRealTimers());
  test('client timeout ends the attempt even if a custom transport ignores abort, late body is never accepted',async()=>{
    jest.useFakeTimers();let resolve;
    const fetchImpl=jest.fn(()=>new Promise(r=>{resolve=r;}));
    const result=gateway.providerAttempt({entry:{provider:'openrouter',model:'openai/gpt-6-astra'},messages:[],maxOutputTokens:4096,
      env:{OPENROUTER_API_KEY:'offline'},feature:'semantic_corrections',attemptTimeoutMs:1000,fetchImpl,now:Date.now}).catch(e=>e);
    await jest.advanceTimersByTimeAsync(1000);expect((await result).code).toBe('AI_ATTEMPT_TIMEOUT');
    const cancel=jest.fn(async()=>{});
    resolve({ok:true,status:200,body:{cancel},text:async()=>{throw Error('must not read abandoned body');}});await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
describe('attempt scopes',()=>{
  test('parallel assessment scopes count real mocked gateway attempts independently, including designer and recovery',async()=>{
    const fetchImpl=jest.fn(async()=>({ok:true,status:200,text:async()=>JSON.stringify({model:'openai/gpt-6-astra',choices:[{finish_reason:'stop',message:{content:'{}'}}]})}));
    const call=feature=>gateway.providerAttempt({entry:{provider:'openrouter',model:'openai/gpt-6-astra'},messages:[],maxOutputTokens:4096,
      env:{OPENROUTER_API_KEY:'offline'},feature,attemptTimeoutMs:1000,fetchImpl,now:Date.now});
    const [first,second]=await Promise.all([
      accounting.run(async()=>{await call('semantic_corrections');await accounting.withRole('recovery',()=>call('semantic_corrections'));
        await call('semantic_rubric_assessment');await call('rubric_completion');return accounting.snapshot();}),
      accounting.run(async()=>{await call('semantic_corrections');return accounting.snapshot();})]);
    expect(first).toMatchObject({correctionProviderAttempts:2,correctionRecoveryCalls:1,rubricAssessmentCalls:1,rubricDesignerCalls:1,totalProviderAttempts:4});
    expect(second).toMatchObject({correctionProviderAttempts:1,correctionRecoveryCalls:0,totalProviderAttempts:1});
    expect(accounting.snapshot().totalProviderAttempts).toBe(0);expect(fetchImpl).toHaveBeenCalledTimes(5);
  });
});
