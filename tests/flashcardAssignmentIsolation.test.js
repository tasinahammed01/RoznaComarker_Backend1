process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = 'test';

jest.mock('../src/services/ocrPipeline.service', () => ({
  runOcrAndPersist: jest.fn(), runOcrAndPersistForFiles: jest.fn()
}));
jest.mock('../src/services/autoRubricDesigner.service', () => ({
  autoGenerateRubricDesignerForSubmission: jest.fn()
}));

const request = require('supertest');
const app = require('../src/app');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Membership = require('../src/models/membership.model');
const Assignment = require('../src/models/assignment.model');
const FlashcardSet = require('../src/models/FlashcardSet');
const FlashcardSubmission = require('../src/models/FlashcardSubmission');
const StudentFlashcardProgress = require('../src/models/StudentFlashcardProgress');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { signTestJwt } = require('./helpers/auth');
const { seedTestPlans } = require('./helpers/seedTestPlans');

describe('flashcard assignment-instance submission isolation', () => {
  beforeAll(connectInMemoryMongo);
  afterAll(disconnectInMemoryMongo);
  beforeEach(async () => { await clearDatabase(); await seedTestPlans(); });

  test('the same student finalizes one shared set under source, copied, and duplicate assignments idempotently', async () => {
    const teacher = await User.create({ firebaseUid: 'fc-owner', email: 'fc-owner@example.com', role: 'teacher' });
    const student = await User.create({ firebaseUid: 'fc-student', email: 'fc-student@example.com', role: 'student' });
    const classes = await Class.insertMany(['Source', 'Copied', 'Duplicate'].map((name, index) => ({
      name, teacher: teacher._id, joinCode: `FCISO${index}`
    })));
    await Membership.insertMany(classes.map((classDoc) => ({ student: student._id, class: classDoc._id })));
    const set = await FlashcardSet.create({ title: 'Shared deck', ownerId: teacher._id,
      cards: [{ front: 'One', back: '1' }, { front: 'Two', back: '2' }] });
    const assignments = await Assignment.insertMany(classes.map((classDoc, index) => ({
      title: `Deck ${index}`, writingType: 'flashcard', resourceType: 'flashcard', resourceId: set._id,
      class: classDoc._id, teacher: teacher._id, qrToken: `fc-iso-${index}`
    })));
    for (const assignment of assignments) {
      await StudentFlashcardProgress.create({ studentId: student._id, flashcardSetId: set._id,
        assignmentId: assignment._id, classId: assignment.class, totalCards: 2,
        cardProgress: set.cards.map((card) => ({ cardId: card._id, selfRating: 'knew' })) });
    }
    const token = signTestJwt({ id: student._id, firebaseUid: student.firebaseUid, role: student.role });

    for (const assignment of assignments) {
      const first = await request(app).post(`/api/assignments/${assignment._id}/submit`)
        .set('Authorization', `Bearer ${token}`).send({ timeTaken: 10 });
      const retry = await request(app).post(`/api/assignments/${assignment._id}/submit`)
        .set('Authorization', `Bearer ${token}`).send({ timeTaken: 10 });
      expect(first.status).toBe(200);
      expect(retry.status).toBe(200);
      expect(retry.body.data._id).toBe(first.body.data._id);
    }

    const submissions = await FlashcardSubmission.find({ userId: student._id }).sort({ assignmentId: 1 }).lean();
    expect(submissions).toHaveLength(3);
    expect(new Set(submissions.map((item) => String(item.assignmentId))).size).toBe(3);
    expect(await StudentFlashcardProgress.countDocuments({ studentId: student._id, flashcardSetId: set._id })).toBe(3);
    expect(submissions.every((item) => item.score === 100 && item.results.length === 2)).toBe(true);
  });

  test('declared indexes separate self-study uniqueness from assignment uniqueness', () => {
    const indexes = FlashcardSubmission.schema.indexes();
    expect(indexes).toEqual(expect.arrayContaining([
      [{ flashcardSetId: 1, userId: 1 }, expect.objectContaining({ unique: true,
        partialFilterExpression: { assignmentId: null } })],
      [{ assignmentId: 1, userId: 1 }, expect.objectContaining({ unique: true,
        partialFilterExpression: { assignmentId: { $type: 'objectId' } } })]
    ]));
  });
});
