const { JOIN_CODE_ALPHABET, generateShortJoinCode } = require('../src/utils/joinCode');

describe('short class join codes', () => {
  test('generates six unambiguous uppercase characters with letters and numbers', () => {
    for (let i = 0; i < 100; i += 1) {
      const code = generateShortJoinCode();
      expect(code).toHaveLength(6);
      expect([...code].every((character) => JOIN_CODE_ALPHABET.includes(character))).toBe(true);
      expect(code).toMatch(/[A-Z]/);
      expect(code).toMatch(/[2-9]/);
    }
  });

  test('does not emit visually ambiguous characters', () => {
    expect(JOIN_CODE_ALPHABET).not.toMatch(/[ILO01]/);
  });
});
