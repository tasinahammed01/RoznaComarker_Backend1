'use strict';
jest.mock('../src/services/semanticRubricAssessment.service',()=>({assess:jest.fn()}));
const rubric=require('../src/services/semanticRubricAssessment.service');
const evaluation=require('../src/services/canonicalEvaluation.service');
const corrections=require('../src/services/canonicalCorrectionsPipeline.service');
const {buildCanonicalResultState}=require('../src/services/canonicalResultState.service');
const {buildSubmissionFeedbackReportViewModel}=require('../src/pdf/sample/submissionFeedbackReportViewModel');
test('direct correction, rubric and final-score entry points fail closed even with a stale teacher score',async()=>{
  const submission={_id:'a',sourceFidelityMode:'astra_verified',sourceFidelityStatus:'OCR_UNCERTAIN',ocrPages:[]};
  expect(await corrections.generateAndPersist(submission)).toMatchObject({errorCode:'OCR_SOURCE_REVIEW_REQUIRED'});
  await expect(evaluation.prepareRubricAssessment({submission})).rejects.toMatchObject({code:'OCR_SOURCE_REVIEW_REQUIRED'});
  expect(await evaluation.generate({submission})).toMatchObject({status:'blocked'});
  expect(rubric.assess).not.toHaveBeenCalled();
  expect(buildCanonicalResultState({submission,feedback:{overriddenByTeacher:true,overallScore:100}})).toMatchObject({score:null,evaluationCurrent:false,terminal:true,automaticPollingAllowed:false});
});
test('PDF view model retains exact source characters without false human verification',()=>{
  const text='  sence \nSocial ,free\n';
  const vm=buildSubmissionFeedbackReportViewModel({submission:{_id:'a',files:['f'],canonicalText:text,writingCorrections:[],
    transcriptPages:[{fileId:'f',pageNumber:1,text,startChar:0,endChar:text.length,words:[]}]},
    canonicalTranscript:{text,pages:[{fileId:'f',pageNumber:1,text,startChar:0,endChar:text.length,words:[]}]},evaluation:{},feedback:{}});
  expect(vm.submittedPages[0].transcriptText).toBe(text);
  expect(vm.submittedPages[0].transcript.text).toBe(text);
  expect(JSON.stringify(vm)).not.toContain('VERIFIED_SOURCE');
});
