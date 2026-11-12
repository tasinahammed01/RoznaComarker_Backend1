'use strict';
// Server-side validation for teacher uploads: names, emails (no header injection), student lists, references and modes.
const input = require('../src/services/teacherUploadInput.service');

describe('normalizeName', () => {
  test.each([
    ['  Sam   Lee  ', 'Sam Lee'],
    ["Siobhán O'Brien-Smith", "Siobhán O'Brien-Smith"],
    ['Sam' + String.fromCharCode(0x2028) + 'Lee', 'Sam Lee'],                     // line separator
    ['Sam' + String.fromCharCode(0x200b) + 'Lee' + String.fromCharCode(0x202e) + '', 'Sam Lee'],                 // zero-width space, bidi override
    ['Sam\r\nBcc: x', 'Sam Bcc: x'],                   // line breaks never survive
    ['Student 2029', 'Student 2029'],                  // digits are kept
    ['e' + String.fromCharCode(0x301) + 'mile', 'émile']                           // NFC
  ])('%j becomes %j', (raw, expected) => expect(input.normalizeName(raw)).toEqual({ value: expected }));

  test.each([[''], ['   '], [null], [42], ['<b>Sam</b>'], ['a'.repeat(121)]])('%j is refused', raw => {
    expect(input.normalizeName(raw).error).toEqual(expect.any(String));
  });
});

describe('normalizeEmail', () => {
  test('trims and lower-cases', () => expect(input.normalizeEmail('  Sam.Lee+7B@Example.CO.UK ')).toEqual({ value: 'sam.lee+7b@example.co.uk' }));
  test.each([
    'not-an-email', 'a@b', 'a@b.c', '@example.com', 'sam@', 'sam lee@example.com', 'sam@exa mple.com',
    'a@b.com\r\nBcc: victim@example.com', 'a@b.com\nTo: x@y.com', '"Sam" <sam@example.com>', 'a@b.com, c@d.com', 'a@b.com;c@d.com',
    `${'a'.repeat(65)}@example.com`, `a@${'b'.repeat(250)}.com`, '', null
  ])('refuses %j', raw => expect(input.normalizeEmail(raw).error).toEqual(expect.any(String)));
});

describe('validateStudents', () => {
  test('returns every row with its values or errors and flags repeated emails case-insensitively', () => {
    const rows = input.validateStudents([
      { name: 'Sam Lee', email: 'sam@example.com' }, { name: 'Sam L', email: ' SAM@example.com ' }, { name: '', email: 'bad' }, null
    ]);
    expect(rows[0]).toEqual({ index: 0, name: 'Sam Lee', email: 'sam@example.com' });
    expect(rows[1].errors.email).toBe('This email is already in row 1.');
    expect(rows[2].errors).toEqual({ name: expect.any(String), email: expect.any(String) });
    expect(rows[3].errors).toEqual({ name: expect.any(String), email: expect.any(String) });
  });
  test('refuses a request that is not a non-empty list of at most 100 students', () => {
    expect(() => input.validateStudents('x')).toThrow(/at least one/);
    expect(() => input.validateStudents([])).toThrow(/at least one/);
    expect(() => input.validateStudents(Array.from({ length: 101 }, () => ({})))).toThrow(/up to 100/);
    expect(() => input.validateStudents(Array.from({ length: 100 }, (_, i) => ({ name: `S${i}`, email: `s${i}@example.com` })))).not.toThrow();
  });
});

describe('references and mode', () => {
  test('requestKey accepts 32-128 word characters or dashes only', () => {
    expect(input.requestKey('3f1c2b9e-1d4a-4c8e-9b7a-0f2e6d5c4b3a')).toBe('3f1c2b9e-1d4a-4c8e-9b7a-0f2e6d5c4b3a');
    for (const bad of ['short', 'x'.repeat(129), '../../etc/passwd/../../etc/passwd/../../x', null]) expect(() => input.requestKey(bad)).toThrow();
  });
  test('batchId accepts 8-64 word characters or dashes only', () => {
    expect(input.batchId('batch-0001')).toBe('batch-0001');
    for (const bad of ['x', '../../x', 'a b c d e f g', 'y'.repeat(65)]) expect(() => input.batchId(bad)).toThrow();
  });
  test('mode defaults to new and accepts only new, replace or add_pages', () => {
    expect(input.mode(undefined)).toBe('new'); expect(input.mode('')).toBe('new');
    for (const mode of ['new', 'replace', 'add_pages']) expect(input.mode(mode)).toBe(mode);
    expect(() => input.mode('overwrite')).toThrow();
  });
});
