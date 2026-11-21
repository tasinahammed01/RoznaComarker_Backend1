'use strict';
// speaking (audio + speech-to-text): no essay writing controls or essay rubric editor (its rubric is a saved rubric), no resubmission (a
// recording is replaced before marking instead); its results have marks, so the teacher can show or hide them. Every other value is unchanged.
function assignmentType(value){return value?.resourceType==='flashcard'?'flashcard':value?.resourceType==='worksheet'?'worksheet':value?.resourceType==='speaking'?'speaking':'essay';}
function assignmentCapabilities(value){const type=assignmentType(value),writing=type==='essay';return{type,deadline:true,instructions:true,showMarksToStudent:writing||type==='speaking',allowLateResubmission:type==='worksheet',allowResubmission:writing,requireAdaptiveBeforeResubmission:writing,rubric:writing,writingControls:writing};}
function normalizeUnsupportedWritingFlags(target){if(assignmentType(target)!=='essay'){target.allowResubmission=false;target.requireAdaptiveBeforeResubmission=false;}return target;}
module.exports={assignmentType,assignmentCapabilities,normalizeUnsupportedWritingFlags};
