jest.mock('../src/models/Submission', () => ({ findById: jest.fn(), updateOne: jest.fn() }));
jest.mock('../src/models/SubmissionFeedback', () => ({ exists: jest.fn() }));
jest.mock('../src/services/upload.service', () => ({ assertTeacherOwnsClassOrThrow: jest.fn() }));
jest.mock('../src/services/assessmentRecovery.service', () => ({ scheduleSubmissionAnalysis: jest.fn() }));
const Submission = require('../src/models/Submission');
const Feedback = require('../src/models/SubmissionFeedback');
const dispatch = require('../src/services/assessmentRecovery.service').scheduleSubmissionAnalysis;
const { regenerateCanonicalCorrections } = require('../src/controllers/submission.controller');
beforeEach(() => { jest.clearAllMocks(); Feedback.exists.mockResolvedValue(false); });
test('only explicit teacher regeneration schedules re-OCR of a flagged legacy source', async () => {
  Submission.findById.mockResolvedValue({ _id: 'submission', class: 'class', ocrJobId: 'old-job', ocrCoordinateSpaceReviewRequired: true });
  Submission.updateOne.mockResolvedValue({ modifiedCount: 1 });
  let body;
  const res = { status: jest.fn().mockReturnThis(), json: value => { body = value; return res; } };
  await regenerateCanonicalCorrections({ params: { submissionId: 'submission' }, user: { _id: 'fixture-teacher', role: 'teacher' } }, res);
  expect(res.status).toHaveBeenCalledWith(202); expect(body.data.sourceReocrRequested).toBe(true);
  expect(dispatch).toHaveBeenCalledTimes(1);
  const update = Submission.updateOne.mock.calls[0];
  expect(update[0]).toMatchObject({ ocrJobId: 'old-job', ocrCoordinateSpaceReviewRequired: true });
  expect(update[1].$set).toMatchObject({ ocrStatus: 'pending', assessmentStatus: 'started' });
  expect(update[1].$set.ocrPages).toBeUndefined(); // Original persisted evidence retained until replacement succeeds.
});
test('a concurrent source job cannot be reset or scheduled a second time', async () => {
  Submission.findById.mockResolvedValue({ _id: 'submission', ocrCoordinateSpaceReviewRequired: true });
  Submission.updateOne.mockResolvedValue({ modifiedCount: 0 });
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await regenerateCanonicalCorrections({ params: { submissionId: 'submission' }, user: { _id: 'fixture-teacher', role: 'teacher' } }, res);
  expect(res.status).toHaveBeenCalledWith(409); expect(dispatch).not.toHaveBeenCalled();
});
