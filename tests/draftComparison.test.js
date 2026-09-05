process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = 'test';
jest.setTimeout(30000);

jest.mock('../src/services/ocrPipeline.service', () => ({ runOcrAndPersist: jest.fn(), runOcrAndPersistForFiles: jest.fn() }));
jest.mock('../src/services/autoRubricDesigner.service', () => ({ autoGenerateRubricDesignerForSubmission: jest.fn() }));

const request = require('supertest');
const app = require('../src/app');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Assignment = require('../src/models/assignment.model');
const Submission = require('../src/models/Submission');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');
const SubmissionRevision = require('../src/models/SubmissionRevision');
const CreditTransaction = require('../src/models/CreditTransaction');
const comparison = require('../src/services/draftComparison.service');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { signTestJwt } = require('./helpers/auth');
const { seedTestPlans } = require('./helpers/seedTestPlans');

const issues = (values) => values.map(([symbol, quotedText, startChar = 0]) => ({ category: 'GRAMMAR', symbol,
  quotedText, suggestedText: `${quotedText}-fixed`, startChar, endChar: startChar + quotedText.length }));
const builtIn = (scores) => Object.fromEntries(Object.entries(scores).map(([key, score]) => [key, { score, maxScore: 20 }]));
const feedback = (score, categories = { CONTENT: 15, GRAMMAR: 14 }) => ({ overallScore: score,
  evaluationStatus: 'completed', rubricScores: builtIn(categories), evaluationRubricSourceHash: 'rubric-1' });
const assessment = ({ id = 'one', chainId = 'chain', assignmentId = 'assignment-a', assignmentTitle = 'Assignment A',
  draftNumber = 1, score = 70, categories, correctionList = [], rubricHash = 'rubric-1', custom, assessedAt, fileContentIdentity } = {}) => ({
  id, chainId, assignmentId, assignmentTitle, draftNumber, assessedAt: assessedAt || new Date(2026, 0, draftNumber), submission: { evaluationStatus: 'completed',
    assessmentStatus: 'complete', writingCorrections: correctionList, evaluationRubricSourceHash: rubricHash, fileContentIdentity },
  feedback: { ...feedback(score, categories), ...(custom ? { customRubricScores: { criteria: custom }, rubricScores: {} } : {}), evaluationRubricSourceHash: rubricHash }
});

describe('deterministic draft comparison', () => {
  test('byte-identical drafts cannot report score or issue improvement caused by reevaluation variance', () => {
    const previous = assessment({ draftNumber: 1, score: 73, fileContentIdentity: 'same-bytes',
      correctionList: issues([['G', 'one'], ['V', 'two']]) });
    const current = assessment({ draftNumber: 2, score: 100, fileContentIdentity: 'same-bytes', correctionList: [] });
    const result = comparison.compareDrafts(previous, current);
    expect(result).toMatchObject({ available: true, identicalContent: true,
      overall: { previousScore: 73, currentScore: 73, delta: 0, status: 'UNCHANGED' },
      issues: { correctedCount: 0, newIssueCount: 0 } });
  });
  test.each([[72, 84, 12, 'IMPROVED'], [80, 80, 0, 'UNCHANGED'], [84, 72, -12, 'DECLINED']])(
    'calculates authoritative overall delta %s -> %s', (oldScore, currentScore, delta, status) => {
      expect(comparison.compareDrafts(assessment({ score: oldScore }), assessment({ draftNumber: 2, score: currentScore })).overall)
        .toEqual({ previousScore: oldScore, currentScore, delta, status });
    });

  test('matches stable criterion IDs despite reordering', () => {
    const previous = assessment({ custom: [
      { criterionId: 'organization', title: 'Organization', weightedPoints: 12, normalizedWeight: 20 },
      { criterionId: 'grammar', title: 'Grammar', weightedPoints: 14, normalizedWeight: 20 }
    ] });
    const current = assessment({ draftNumber: 2, custom: [
      { criterionId: 'grammar', title: 'Grammar', weightedPoints: 17, normalizedWeight: 20 },
      { criterionId: 'organization', title: 'Organization', weightedPoints: 18, normalizedWeight: 20 }
    ] });
    const rows = comparison.compareDrafts(previous, current).rubricCategories;
    expect(rows.find((row) => row.categoryId === 'organization').delta).toBe(6);
    expect(rows.find((row) => row.categoryId === 'grammar').delta).toBe(3);
  });

  test('uses normalized-name fallback only when legitimate', () => {
    const rows = comparison.matchCategories({ customRubricScores: { criteria: [
      { criterionId: 'old', title: 'Evidence & Support', weightedPoints: 12, normalizedWeight: 20 }
    ] } }, { customRubricScores: { criteria: [
      { criterionId: 'new', title: 'Evidence and Support', weightedPoints: 16, normalizedWeight: 20 },
      { criterionId: 'same-name', title: 'Evidence & Support', weightedPoints: 15, normalizedWeight: 20 }
    ] } });
    expect(rows.find((row) => row.available)?.matchStrategy).toBe('normalized_name');
    expect(rows.find((row) => row.available)?.delta).toBe(3);
  });

  test('marks renamed, added, removed, and changed-scale criteria unavailable', () => {
    const previous = assessment({ rubricHash: 'old', custom: [{ criterionId: 'one', title: 'Evidence', weightedPoints: 12, normalizedWeight: 20 }] });
    const current = assessment({ draftNumber: 2, rubricHash: 'new', custom: [{ criterionId: 'one', title: 'Reasoning', weightedPoints: 20, normalizedWeight: 25 }] });
    const result = comparison.compareDrafts(previous, current);
    expect(result.rubricChanged).toBe(true); expect(result.rubricMessage).toContain('partially unavailable');
    expect(result.rubricCategories.every((row) => row.available === false)).toBe(true);
  });

  test('counts corrected, remaining, and new issues as a multiset while ignoring changed offsets', () => {
    const previous = issues([['G', 'was go', 10], ['P', 'however', 30], ['G', 'was go', 50]]);
    const current = issues([['G', 'was go', 400], ['SP', 'recieve', 500]]);
    expect(comparison.compareIssues(previous, current)).toEqual({ previousCount: 3, currentCount: 2,
      correctedCount: 2, remainingCount: 1, newIssueCount: 1 });
  });

  test('returns explicit first/current-pending/previous-pending states', () => {
    const current = assessment({ draftNumber: 2 });
    expect(comparison.compareDrafts(null, current).code).toBe('FIRST_DRAFT');
    expect(comparison.compareDrafts(assessment(), { ...current, submission: { evaluationStatus: 'processing' } }).code).toBe('CURRENT_UNASSESSED');
    expect(comparison.compareDrafts({ ...assessment(), submission: { evaluationStatus: 'pending' } }, current).code).toBe('PREVIOUS_UNASSESSED');
  });

  test('derives one-chain revision metrics, grouped history, corrected aggregate, and strongest category', () => {
    const entries = [assessment({ score: 72, correctionList: issues([['G', 'bad']]) }),
      assessment({ draftNumber: 2, score: 78, correctionList: [], categories: { CONTENT: 17, GRAMMAR: 15 } }),
      assessment({ draftNumber: 3, score: 84, correctionList: [], categories: { CONTENT: 19, GRAMMAR: 17 } })];
    const result = comparison.progressFromHistory(entries);
    expect(result).toMatchObject({ latestAssessedScore: 84, averageRevisionScoreDelta: 6,
      latestDraftImprovement: 6, assessedDraftCount: 3, assignmentsWithRevisions: 1,
      revisionComparisonCount: 2, improvedRevisionCount: 2, unchangedRevisionCount: 0,
      declinedRevisionCount: 0, totalIssuesCorrected: 1 });
    expect(result).not.toHaveProperty('totalScoreImprovement');
    expect(result.draftHistory[0].drafts.map((item) => item.draftNumber)).toEqual([1, 2, 3]);
    expect(result.strongestImprovedCategory.name).toBe('Content');
  });

  test('unrelated first drafts never create a comparison', () => {
    const result = comparison.progressFromHistory([
      assessment({ id: 'a1', chainId: 'a', score: 82, assessedAt: new Date(2026, 0, 1) }),
      assessment({ id: 'b1', chainId: 'b', assignmentId: 'assignment-b', score: 65, assessedAt: new Date(2026, 1, 1) })
    ]);
    expect(result).toMatchObject({ latestAssessedScore: 65, assessedDraftCount: 2, assignmentsWithRevisions: 0,
      revisionComparisonCount: 0, averageRevisionScoreDelta: null, latestDraftImprovement: null, totalIssuesCorrected: 0 });
  });

  test('a newer unrelated first draft remains latest score without becoming a +20 improvement', () => {
    const result = comparison.progressFromHistory([
      assessment({ id: 'a1', chainId: 'a', score: 70, assessedAt: new Date(2026, 0, 1) }),
      assessment({ id: 'a2', chainId: 'a', draftNumber: 2, score: 80, assessedAt: new Date(2026, 0, 2) }),
      assessment({ id: 'b1', chainId: 'b', assignmentId: 'assignment-b', score: 90, assessedAt: new Date(2026, 1, 1) })
    ]);
    expect(result).toMatchObject({ latestAssessedScore: 90, averageRevisionScoreDelta: 10,
      latestDraftImprovement: 10, assignmentsWithRevisions: 1, revisionComparisonCount: 1 });
    expect(result).not.toHaveProperty('totalScoreImprovement');
  });

  test('averages only valid revision deltas across assignments and aggregates valid issue/category changes', () => {
    const result = comparison.progressFromHistory([
      assessment({ id: 'a1', chainId: 'a', score: 70, correctionList: issues([['G', 'bad']]), categories: { CONTENT: 10 }, assessedAt: new Date(2026, 0, 1) }),
      assessment({ id: 'a2', chainId: 'a', draftNumber: 2, score: 80, correctionList: [], categories: { CONTENT: 15 }, assessedAt: new Date(2026, 0, 2) }),
      assessment({ id: 'b1', chainId: 'b', assignmentId: 'assignment-b', assignmentTitle: 'Assignment B', score: 60, correctionList: issues([['G', 'other']]), categories: { CONTENT: 12 }, assessedAt: new Date(2026, 1, 1) }),
      assessment({ id: 'b2', chainId: 'b', assignmentId: 'assignment-b', assignmentTitle: 'Assignment B', draftNumber: 2, score: 65, correctionList: [], categories: { CONTENT: 14 }, assessedAt: new Date(2026, 1, 2) })
    ]);
    expect(result).toMatchObject({ latestAssessedScore: 65, averageRevisionScoreDelta: 7.5,
      latestDraftImprovement: 5, assignmentsWithRevisions: 2, revisionComparisonCount: 2,
      improvedRevisionCount: 2, totalIssuesCorrected: 2 });
    expect(result.strongestImprovedCategory).toEqual({ name: 'Content', delta: 7 });
    expect(result.draftHistory.map((chain) => chain.assignmentTitle)).toEqual(['Assignment A', 'Assignment B']);
  });
});

describe('draft comparison APIs and authorization', () => {
  let teacher; let student; let otherStudent; let classDoc; let assignment; let submission;
  let teacherToken; let studentToken; let otherToken;
  beforeAll(connectInMemoryMongo); afterAll(disconnectInMemoryMongo);
  beforeEach(async () => {
    await clearDatabase(); await seedTestPlans();
    teacher = await User.create({ firebaseUid: 'progress-teacher', email: 'pt@example.com', role: 'teacher' });
    student = await User.create({ firebaseUid: 'progress-student', email: 'ps@example.com', role: 'student' });
    otherStudent = await User.create({ firebaseUid: 'progress-other', email: 'po@example.com', role: 'student' });
    classDoc = await Class.create({ name: 'Progress', teacher: teacher._id, joinCode: `PR${Date.now()}` });
    assignment = await Assignment.create({ title: 'Essay', writingType: 'Opinion', deadline: new Date(Date.now() + 86400000), class: classDoc._id, teacher: teacher._id });
    submission = await Submission.create({ student: student._id, assignment: assignment._id, class: classDoc._id,
      status: 'submitted', submittedAt: new Date(), isLate: false, draftNumber: 2, evaluationStatus: 'completed', assessmentStatus: 'complete',
      assessmentCompletedAt: new Date(), writingCorrections: issues([['G', 'new issue']]), evaluationRubricSourceHash: 'rubric-1' });
    await SubmissionFeedback.create({ submissionId: submission._id, classId: classDoc._id, studentId: student._id, teacherId: teacher._id,
      ...feedback(84, { CONTENT: 18, GRAMMAR: 17 }) });
    await SubmissionRevision.create({ sourceSubmissionId: submission._id, student: student._id, assignment: assignment._id, class: classDoc._id,
      draftNumber: 1, submittedAt: new Date(Date.now() - 86400000), evaluationStatus: 'completed', assessmentStatus: 'complete',
      assessmentCompletedAt: new Date(Date.now() - 80000000), writingCorrections: issues([['G', 'old issue'], ['P', 'however']]),
      evaluationRubricSourceHash: 'rubric-1', feedbackSnapshot: feedback(72, { CONTENT: 14, GRAMMAR: 14 }) });
    teacherToken = signTestJwt({ id: teacher._id, firebaseUid: teacher.firebaseUid, role: 'teacher' });
    studentToken = signTestJwt({ id: student._id, firebaseUid: student.firebaseUid, role: 'student' });
    otherToken = signTestJwt({ id: otherStudent._id, firebaseUid: otherStudent.firebaseUid, role: 'student' });
  });
  const auth = (call, token) => call.set('Authorization', `Bearer ${token}`);

  test('teacher and owner student can compare, foreign student cannot, and no credit transaction is created', async () => {
    const before = await CreditTransaction.countDocuments();
    const submissionBefore = await Submission.findById(submission._id).lean();
    const feedbackBefore = await SubmissionFeedback.findOne({ submissionId: submission._id }).lean();
    const teacherResponse = await auth(request(app).get(`/api/submissions/${submission._id}/draft-comparison`), teacherToken);
    const studentResponse = await auth(request(app).get(`/api/submissions/${submission._id}/draft-comparison`), studentToken);
    const foreignResponse = await auth(request(app).get(`/api/submissions/${submission._id}/draft-comparison`), otherToken);
    expect(teacherResponse.status).toBe(200); expect(teacherResponse.body.data.overall.delta).toBe(12);
    expect(studentResponse.status).toBe(200); expect(foreignResponse.status).toBe(403);
    expect(await CreditTransaction.countDocuments()).toBe(before);
    expect(await Submission.findById(submission._id).lean()).toEqual(submissionBefore);
    expect(await SubmissionFeedback.findOne({ submissionId: submission._id }).lean()).toEqual(feedbackBefore);
  });

  test('progress endpoint returns revision metrics and rejects foreign student access', async () => {
    const own = await auth(request(app).get(`/api/classes/${classDoc._id}/students/${student._id}/progress`), studentToken);
    const teacherView = await auth(request(app).get(`/api/classes/${classDoc._id}/students/${student._id}/progress`), teacherToken);
    const foreign = await auth(request(app).get(`/api/classes/${classDoc._id}/students/${student._id}/progress`), otherToken);
    expect(own.status).toBe(200); expect(teacherView.body.data).toMatchObject({ latestAssessedScore: 84,
      averageRevisionScoreDelta: 12, assignmentsWithRevisions: 1, revisionComparisonCount: 1, assessedDraftCount: 2 });
    expect(teacherView.body.data).not.toHaveProperty('totalScoreImprovement');
    expect(foreign.status).toBe(403);
  });

  test('student comparison and progress respect unreleased marks while teacher access remains available', async () => {
    assignment.showMarksToStudent = false; await assignment.save();
    const hiddenComparison = await auth(request(app).get(`/api/submissions/${submission._id}/draft-comparison`), studentToken);
    const hiddenProgress = await auth(request(app).get(`/api/classes/${classDoc._id}/students/${student._id}/progress`), studentToken);
    const teacherView = await auth(request(app).get(`/api/submissions/${submission._id}/draft-comparison`), teacherToken);
    expect(hiddenComparison.body.data).toMatchObject({ available: false, code: 'MARKS_HIDDEN' });
    expect(hiddenProgress.body.data.assessedDraftCount).toBe(0);
    expect(teacherView.body.data.overall.delta).toBe(12);
  });

  test('class summaries batch multiple students without per-row history queries', async () => {
    const otherSubmission = await Submission.create({ student: otherStudent._id, assignment: assignment._id, class: classDoc._id,
      status: 'submitted', submittedAt: new Date(), isLate: false, evaluationStatus: 'completed', assessmentStatus: 'complete' });
    await SubmissionFeedback.create({ submissionId: otherSubmission._id, classId: classDoc._id, studentId: otherStudent._id,
      teacherId: teacher._id, ...feedback(65) });
    const submissionFind = jest.spyOn(Submission, 'find'); const revisionFind = jest.spyOn(SubmissionRevision, 'find');
    const assignmentFind = jest.spyOn(Assignment, 'find');
    const result = await comparison.classProgressSummaries(classDoc._id);
    expect(result.size).toBe(2); expect(submissionFind).toHaveBeenCalledTimes(1); expect(revisionFind).toHaveBeenCalledTimes(1);
    expect(assignmentFind).toHaveBeenCalledTimes(1);
    submissionFind.mockRestore(); revisionFind.mockRestore(); assignmentFind.mockRestore();
  });
});
