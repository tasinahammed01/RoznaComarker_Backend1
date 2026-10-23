'use strict';
const {resultProgress,preflightProgress}=require('../src/services/submissionProgress.service');
const {buildCanonicalResultState}=require('../src/services/canonicalResultState.service');
const {CANONICAL_TRANSCRIPT_LAYOUT_VERSION}=require('../src/utils/ocrTranscriptNormalizer');
const {ASSESSMENT_VERSION,EVALUATION_VERSION}=require('../src/services/rubricLanguageScoring.service');
test.each([
  [{ocrStatus:'processing'},'source',20],
  [{ocrStatus:'completed',semanticStatus:'processing'},'corrections',50],
  [{ocrStatus:'completed',semanticStatus:'completed',evaluationStatus:'processing'},'evaluation',80],
  [{ocrStatus:'completed',semanticStatus:'completed',evaluationStatus:'completed',detailedFeedbackStatus:'processing'},'feedback',95]
])('durable state projects %s without writes or provider work',(state,stage,percent)=>{
  const input=Object.freeze({...state,processingActive:true,terminal:false});
  expect(resultProgress(input)).toMatchObject({status:'processing',stage,percent,completed:false,active:true});
  expect(resultProgress(input)).toEqual(resultProgress(input));
});
const submission=()=>({ocrStatus:'completed',correctionStatus:'completed',semanticStatus:'completed',correctionSourceHash:'hash',
  correctionTranscriptLayoutVersion:CANONICAL_TRANSCRIPT_LAYOUT_VERSION,evaluationStatus:'completed',evaluationVersion:EVALUATION_VERSION});
const feedback=()=>({evaluationSourceHash:'hash',detailedFeedbackSourceHash:'hash',overallScore:68.3,
  assessmentVersion:ASSESSMENT_VERSION,evaluationVersion:EVALUATION_VERSION,
  detailedFeedback:{status:'completed',sourceHash:'hash',version:'canonical-detailed-feedback-1',areasForImprovement:[],strengths:[],actionSteps:[]}});
test('fresh persisted result is immediately complete on every read, without provider calls',()=>{
  const transport=jest.spyOn(global,'fetch');
  try{for(let i=0;i<3;i++)expect(buildCanonicalResultState({submission:submission(),feedback:feedback()})).toMatchObject({
    processingActive:false,automaticPollingAllowed:false,processingProgress:{status:'completed',percent:100,completed:true,active:false}});
    expect(transport).not.toHaveBeenCalled();
  }finally{transport.mockRestore();}
});
test.each(['source','version','policy'])('stale %s cannot receive the completed fast path',reason=>{
  const s=submission(),f=feedback();let currentSettings=null;
  if(reason==='source')f.evaluationSourceHash='old';
  if(reason==='version')f.evaluationVersion='old';
  if(reason==='policy'){f.evaluationPolicyHash='old';currentSettings={policyHash:'new',rubricHash:'rubric'};}
  const state=buildCanonicalResultState({submission:s,feedback:f,currentSettings});
  expect(state.processingProgress.completed).toBe(false);expect(state.processingProgress.percent).toBeLessThan(100);
  expect(state.processingProgress.active).toBe(false);
});
test('correction failure with a valid score is partial, never a fake 100%',()=>{
  const s={...submission(),correctionStatus:'partial',semanticStatus:'failed',semanticErrorCode:'AI_ATTEMPT_TIMEOUT'};
  expect(buildCanonicalResultState({submission:s,feedback:feedback()})).toMatchObject({score:68.3,statisticsStatus:'failed',
    automaticPollingAllowed:false,processingProgress:{status:'partial',completed:false,active:false,percent:95}});
});
test('source terminal failure stops progress',()=>{
  expect(buildCanonicalResultState({submission:{ocrStatus:'failed',correctionStatus:'failed'}}).processingProgress)
    .toMatchObject({status:'failed',active:false,completed:false,failed:true});
});
test('preflight transitions are server evidence only, with no fake successful failure',()=>{
  expect(preflightProgress({sourceReadStatus:'CHECKING'})).toMatchObject({stage:'source',percent:60,active:true});
  expect(preflightProgress({sourceReadStatus:'PASSED',ready:true,canSubmit:true})).toMatchObject({percent:100,completed:true});
  expect(preflightProgress({ready:true,canSubmit:false,basicChecksPassed:true})).toMatchObject({percent:60,failed:true,completed:false});
  expect(preflightProgress({ready:false,message:'Please replace this image.'})).toMatchObject({failed:true,message:'Please replace this image.'});
});
