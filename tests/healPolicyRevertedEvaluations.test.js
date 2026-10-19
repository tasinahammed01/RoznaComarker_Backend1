const { decideRestore, fixtureRecords } = require('../scripts/healPolicyRevertedEvaluations');
test('dry-run reports refusal counts and never invokes restoration writes', async () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const summary = await require('../scripts/healPolicyRevertedEvaluations').runRecords(fixtureRecords());
    expect(summary).toEqual({ scanned: 5, eligible: 1, restored: 0, refused: 4, refusalCounts: {
      teacher_override: 1, rubric_stale: 1, assessment_or_resubmission_in_progress: 1, different_policy: 1
    } });
    expect(JSON.parse(log.mock.calls.at(-1)[0])).toEqual({ dryRun: true, ...summary });
  } finally { log.mockRestore(); }
});
test('healing preserves override, rubric, running-job and different-policy refusal rules', () => {
  expect(fixtureRecords().map(record => decideRestore({ ...record, allowLegacy: true }).restore)).toEqual([true, false, false, false, false]);
});
test('runtime restoration requires recorded policy provenance; healing also requires current canonical evidence', () => {
  const record = fixtureRecords()[0];
  expect(decideRestore(record).restore).toBe(false);
  record.feedback.evaluationStaleReason = 'policy'; record.feedback.evaluationStatusBeforeStale = 'partial';
  expect(decideRestore(record)).toMatchObject({ restore: true, status: 'partial' });
  record.feedback.evaluationRubricSourceHash = 'changed';
  expect(decideRestore(record).restore).toBe(false);
});
test.each(['source', 'version', 'detailed-source', 'detailed-shape', 'missing-proof'])('dry-run refuses %s mismatch without evaluating or charging', condition => {
  const record = fixtureRecords()[0];
  if (condition === 'source') record.feedback.evaluationSourceHash = 'other-source';
  if (condition === 'version') record.submission.evaluationVersion = 'old-version';
  if (condition === 'detailed-source') record.feedback.detailedFeedbackSourceHash = 'other-source';
  if (condition === 'detailed-shape') record.feedback.detailedFeedback = { status: 'completed' };
  if (condition === 'missing-proof') record.feedback.evaluationPolicyHash = undefined;
  expect(decideRestore({ ...record, allowLegacy: true }).restore).toBe(false);
});
