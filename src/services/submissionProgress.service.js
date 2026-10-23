'use strict';
// Read-only presentation projection. Never starts work or changes freshness.
const progress=(status,stage,percent,message)=>({status,stage,percent,message,
  completed:status==='completed',failed:status==='failed',active:status==='processing'});
function resultProgress(state={}) {
  if(state.processingActive && !state.terminal) {
    if(['pending','processing'].includes(state.ocrStatus))return progress('processing','source',20,'Checking the submitted handwriting');
    if(['pending','processing','retry_wait'].includes(state.semanticStatus)
      || ['pending','processing'].includes(state.correctionStatus))return progress('processing','corrections',50,'Analyzing writing corrections');
    if(['pending','processing'].includes(state.evaluationStatus))return progress('processing','evaluation',80,'Calculating the score and rubric');
    return progress('processing','feedback',95,'Preparing feedback and saving results');
  }
  if(state.evaluationCurrent && state.detailedFeedbackCurrent && state.statisticsStatus==='complete'
    && state.evaluationStatus==='completed' && state.detailedFeedbackStatus==='completed')
    return progress('completed','completed',100,'Result ready');
  if(state.evaluationCurrent)return progress('partial','partial',95,'Analysis partially completed. Some writing details are unavailable.');
  if(state.terminal || ['failed','blocked','stale'].includes(state.evaluationStatus))
    return progress('failed','failed',state.ocrStatus==='failed'?20:50,
      state.requiresCanonicalReevaluation?'This result needs an updated analysis.':'Analysis could not be completed. See the details below.');
  return progress('processing','preparing',10,'Submission saved. Waiting for analysis');
}
function preflightProgress(result={}) {
  if(result.sourceReadStatus==='CHECKING')return progress('processing','source',60,'Reading handwriting and verifying readability');
  if(result.ready && result.canSubmit!==false && !/^FAILED_/u.test(result.sourceReadStatus||''))return progress('completed','completed',100,'Ready to submit');
  return progress('failed','failed',result.basicChecksPassed?60:25,
    result.message||'Image checks need attention. Review the checks below.');
}
const withPreflightProgress=result=>({...result,processingProgress:preflightProgress(result)});
module.exports={resultProgress,preflightProgress,withPreflightProgress};
