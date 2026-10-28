'use strict';
jest.mock('../src/models/CorrectionLegend',()=>({findOne:jest.fn(()=>({lean:async()=>null}))}));
jest.mock('../src/models/SubmissionFeedback',()=>({updateOne:jest.fn(async()=>({modifiedCount:1}))}));
jest.mock('../src/services/semanticCorrectionCoordinator.service',()=>({...jest.requireActual('../src/services/semanticCorrectionCoordinator.service'),analyze:jest.fn()}));
jest.mock('../src/services/canonicalEvaluation.service',()=>({
  resolveAssessmentPolicy:jest.fn(async doc=>{const p=require('../src/services/teacherEvaluationPolicy.service');const policy=p.normalizeTeacherEvaluationPolicy({strictness:doc.testStrictness||'balanced'});return {policy,policyHash:p.evaluationPolicyHash(policy)};}),
  prepareRubricAssessment:jest.fn(async()=>({semantic:{model:'openai/gpt-6-astra',metrics:{attemptCount:1}}})),
  persistProvisionalScore:jest.fn(async()=>({status:'partial',overallScore:78})),generate:jest.fn(async()=>null)
}));
const coordinator=require('../src/services/semanticCorrectionCoordinator.service'),pipeline=require('../src/services/canonicalCorrectionsPipeline.service');
const {reviewedResult}=require('./helpers/astraAssessmentFixtures.cjs');
const modelName='anthropic/claude-haiku-5.5';
const states=[];
function docFor(i,strictness='balanced'){
  const state={_id:'synthetic-'+i,ocrJobId:'ocr-'+i,testStrictness:strictness,files:['file-'+i],ocrPages:[{fileId:'file-'+i,pageNumber:1,text:'A complete controlled essay '+i+'.'}],writingCorrections:[]};
  const model={updateOne:jest.fn(async(q,u)=>{if(q.semanticStatus?.$nin&&['processing','retry_wait'].includes(state.semanticStatus))return {modifiedCount:0};if(q.correctionJobId&&q.correctionJobId!==state.correctionJobId)return {modifiedCount:0};Object.assign(state,u.$set||{});return {modifiedCount:1};}),findById:jest.fn(async()=>({...state,constructor:model}))};
  states.push(state);return {...state,constructor:model};
}
beforeEach(()=>{process.env.OPENROUTER_API_KEY='mock-only';process.env.CORRECTION_DETECTION_MODEL=modelName;states.length=0;jest.clearAllMocks();
  jest.spyOn(require('../src/utils/logger'),'info').mockImplementation(()=>{});
  coordinator.analyze.mockImplementation(async input=>{await new Promise(r=>setImmediate(r));return {...reviewedResult(input),model:modelName,status:'completed',metrics:{attemptCount:1},coverage:{complete:true}};});
});
afterEach(()=>jest.restoreAllMocks());
test.each([1,10,25,50,75])('%i concurrent submission jobs persist once despite duplicate starts',async n=>{
  const docs=Array.from({length:n},(_,i)=>docFor(i));
  const results=await Promise.all(docs.flatMap(doc=>[pipeline.generateAndPersist(doc),pipeline.generateAndPersist(doc)]));
  expect(results.filter(v=>v.duplicate)).toHaveLength(n);expect(coordinator.analyze).toHaveBeenCalledTimes(n);
  expect(require('../src/services/canonicalEvaluation.service').prepareRubricAssessment).toHaveBeenCalledTimes(n);
  for(const state of states){expect(state).toMatchObject({semanticModel:modelName,semanticStatus:'completed',correctionStatus:'completed'});expect(state.writingCorrections).toEqual([]);expect(state.semanticSourceKey).toEqual(expect.any(String));}
  expect(new Set(states.map(s=>s.semanticSourceKey)).size).toBe(n);
});
test.each(['friendly','balanced','strict'])('%s persists model, prompt and policy identity and reuses accepted result',async strictness=>{
  const doc=docFor(1,strictness);await pipeline.generateAndPersist(doc);
  expect(coordinator.analyze.mock.calls[0][0].policy.strictness).toBe(strictness);
  expect(states[0].semanticPromptVersion).toBe(require('../src/services/semanticWritingCorrections.service').SEMANTIC_PROMPT_VERSION);
  const second=await pipeline.generateAndPersist({...states[0],constructor:doc.constructor});
  expect(second.reused).toBe(true);expect(coordinator.analyze).toHaveBeenCalledTimes(1);
});
test('changed teacher policy invalidates reuse; old model provenance is not relabeled',async()=>{
  const doc=docFor(1);await pipeline.generateAndPersist(doc);const before=states[0].semanticSourceKey;
  await pipeline.generateAndPersist({...states[0],testStrictness:'strict',constructor:doc.constructor});
  expect(states[0].semanticSourceKey).not.toBe(before);expect(coordinator.analyze).toHaveBeenCalledTimes(2);
  const astra=pipeline.buildCorrectionReviewIdentity({model:'openai/gpt-6-astra'}),claude=pipeline.buildCorrectionReviewIdentity({model:modelName});expect(astra).not.toBe(claude);
});
