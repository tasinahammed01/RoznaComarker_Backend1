'use strict';
const { decideRestore, restoreOne } = require('../src/services/policyEvaluationRestore.service');
function fixtureRecords() {
  const { CANONICAL_TRANSCRIPT_LAYOUT_VERSION } = require('../src/utils/ocrTranscriptNormalizer');
  const { ASSESSMENT_VERSION, EVALUATION_VERSION } = require('../src/services/rubricLanguageScoring.service');
  const base = { nextPolicyHash: 'policy-a', currentSettings: { policyHash: 'policy-a', rubricHash: 'rubric-a', hasValidCustomRubric: true },
    submission: { _id: 'fixture-reverted', ocrStatus: 'completed', semanticStatus: 'completed', correctionStatus: 'completed',
      correctionSourceHash: 'source-a', correctionTranscriptLayoutVersion: CANONICAL_TRANSCRIPT_LAYOUT_VERSION,
      evaluationSourceHash: 'source-a', evaluationVersion: EVALUATION_VERSION, evaluationStatus: 'stale',
      evaluationPolicyHash: 'policy-a', evaluationRubricSourceHash: 'rubric-a', assessmentStatus: 'complete' },
    feedback: { evaluationStatus: 'stale', evaluationSourceHash: 'source-a', evaluationPolicyHash: 'policy-a',
      evaluationRubricSourceHash: 'rubric-a', assessmentVersion: ASSESSMENT_VERSION, evaluationVersion: EVALUATION_VERSION,
      detailedFeedbackSourceHash: 'source-a', detailedFeedback: { status: 'completed', strengths: [], areasForImprovement: [], actionSteps: [] } } };
  return [base,
    { ...base, submission: { ...base.submission, _id: 'fixture-override' }, feedback: { ...base.feedback, overriddenByTeacher: true } },
    { ...base, submission: { ...base.submission, _id: 'fixture-rubric' }, feedback: { ...base.feedback, evaluationStaleReason: 'rubric' } },
    { ...base, submission: { ...base.submission, _id: 'fixture-running', assessmentStatus: 'processing' } },
    { ...base, submission: { ...base.submission, _id: 'fixture-different-policy' }, nextPolicyHash: 'policy-b' }];
}
async function runRecords(records, apply = false) {
  const counts = { scanned: 0, eligible: 0, restored: 0, refused: 0 };
  const refusalCounts = {};
  for await (const record of records) {
    const decision = decideRestore({ ...record, allowLegacy: true }); counts.scanned++;
    if (decision.restore) counts.eligible++;
    else { counts.refused++; refusalCounts[decision.reason] = (refusalCounts[decision.reason] || 0) + 1; }
    let applied = false;
    if (apply && decision.restore) applied = (await restoreOne({ ...record, allowLegacy: true })).restore;
    if (applied) counts.restored++;
    console.log(JSON.stringify({ submissionId: String(record.submission._id), ...decision, applied }));
  }
  const summary = { ...counts, refusalCounts };
  console.log(JSON.stringify({ dryRun: !apply, ...summary })); return summary;
}
async function main() {
  const apply = process.argv.includes('--apply');
  if (process.argv.includes('--fixtures')) {
    if (apply) throw new Error('Synthetic fixtures are read-only.');
    return runRecords(fixtureRecords());
  }
  const teacherId = process.argv[process.argv.indexOf('--teacher') + 1];
  if (!process.argv.includes('--teacher') || !/^[a-f\d]{24}$/i.test(teacherId || '')) throw new Error('Usage: --teacher <id> [--apply], or --fixtures');
  require('dotenv').config({ quiet: true });
  const mongoose = require('mongoose');
  try {
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false });
    const User = require('../src/models/user.model'); const Class = require('../src/models/class.model');
    const Submission = require('../src/models/Submission'); const Feedback = require('../src/models/SubmissionFeedback');
    const Assignment = require('../src/models/assignment.model');
    const { currentEvaluationSettings } = require('../src/services/evaluationSettingsContext.service');
    const { evaluationPolicyHash } = require('../src/services/teacherEvaluationPolicy.service');
    const teacher = await User.findOne({ _id: teacherId, role: 'teacher' }).select('aiConfig').lean();
    if (!teacher) throw new Error('Teacher unavailable');
    async function* records() {
      for await (const cls of Class.find({ teacher: teacherId }).select('_id').lean().cursor()) {
        for await (const submission of Submission.find({ class: cls._id, evaluationStatus: 'stale' }).lean().cursor()) {
          const feedback = await Feedback.findOne({ submissionId: submission._id }).lean();
          const assignment = await Assignment.findOne({ _id: submission.assignment, teacher: teacherId }).lean();
          yield { submission, feedback, nextPolicyHash: evaluationPolicyHash(teacher.aiConfig),
            currentSettings: assignment ? await currentEvaluationSettings(assignment) : null };
        }
      }
    }
    await runRecords(records(), apply);
  } finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch(() => { console.error('Policy healing stopped. Verify the scope and connection. No provider calls are made.'); process.exitCode = 1; });
module.exports = { decideRestore, fixtureRecords, runRecords };
