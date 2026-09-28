const { safePersistenceError } = require('../src/services/canonicalCorrectionsPipeline.service');

describe('provisional score persistence telemetry', () => {
  test('retains actionable validation paths without leaking values or stacks', () => {
    const error = new Error('User input secret-value');
    error.name = 'ValidationError';
    error.errors = { 'customRubricScores.criteria.0.levelTitle': { message: 'secret-value' } };
    error.stack = 'sensitive stack';
    expect(safePersistenceError(error)).toEqual({
      errorCode: 'PROVISIONAL_SCORE_PERSIST_FAILED',
      errorName: 'ValidationError',
      safeMessage: 'Mongoose validation failed.',
      validationPaths: ['customRubricScores.criteria.0.levelTitle'],
      mongoCode: null
    });
  });

  test('redacts MongoDB connection strings from generic persistence errors', () => {
    const result = safePersistenceError(new Error('write to mongodb+srv://user:password@example.test/db failed'));
    expect(result.safeMessage).toContain('[redacted-mongodb-uri]');
    expect(result.safeMessage).not.toContain('password');
  });
});
