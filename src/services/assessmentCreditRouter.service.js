const Assignment = require('../models/assignment.model');
const Class = require('../models/class.model');
const PersonalCredits = require('./credit.service');
const InstitutionCredits = require('./institutionCredit.service');

async function resolve({ teacherUserId, submissionId, assignmentId }) {
  const assignment = await Assignment.findById(assignmentId).select('_id teacher class').lean();
  if (!assignment || String(assignment.teacher) !== String(teacherUserId)) {
    throw Object.assign(new Error('Assessment ownership context is invalid.'), { code: 'ASSESSMENT_CONTEXT_INVALID', statusCode: 403 });
  }
  const classDoc = await Class.findById(assignment.class).select('_id teacher institutionId').lean();
  if (!classDoc || String(classDoc.teacher) !== String(teacherUserId)) {
    throw Object.assign(new Error('Assessment class context is invalid.'), { code: 'ASSESSMENT_CONTEXT_INVALID', statusCode: 403 });
  }
  return { submissionId, assignment, classDoc };
}

async function canRunAssessment({ teacherUserId, submissionId, assignmentId, user }) {
  const ctx = await resolve({ teacherUserId, submissionId, assignmentId });
  if (!ctx.classDoc.institutionId) return PersonalCredits.canRunAssessment(user || teacherUserId);
  return InstitutionCredits.canRunAssessment({ institutionId: ctx.classDoc.institutionId, teacherUserId });
}

async function consumeAssessmentCredit({ teacherUserId, submissionId, assignmentId, assessmentId, reason }) {
  const ctx = await resolve({ teacherUserId, submissionId, assignmentId });
  if (!ctx.classDoc.institutionId) return PersonalCredits.consumeAssessmentCredit({ userId: teacherUserId,
    submissionId, assignmentId, assessmentId, reason });
  return InstitutionCredits.consumeAssessmentCredit({ institutionId: ctx.classDoc.institutionId, teacherUserId,
    classId: ctx.classDoc._id, submissionId, assignmentId, assessmentId, reason });
}

module.exports = { resolve, canRunAssessment, consumeAssessmentCredit };
