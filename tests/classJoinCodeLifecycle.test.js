process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.FRONTEND_URL = 'https://frontend.example.test';

jest.mock('../src/utils/joinCode', () => {
  const actual = jest.requireActual('../src/utils/joinCode');
  return { ...actual, generateShortJoinCode: jest.fn() };
});

jest.mock('qrcode', () => ({ toDataURL: jest.fn(async () => 'data:image/png;base64,test') }));

const request = require('supertest');
const QRCode = require('qrcode');

const Class = require('../src/models/class.model');
const Membership = require('../src/models/membership.model');
const User = require('../src/models/user.model');
const { generateShortJoinCode } = require('../src/utils/joinCode');
const app = require('../src/app');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { signTestJwt } = require('./helpers/auth');
const { seedTestPlans } = require('./helpers/seedTestPlans');

async function createUser(role, suffix) {
  const user = await User.create({
    firebaseUid: `${role}-${suffix}`,
    email: `${role}-${suffix}@example.test`,
    role
  });
  return {
    user,
    token: signTestJwt({ id: user._id, firebaseUid: user.firebaseUid, role })
  };
}

describe('class join-code lifecycle', () => {
  beforeAll(async () => {
    await connectInMemoryMongo();
    await seedTestPlans();
    await Class.init();
  });

  afterAll(async () => {
    await disconnectInMemoryMongo();
  });

  beforeEach(async () => {
    await clearDatabase();
    await seedTestPlans();
    generateShortJoinCode.mockReset();
    QRCode.toDataURL.mockClear();
  });

  test('new classes receive distinct seven-character codes and the QR share URL contains that code', async () => {
    const { token } = await createUser('teacher', 'new-codes');
    generateShortJoinCode.mockReturnValueOnce('586WT88').mockReturnValueOnce('A7K92Q4');

    const first = await request(app).post('/api/classes')
      .set('Authorization', `Bearer ${token}`).send({ name: 'Class One' });
    const second = await request(app).post('/api/classes')
      .set('Authorization', `Bearer ${token}`).send({ name: 'Class Two' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.data.joinCode).toMatch(/^[A-Z0-9]{7}$/);
    expect(second.body.data.joinCode).toMatch(/^[A-Z0-9]{7}$/);
    expect(first.body.data.joinCode).not.toBe(second.body.data.joinCode);
    expect(QRCode.toDataURL).toHaveBeenNthCalledWith(
      1,
      'https://frontend.example.test/student/join-class?joinCode=586WT88'
    );
  });

  test('retries a unique-index collision and persists only the regenerated code', async () => {
    const { user, token } = await createUser('teacher', 'collision');
    await Class.create({ name: 'Existing', teacher: user._id, joinCode: '586WT88' });
    generateShortJoinCode.mockReturnValueOnce('586WT88').mockReturnValueOnce('4M8Z1P2');

    const response = await request(app).post('/api/classes')
      .set('Authorization', `Bearer ${token}`).send({ name: 'Collision-safe class' });

    expect(response.status).toBe(200);
    expect(response.body.data.joinCode).toBe('4M8Z1P2');
    expect(generateShortJoinCode).toHaveBeenCalledTimes(2);
    expect(await Class.countDocuments({ joinCode: '586WT88' })).toBe(1);
    expect(await Class.countDocuments({ joinCode: '4M8Z1P2' })).toBe(1);
  });

  test('stops after five collisions without creating a duplicate class', async () => {
    const { user, token } = await createUser('teacher', 'bounded-collision');
    await Class.create({ name: 'Existing', teacher: user._id, joinCode: '586WT88' });
    generateShortJoinCode.mockReturnValue('586WT88');

    const response = await request(app).post('/api/classes')
      .set('Authorization', `Bearer ${token}`).send({ name: 'Cannot allocate a code' });

    expect(response.status).toBe(500);
    expect(response.body.message).toBe('Failed to generate unique join code');
    expect(generateShortJoinCode).toHaveBeenCalledTimes(5);
    expect(await Class.countDocuments({ teacher: user._id })).toBe(1);
  });

  test('resolves both new short codes and existing legacy UUID-style codes', async () => {
    const { user } = await createUser('teacher', 'legacy');
    const legacyCode = '63682f39-6b53-4579-bad7-9b6b2d79a18d';
    await Class.create([
      { name: 'New Code Class', teacher: user._id, joinCode: 'A7K92Q4' },
      { name: 'Legacy Code Class', teacher: user._id, joinCode: legacyCode }
    ]);

    const shortResponse = await request(app).get('/api/classes/join/a7k92q4');
    const legacyResponse = await request(app).get(`/api/classes/join/${legacyCode}`);

    expect(shortResponse.status).toBe(200);
    expect(shortResponse.body.data.name).toBe('New Code Class');
    expect(legacyResponse.status).toBe(200);
    expect(legacyResponse.body.data.name).toBe('Legacy Code Class');
  });

  test('a student can join a class using a new short code', async () => {
    const { user: teacher } = await createUser('teacher', 'join-owner');
    const { user: student, token } = await createUser('student', 'join-student');
    const classDoc = await Class.create({ name: 'Joinable Class', teacher: teacher._id, joinCode: '4M8Z1P2' });

    const response = await request(app).post('/api/memberships/join')
      .set('Authorization', `Bearer ${token}`).send({ joinCode: '4m8z1p2' });

    expect(response.status).toBe(200);
    expect(String(response.body.data.class._id)).toBe(String(classDoc._id));
    expect(await Membership.countDocuments({ student: student._id, class: classDoc._id, status: 'active' })).toBe(1);
  });
});
