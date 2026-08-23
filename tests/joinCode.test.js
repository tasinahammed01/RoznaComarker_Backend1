const { JOIN_CODE_ALPHABET, generateShortJoinCode } = require('../src/utils/joinCode');

describe('short class join codes', () => {
  test('generates seven uppercase alphanumeric characters with letters and numbers', () => {
    for (let i = 0; i < 100; i += 1) {
      const code = generateShortJoinCode();
      expect(code).toHaveLength(7);
      expect(code).toMatch(/^[A-Z0-9]{7}$/);
      expect([...code].every((character) => JOIN_CODE_ALPHABET.includes(character))).toBe(true);
      expect(code).toMatch(/[A-Z]/);
      expect(code).toMatch(/[0-9]/);
    }
  });

  test('uses the complete requested uppercase letter and digit alphabet', () => {
    expect(JOIN_CODE_ALPHABET).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
  });
});
