'use strict';
// speaking (audio + speech-to-text): no essay writing controls or rubric yet, no resubmission (a recording is replaced before marking
// instead), marks hidden until the marking stage exists. Every other value is unchanged.
function assignmentType(value){return value?.resourceType==='flashcard'?'flashcard':value?.resourceType==='worksheet'?'worksheet':value?.resourceType==='speaking'?'speaking':'essay';}
function assignmentCapabilities(value){const type=assignmentType(value),writing=type==='essay';return{type,deadline:true,instructions:true,showMarksToStudent:writing,allowLateResubmission:type==='worksheet',allowResubmission:writing,requireAdaptiveBeforeResubmission:writing,rubric:writing,writingControls:writing};}
function normalizeUnsupportedWritingFlags(target){if(assignmentType(target)!=='essay'){target.allowResubmission=false;target.requireAdaptiveBeforeResubmission=false;}return target;}
module.exports={assignmentType,assignmentCapabilities,normalizeUnsupportedWritingFlags};
