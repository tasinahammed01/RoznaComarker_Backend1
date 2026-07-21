const { assertIsolatedTestDatabase } = require('./helpers/testServer');

describe('isolated test database guard', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  afterAll(() => { process.env.NODE_ENV = originalNodeEnv; });

  test('requires test mode and an explicitly test-named database', () => {
    process.env.NODE_ENV = 'production';
    expect(() => assertIsolatedTestDatabase('mongodb://127.0.0.1:27017/projectrozna_http_test')).toThrow(/NODE_ENV=test/);
    process.env.NODE_ENV = 'test';
    expect(() => assertIsolatedTestDatabase('mongodb://127.0.0.1:27017/projectrozna')).toThrow(/non-test database/);
    expect(assertIsolatedTestDatabase('mongodb://127.0.0.1:27017/projectrozna_http_test')).toBe('projectrozna_http_test');
  });
});
