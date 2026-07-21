'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const Submission = require('../src/models/Submission');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const submissions = await Submission.find({ correctionStatus: { $in: ['completed', 'partial'] } })
    .sort({ updatedAt: -1 })
    .limit(12)
    .select('_id correctionStatus correctionSourceHash correctionVersion evaluationStatus evaluationVersion writingCorrections semanticStatus')
    .lean();

  for (const submission of submissions) {
    const feedback = await SubmissionFeedback.findOne({ submissionId: submission._id })
      .select('evaluationSourceHash evaluationVersion detailedFeedbackSourceHash detailedFeedbackVersion detailedFeedback overriddenByTeacher')
      .lean();
    const detailed = feedback?.detailedFeedback || {};
    const areas = Array.isArray(detailed.areasForImprovement) ? detailed.areasForImprovement : [];
    const strengths = Array.isArray(detailed.strengths) ? detailed.strengths : [];
    const actionSteps = Array.isArray(detailed.actionSteps) ? detailed.actionSteps : [];
    const representativeExampleCount = areas.reduce(
      (count, area) => count + (Array.isArray(area?.examples) ? area.examples.length : 0), 0
    );
    console.log(JSON.stringify({
      submissionId: String(submission._id),
      correctionStatus: submission.correctionStatus,
      semanticStatus: submission.semanticStatus || null,
      correctionSourceHashPresent: Boolean(submission.correctionSourceHash),
      correctionVersion: submission.correctionVersion || null,
      correctionCount: Array.isArray(submission.writingCorrections) ? submission.writingCorrections.length : 0,
      evaluationStatus: submission.evaluationStatus || null,
      evaluationSourceHashPresent: Boolean(feedback?.evaluationSourceHash),
      evaluationVersion: feedback?.evaluationVersion || submission.evaluationVersion || null,
      detailedFeedbackPresent: Boolean(feedback?.detailedFeedback),
      detailedFeedbackSourceHashPresent: Boolean(feedback?.detailedFeedbackSourceHash),
      detailedFeedbackVersion: feedback?.detailedFeedbackVersion || null,
      teacherOverride: Boolean(feedback?.overriddenByTeacher),
      evaluationHashMatches: Boolean(submission.correctionSourceHash && feedback?.evaluationSourceHash === submission.correctionSourceHash),
      detailedHashMatches: Boolean(submission.correctionSourceHash && feedback?.detailedFeedbackSourceHash === submission.correctionSourceHash),
      areasCount: areas.length,
      strengthsCount: strengths.length,
      actionStepCount: actionSteps.length,
      representativeExampleCount
      ,areaValueTypes: [...new Set(areas.map((area) => typeof area))],
      strengthValueTypes: [...new Set(strengths.map((strength) => typeof strength))],
      actionStepValueTypes: [...new Set(actionSteps.map((step) => typeof step))],
      correctionIdFieldCounts: (submission.writingCorrections || []).reduce((counts, correction) => ({
        id: counts.id + Number(Boolean(correction?.id)),
        underscoreId: counts.underscoreId + Number(Boolean(correction?._id)),
        quotedText: counts.quotedText + Number(Boolean(correction?.quotedText)),
        symbol: counts.symbol + Number(Boolean(correction?.symbol))
      }), { id: 0, underscoreId: 0, quotedText: 0, symbol: 0 })
    }));
  }
}

main()
  .catch((error) => {
    console.error('SAFE_INSPECTION_FAILED', error?.name || 'Error', error?.message || 'Unknown error');
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
