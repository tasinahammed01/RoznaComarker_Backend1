process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const User = require('../src/models/user.model');
const { createOrGetUserFromFirebase } = require('../src/middlewares/firebaseAuth.middleware');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');

describe('Firebase identity to MongoDB user lifecycle', () => {
  beforeAll(connectInMemoryMongo);
  afterAll(disconnectInMemoryMongo);
  beforeEach(clearDatabase);

  test('persists a roleless email/password Firebase user', async () => {
    const result = await createOrGetUserFromFirebase({
      uid: 'email-password-uid',
      email: 'New.Email@Example.test'
    });

    expect(result.isNew).toBe(true);
    const persisted = await User.findById(result.user._id).lean();
    expect(persisted).toMatchObject({
      firebaseUid: 'email-password-uid',
      email: 'new.email@example.test',
      role: null
    });
    expect(persisted.displayName).toBeUndefined();
    expect(persisted.photoURL).toBeUndefined();
  });

  test('persists a roleless Google Firebase user with available profile claims', async () => {
    const result = await createOrGetUserFromFirebase({
      uid: 'google-uid',
      email: 'Google.User@Example.test',
      name: '  Google User  ',
      picture: '  https://images.example.test/avatar.png  '
    });

    expect(result.isNew).toBe(true);
    const persisted = await User.findById(result.user._id).lean();
    expect(persisted).toMatchObject({
      firebaseUid: 'google-uid',
      email: 'google.user@example.test',
      displayName: 'Google User',
      photoURL: 'https://images.example.test/avatar.png',
      role: null
    });
  });

  test.each(['email/password', 'Google'])('reuses the existing MongoDB document on repeated %s login', async () => {
    const first = await createOrGetUserFromFirebase({
      uid: 'repeat-login-uid', email: 'original@example.test', name: 'Original Name'
    });
    const second = await createOrGetUserFromFirebase({
      uid: 'repeat-login-uid', email: 'changed@example.test', name: 'Changed Name'
    });

    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false);
    expect(String(second.user._id)).toBe(String(first.user._id));
    expect(await User.countDocuments({ firebaseUid: 'repeat-login-uid' })).toBe(1);
    expect((await User.findById(first.user._id).lean())).toMatchObject({
      email: 'original@example.test', displayName: 'Original Name'
    });
  });
});
