'use strict';

const DEFINITIONS = Object.freeze([
  ['FIRST_CLASS', 'CLASSES_CREATED', 1, 'First class created', 'You created your first class.'],
  ['FIRST_ASSIGNMENT', 'ASSIGNMENTS_CREATED', 1, 'First assignment created', 'You created your first assignment.'],
  ['ASSESSMENTS_10', 'SUCCESSFUL_ASSESSMENTS', 10, 'Assessment practice established', "You've completed 10 successful assessments."],
  ['ASSESSMENTS_50', 'SUCCESSFUL_ASSESSMENTS', 50, 'Assessment professional', "You've completed 50 successful assessments."],
  ['ASSESSMENTS_100', 'SUCCESSFUL_ASSESSMENTS', 100, 'Assessment leadership', "You've completed 100 successful assessments."],
  ['FIRST_STUDENT_IMPROVEMENT', 'STUDENT_IMPROVEMENTS', 1, 'Student improvement recognized', 'A student completed an assessed improvement cycle.'],
  ['FIRST_SAVED_RUBRIC', 'SAVED_RUBRICS', 1, 'Reusable rubric created', 'You created your first reusable rubric.'],
  ['FIRST_ADAPTIVE_COMPLETION', 'ADAPTIVE_COMPLETIONS', 1, 'Adaptive learning completed', 'A student completed an Adaptive Learning session.'],
  ['FIRST_QUALIFIED_REFERRAL', 'QUALIFIED_REFERRALS', 1, 'Professional referral qualified', 'Your first teacher referral qualified.'],
  ['ACTIVE_STUDENTS_10', 'ACTIVE_STUDENTS', 10, 'Ten active students taught', 'You are teaching 10 active students.'],
  ['ACTIVE_STUDENTS_25', 'ACTIVE_STUDENTS', 25, 'Twenty-five active students taught', 'You are teaching 25 active students.'],
  ['ACTIVE_STUDENTS_50', 'ACTIVE_STUDENTS', 50, 'Fifty active students taught', 'You are teaching 50 active students.']
].map(([key, metricType, threshold, title, description]) => Object.freeze({ key, metricType, threshold, title, description })));

function milestoneDefinitions(environment = process.env) {
  return DEFINITIONS.map((item) => Object.freeze({ ...item,
    enabled: String(environment[`PROFESSIONAL_MILESTONE_${item.key}_ENABLED`] || '').toLowerCase() === 'true',
    rewardEventKey: item.key }));
}
module.exports = { DEFINITIONS, milestoneDefinitions };
