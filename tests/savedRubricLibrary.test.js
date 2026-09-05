process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = 'test';
jest.setTimeout(30000);

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
const Assignment = require('../src/models/assignment.model');
const SavedRubric = require('../src/models/savedRubric.model');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { signTestJwt } = require('./helpers/auth');
const { seedTestPlans } = require('./helpers/seedTestPlans');

const validRubricData = () => ({
  totalPoints: 100,
  criteria: ['Evidence', 'Organization', 'Language'].map((name) => ({
    name, weight: name === 'Language' ? 34 : 33,
    levels: [
      { title: 'Strong', score: 4, description: `${name} is consistently effective.` },
      { title: 'Developing', score: 2, description: `${name} needs further development.` }
    ]
  }))
});

describe('Saved Rubric Library', () => {
  let teacher; let otherTeacher; let teacherToken; let otherToken; let teacherClass;
  beforeAll(connectInMemoryMongo);
  afterAll(disconnectInMemoryMongo);
  beforeEach(async () => {
    await clearDatabase();
    await seedTestPlans();
    teacher = await User.create({ firebaseUid: 'rubric-owner', email: 'rubric-owner@example.com', role: 'teacher' });
    otherTeacher = await User.create({ firebaseUid: 'rubric-other', email: 'rubric-other@example.com', role: 'teacher' });
    teacherToken = signTestJwt({ id: teacher._id, firebaseUid: teacher.firebaseUid, role: teacher.role });
    otherToken = signTestJwt({ id: otherTeacher._id, firebaseUid: otherTeacher.firebaseUid, role: otherTeacher.role });
    teacherClass = await Class.create({ name: 'Writing', teacher: teacher._id, joinCode: `RUB${Date.now()}` });
  });

  const auth = (call, token = teacherToken) => call.set('Authorization', `Bearer ${token}`);
  async function createOwned(name = 'Argument Writing', data = validRubricData()) {
    const response = await auth(request(app).post('/api/rubrics')).send({ name, description: 'Reusable', writingType: 'Argumentative', rubricData: data });
    expect(response.status).toBe(201);
    return response.body.data;
  }

  test('teacher creates, reads, edits, and lists only owned rubrics', async () => {
    const own = await createOwned();
    await auth(request(app).post('/api/rubrics'), otherToken).send({ name: 'Private', rubricData: validRubricData() });
    const list = await auth(request(app).get('/api/rubrics'));
    expect(list.status).toBe(200);
    expect(list.body.data.map((item) => item.name)).toEqual(['Argument Writing']);
    expect((await auth(request(app).get(`/api/rubrics/${own._id}`))).status).toBe(200);
    const edited = await auth(request(app).patch(`/api/rubrics/${own._id}`)).send({ name: 'Argument Writing v2' });
    expect(edited.status).toBe(200);
    expect(edited.body.data.name).toBe('Argument Writing v2');
  });

  test('foreign read, edit, duplicate, and archive remain indistinguishable from missing records', async () => {
    const other = await auth(request(app).post('/api/rubrics'), otherToken).send({ name: 'Private', rubricData: validRubricData() });
    for (const response of [
      await auth(request(app).get(`/api/rubrics/${other.body.data._id}`)),
      await auth(request(app).patch(`/api/rubrics/${other.body.data._id}`)).send({ name: 'Stolen' }),
      await auth(request(app).post(`/api/rubrics/${other.body.data._id}/duplicate`)),
      await auth(request(app).delete(`/api/rubrics/${other.body.data._id}`))
    ]) expect(response.status).toBe(404);
    expect((await SavedRubric.findById(other.body.data._id).lean()).name).toBe('Private');
  });

  test('save-from-assignment fetches the owned authoritative rubric and ignores browser rubric data', async () => {
    const assignment = await Assignment.create({
      title: 'Source', writingType: 'Argumentative', deadline: new Date(Date.now() + 86400000),
      class: teacherClass._id, teacher: teacher._id, rubrics: validRubricData()
    });
    const response = await auth(request(app).post(`/api/rubrics/from-assignment/${assignment._id}`))
      .send({ name: 'From Assignment', rubricData: { criteria: [] } });
    expect(response.status).toBe(201);
    expect(response.body.data.sourceAssignmentId).toBe(String(assignment._id));
    expect(response.body.data.rubricData.criteria[0].name).toBe('Evidence');
  });

  test('cannot save from a foreign assignment', async () => {
    const otherClass = await Class.create({ name: 'Other', teacher: otherTeacher._id, joinCode: `OTH${Date.now()}` });
    const assignment = await Assignment.create({ title: 'Foreign', writingType: 'Opinion',
      deadline: new Date(Date.now() + 86400000), class: otherClass._id, teacher: otherTeacher._id, rubrics: validRubricData() });
    const response = await auth(request(app).post(`/api/rubrics/from-assignment/${assignment._id}`)).send({ name: 'No' });
    expect(response.status).toBe(404);
    expect(await SavedRubric.countDocuments({ teacher: teacher._id })).toBe(0);
  });

  test('normalizes the supported legacy rubric designer format from an assignment', async () => {
    const current = validRubricData();
    const legacy = {
      title: 'Legacy', totalPoints: 100,
      levels: [{ title: 'Strong', maxPoints: 4 }, { title: 'Developing', maxPoints: 2 }],
      criteria: current.criteria.map((row) => ({ title: row.name, weight: row.weight, cells: row.levels.map((level) => level.description) }))
    };
    const assignment = await Assignment.create({ title: 'Legacy source', writingType: 'Narrative',
      deadline: new Date(Date.now() + 86400000), class: teacherClass._id, teacher: teacher._id, rubric: JSON.stringify(legacy) });
    const response = await auth(request(app).post(`/api/rubrics/from-assignment/${assignment._id}`)).send({ name: 'Legacy normalized' });
    expect(response.status).toBe(201);
    expect(response.body.data.rubricData.criteria[0]).toMatchObject({ name: 'Evidence', weight: 33 });
    expect(response.body.data.rubricData.criteria[0].levels[0]).toMatchObject({ title: 'Strong', score: 4 });
  });

  test('duplicate deep-copies nested rubric data and leaves the source unchanged', async () => {
    const source = await createOwned();
    const duplicated = await auth(request(app).post(`/api/rubrics/${source._id}/duplicate`));
    expect(duplicated.status).toBe(201);
    expect(duplicated.body.data._id).not.toBe(source._id);
    expect(duplicated.body.data.name).toBe('Argument Writing - Copy');
    const changed = structuredClone(duplicated.body.data.rubricData);
    changed.criteria[0].levels[0].description = 'Changed only in copy';
    await auth(request(app).patch(`/api/rubrics/${duplicated.body.data._id}`)).send({ rubricData: changed });
    expect((await SavedRubric.findById(source._id).lean()).rubricData.criteria[0].levels[0].description)
      .toBe('Evidence is consistently effective.');
  });

  test('archive hides a rubric without affecting an assignment snapshot', async () => {
    const saved = await createOwned();
    const snapshot = structuredClone(saved.rubricData);
    const assignment = await Assignment.create({ title: 'Snapshot', writingType: 'Argumentative',
      deadline: new Date(Date.now() + 86400000), class: teacherClass._id, teacher: teacher._id, rubrics: snapshot });
    await auth(request(app).patch(`/api/rubrics/${saved._id}`)).send({ rubricData: {
      ...snapshot, criteria: snapshot.criteria.map((row, i) => i ? row : { ...row, name: 'Changed template' })
    } });
    expect((await Assignment.findById(assignment._id).lean()).rubrics.criteria[0].name).toBe('Evidence');
    expect((await auth(request(app).delete(`/api/rubrics/${saved._id}`))).status).toBe(200);
    expect((await auth(request(app).get('/api/rubrics'))).body.data).toHaveLength(0);
    expect((await auth(request(app).get('/api/rubrics?includeArchived=true'))).body.data).toHaveLength(1);
    expect((await Assignment.findById(assignment._id).lean()).rubrics.criteria[0].name).toBe('Evidence');
  });

  test('validation enforces metadata, rubric structure, levels, weights, and totals', async () => {
    expect((await auth(request(app).post('/api/rubrics')).send({ name: ' ', rubricData: validRubricData() })).status).toBe(400);
    const invalid = validRubricData(); invalid.criteria[0].weight = 10; invalid.criteria[0].levels[0].description = '';
    const response = await auth(request(app).post('/api/rubrics')).send({ name: 'Invalid', rubricData: invalid });
    expect(response.status).toBe(400);
    expect(response.body.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('description'), expect.stringContaining('total 100')
    ]));
  });

  test('all library routes require authentication and the teacher role', async () => {
    expect((await request(app).get('/api/rubrics')).status).toBe(401);
    const student = await User.create({ firebaseUid: 'rubric-student', email: 'rubric-student@example.com', role: 'student' });
    const studentToken = signTestJwt({ id: student._id, firebaseUid: student.firebaseUid, role: student.role });
    expect((await auth(request(app).get('/api/rubrics'), studentToken)).status).toBe(403);
    expect((await auth(request(app).post('/api/rubrics'), studentToken).send({ name: 'No', rubricData: validRubricData() })).status).toBe(403);
  });
});
