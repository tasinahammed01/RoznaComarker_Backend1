process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = 'test';

const mockCompleteRubric = jest.fn().mockResolvedValue({
  title: 'Rubric: Draft Essay', totalPoints: 100,
  levels: [{ title: 'Strong', maxPoints: 100 }, { title: 'Developing', maxPoints: 70 }, { title: 'Beginning', maxPoints: 40 }],
  criteria: [{ title: 'Evidence', weight: 34, cells: ['A', 'B', 'C'] },
    { title: 'Organization', weight: 33, cells: ['A', 'B', 'C'] },
    { title: 'Language', weight: 33, cells: ['A', 'B', 'C'] }]
});
jest.mock('../src/services/rubricCompletion.service', () => ({ completeRubric: mockCompleteRubric }));
jest.mock('../src/services/ocrPipeline.service', () => ({ runOcrAndPersist: jest.fn(), runOcrAndPersistForFiles: jest.fn() }));
jest.mock('../src/services/autoRubricDesigner.service', () => ({ autoGenerateRubricDesignerForSubmission: jest.fn() }));

const request = require('supertest');
const app = require('../src/app');
const User = require('../src/models/user.model');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { signTestJwt } = require('./helpers/auth');

describe('unsaved assignment rubric generation', () => {
  beforeAll(connectInMemoryMongo);
  afterAll(disconnectInMemoryMongo);
  beforeEach(async () => { await clearDatabase(); await seedTestPlans(); mockCompleteRubric.mockClear(); });

  test('generates exactly once from safe draft context without creating an assignment', async () => {
    const teacher = await User.create({ firebaseUid: 'draft-rubric-teacher', email: 'draft-rubric@example.com', role: 'teacher' });
    const token = signTestJwt({ id: teacher._id, firebaseUid: teacher.firebaseUid, role: teacher.role });
    const response = await request(app).post('/api/assignments/generate-rubric-prompt')
      .set('Authorization', `Bearer ${token}`).send({ prompt: 'Assess evidence', title: 'Draft Essay',
        writingType: 'Argumentative', instructions: 'Use sources.' });
    expect(response.status).toBe(200);
    expect(response.body.data.title).toBe('Rubric: Draft Essay');
    expect(mockCompleteRubric).toHaveBeenCalledTimes(1);
    expect(mockCompleteRubric).toHaveBeenCalledWith(expect.objectContaining({ caller: 'assignment_draft_rubric_request' }));
  });

  test('rejects an empty prompt without invoking AI', async () => {
    const teacher = await User.create({ firebaseUid: 'draft-rubric-empty', email: 'draft-rubric-empty@example.com', role: 'teacher' });
    const token = signTestJwt({ id: teacher._id, firebaseUid: teacher.firebaseUid, role: teacher.role });
    const response = await request(app).post('/api/assignments/generate-rubric-prompt')
      .set('Authorization', `Bearer ${token}`).send({ prompt: '' });
    expect(response.status).toBe(400);
    expect(mockCompleteRubric).not.toHaveBeenCalled();
  });
});
