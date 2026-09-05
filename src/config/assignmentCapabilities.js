'use strict';
function assignmentType(value){return value?.resourceType==='flashcard'?'flashcard':value?.resourceType==='worksheet'?'worksheet':'essay';}
function assignmentCapabilities(value){const type=assignmentType(value),writing=type==='essay';return{type,deadline:true,instructions:true,showMarksToStudent:writing,allowLateResubmission:type==='worksheet',allowResubmission:writing,requireAdaptiveBeforeResubmission:writing,rubric:writing,writingControls:writing};}
function normalizeUnsupportedWritingFlags(target){if(assignmentType(target)!=='essay'){target.allowResubmission=false;target.requireAdaptiveBeforeResubmission=false;}return target;}
module.exports={assignmentType,assignmentCapabilities,normalizeUnsupportedWritingFlags};
