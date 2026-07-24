const mongoose = require('mongoose');
const Submission = require('./src/models/Submission');
const SubmissionFeedback = require('./src/models/SubmissionFeedback');

require('dotenv').config();

async function checkSubmission() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB');

    const submissionId = '6a63b7cea4bbf88abda8602d';
    
    const submission = await Submission.findById(submissionId).lean();
    if (!submission) {
      console.log('Submission not found');
      return;
    }

    console.log('=== SUBMISSION STATE ===');
    console.log('ID:', submission._id);
    console.log('OCR Status:', submission.ocrStatus);
    console.log('OCR Job ID:', submission.ocrJobId);
    console.log('OCR Updated At:', submission.ocrUpdatedAt);
    console.log('OCR Error:', submission.ocrError);
    console.log('');
    console.log('Has OCR Pages:', Array.isArray(submission.ocrPages) ? submission.ocrPages.length : 0);
    console.log('Combined OCR Text Length:', submission.combinedOcrText?.length || 0);
    console.log('Transcript Text Length:', submission.transcriptText?.length || 0);
    console.log('');
    console.log('=== CORRECTION STATE ===');
    console.log('Correction Status:', submission.correctionStatus);
    console.log('Correction Job ID:', submission.correctionJobId);
    console.log('Correction Source Hash:', submission.correctionSourceHash);
    console.log('Correction Version:', submission.correctionVersion);
    console.log('Correction Error:', submission.correctionError);
    console.log('Correction Updated At:', submission.correctionUpdatedAt);
    console.log('Writing Corrections Count:', Array.isArray(submission.writingCorrections) ? submission.writingCorrections.length : 0);
    console.log('Correction Statistics:', JSON.stringify(submission.correctionStatistics, null, 2));
    console.log('');
    console.log('=== LANGUAGETOOL STATE ===');
    console.log('LanguageTool Status:', submission.languageToolStatus);
    console.log('LanguageTool Source Hash:', submission.languageToolSourceHash);
    console.log('LanguageTool Version:', submission.languageToolVersion);
    console.log('');
    console.log('=== SEMANTIC STATE ===');
    console.log('Semantic Status:', submission.semanticStatus);
    console.log('Semantic Attempt:', submission.semanticAttempt);
    console.log('Semantic Max Attempts:', submission.semanticMaxAttempts);
    console.log('Semantic Next Retry At:', submission.semanticNextRetryAt);
    console.log('Semantic Error Code:', submission.semanticErrorCode);
    console.log('Semantic Source Key:', submission.semanticSourceKey);
    console.log('Semantic Provider:', submission.semanticProvider);
    console.log('Semantic Model:', submission.semanticModel);
    console.log('Semantic Prompt Version:', submission.semanticPromptVersion);
    console.log('Semantic Metrics:', JSON.stringify(submission.semanticMetrics, null, 2));
    console.log('');
    console.log('=== EVALUATION STATE ===');
    console.log('Evaluation Status:', submission.evaluationStatus);
    console.log('Evaluation Job ID:', submission.evaluationJobId);
    console.log('Evaluation Source Hash:', submission.evaluationSourceHash);
    console.log('Evaluation Version:', submission.evaluationVersion);
    console.log('Evaluation Rubric Source Hash:', submission.evaluationRubricSourceHash);
    console.log('Evaluation Error:', submission.evaluationError);
    console.log('Evaluation Updated At:', submission.evaluationUpdatedAt);
    console.log('');

    const feedback = await SubmissionFeedback.findOne({ submissionId }).lean();
    if (feedback) {
      console.log('=== FEEDBACK STATE ===');
      console.log('Feedback ID:', feedback._id);
      console.log('Evaluation Source Hash:', feedback.evaluationSourceHash);
      console.log('Evaluation Status:', feedback.evaluationStatus);
      console.log('Evaluation Source:', feedback.evaluationSource);
      console.log('Evaluation Provider:', feedback.evaluationProvider);
      console.log('Evaluation Model:', feedback.evaluationModel);
      console.log('Evaluation Error Code:', feedback.evaluationErrorCode);
      console.log('Overall Score:', feedback.overallScore);
      console.log('Grade:', feedback.grade);
      console.log('Rubric Scores:', JSON.stringify(feedback.rubricScores, null, 2));
      console.log('Detailed Feedback Status:', feedback.detailedFeedback?.status);
      console.log('Overridden By Teacher:', feedback.overriddenByTeacher);
      console.log('');
    } else {
      console.log('=== FEEDBACK STATE ===');
      console.log('No feedback document found');
      console.log('');
    }

    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

checkSubmission();
