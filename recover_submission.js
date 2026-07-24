const mongoose = require('mongoose');
const Submission = require('./src/models/Submission');
const Assignment = require('./src/models/assignment.model');
const canonicalCorrectionsPipeline = require('./src/services/canonicalCorrectionsPipeline.service');

require('dotenv').config();

async function recoverSubmission() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB');

    const submissionId = '6a63b7cea4bbf88abda8602d';
    
    const submission = await Submission.findById(submissionId);
    if (!submission) {
      console.log('Submission not found');
      return;
    }

    console.log('=== RECOVERING SUBMISSION ===');
    console.log('ID:', submission._id);
    console.log('Correction Status:', submission.correctionStatus);
    console.log('Semantic Status:', submission.semanticStatus);
    console.log('Evaluation Status:', submission.evaluationStatus);
    console.log('');

    // Only recover if semantic analysis succeeded but evaluation never ran
    if (submission.semanticStatus === 'completed' && !submission.evaluationStatus) {
      console.log('Recovery criteria met: semantic completed, evaluation not run');
      console.log('Triggering evaluation...');

      const assignment = await Assignment.findById(submission.assignment);
      if (!assignment) {
        console.log('Assignment not found');
        return;
      }

      // Trigger the canonical evaluation
      await canonicalCorrectionsPipeline.generateAndPersist(submission, { assignment, force: false });

      console.log('Recovery triggered successfully');
      
      // Check the result
      const refreshed = await Submission.findById(submissionId);
      console.log('=== AFTER RECOVERY ===');
      console.log('Evaluation Status:', refreshed.evaluationStatus);
      console.log('Evaluation Error:', refreshed.evaluationError);
    } else {
      console.log('Submission does not meet recovery criteria');
      console.log('Expected: semanticStatus=completed, evaluationStatus=undefined/null');
      console.log('Actual:', {
        semanticStatus: submission.semanticStatus,
        evaluationStatus: submission.evaluationStatus
      });
    }

    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

recoverSubmission();
