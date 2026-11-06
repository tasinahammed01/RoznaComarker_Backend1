'use strict';
// Read-only counts for planning the grade check (Task 7B). Numbers only: no student data, no identifiers, no writes. Safe to run on
// production at any time and any number of times.
//   npm run report:score-review
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');

const MAX_TIME_MS = 120000;

/** Counts on the connected mongoose instance. */
async function countScoreReviewState() {
  const Submission = require('../src/models/Submission');
  const SubmissionFeedback = require('../src/models/SubmissionFeedback');
  const count = (Model, filter) => Model.countDocuments(filter).maxTimeMS(MAX_TIME_MS);
  return {
    submissionsWithFlagOn: await count(Submission, { 'teacherAnnotations.scoringReviewRequired': true }),
    // Stored before Task 7B: these read as "needed" until a teacher decides (they are never bulk-cleared).
    submissionsWithFlagOnAndNoDraftNumber: await count(Submission, { 'teacherAnnotations.scoringReviewRequired': true, 'teacherAnnotations.scoringReview.requiredDraftNumber': null }),
    feedbackOverriddenByTeacher: await count(SubmissionFeedback, { overriddenByTeacher: true }),
    feedbackUsingCustomRubric: await count(SubmissionFeedback, { 'customRubricScores.criteria.0': { $exists: true } }),
  };
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  try {
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false });
    console.log(JSON.stringify(await countScoreReviewState(), null, 2));
  } finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch(error => { console.error(`Score review count failed: ${error.name}`); process.exitCode = 1; });
module.exports = { main, countScoreReviewState };
