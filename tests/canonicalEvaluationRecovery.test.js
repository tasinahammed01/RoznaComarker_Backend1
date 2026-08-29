describe('canonical evaluation interrupted-finalization recovery', () => {
  test('finalizes matching persisted feedback without regenerating or inserting another record', async () => {
    const sourceHash = 'source-hash';
    const assignment = { title: 'Essay' };
    let service;
    let semanticAssess;
    let feedbackFindOneAndUpdate;
    const submissionUpdateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });

    jest.isolateModules(() => {
      semanticAssess = jest.fn();
      feedbackFindOneAndUpdate = jest.fn();
      jest.doMock('../src/services/semanticRubricAssessment.service', () => ({ assess: semanticAssess }));
      jest.doMock('../src/services/canonicalDetailedFeedback.service', () => ({
        VERSION: 'canonical-detailed-feedback-2',
        validateDetailedFeedback: jest.fn((feedback) => feedback),
        buildDeterministicDetailedFeedback: jest.fn()
      }));
      jest.doMock('../src/models/class.model', () => ({
        findById: jest.fn(() => ({ select: () => ({ lean: jest.fn().mockResolvedValue({ teacher: 'teacher-1' }) }) }))
      }));
      jest.doMock('../src/models/user.model', () => ({
        findById: jest.fn(() => ({ select: () => ({ lean: jest.fn().mockResolvedValue(null) }) }))
      }));
      const policyHash = require('../src/services/teacherEvaluationPolicy.service').evaluationPolicyHash(null);
      jest.doMock('../src/models/SubmissionFeedback', () => ({
        findOne: jest.fn(() => ({ lean: jest.fn().mockResolvedValue({
          submissionId: 'submission-1', evaluationJobId: 'job-1', evaluationSourceHash: sourceHash,
          assessmentVersion: 'writing-rubric-100-v5-teacher-policy', evaluationVersion: 'canonical-evaluation-9-fixed-skill-isolation',
          evaluationRubricSourceHash: require('../src/services/canonicalEvaluation.service').hashRubric(assignment),
          evaluationPolicyHash: policyHash,
          detailedFeedbackSourceHash: sourceHash, detailedFeedbackVersion: 'canonical-detailed-feedback-2',
          detailedFeedback: { sourceHash, areasForImprovement: [], strengths: [], actionSteps: [] },
          rubricScores: Object.fromEntries(['CONTENT', 'ORGANIZATION', 'GRAMMAR', 'VOCABULARY', 'MECHANICS', 'PRESENTATION']
            .map((key) => [key, { score: 1, maxScore: 1 }])), overallScore: 6, overriddenByTeacher: false
        }) })),
        findOneAndUpdate: feedbackFindOneAndUpdate
      }));
      service = require('../src/services/canonicalEvaluation.service');
    });

    const result = await service.generate({ submission: {
      _id: 'submission-1', correctionStatus: 'completed', correctionSourceHash: sourceHash,
      semanticStatus: 'completed', semanticMetrics: { coverage: { coverageComplete: true,
        failedChunks: 0, structuralPassStatus: 'not_required' } },
      evaluationStatus: 'processing', evaluationJobId: 'job-1', writingCorrections: [], correctionStatistics: {},
      constructor: { updateOne: submissionUpdateOne }
    }, assignment });

    expect(result).toMatchObject({ sourceHash, recovered: true, overallScore: 6 });
    expect(submissionUpdateOne).toHaveBeenCalledTimes(1);
    expect(submissionUpdateOne.mock.calls[0][0]).toMatchObject({ correctionSourceHash: sourceHash,
      evaluationStatus: 'processing', evaluationJobId: 'job-1' });
    expect(semanticAssess).not.toHaveBeenCalled();
    expect(feedbackFindOneAndUpdate).not.toHaveBeenCalled();
  });
});
