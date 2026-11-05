'use strict';
// Read-only ground-truth comparison: counts only, never text. Synthetic fixtures.
const fs = require('fs'), os = require('os'), path = require('path');
const { run, compare, wordsOf } = require('../scripts/ocr-eval/compare-ground-truth.cjs');

test('counts substitutions, near-spelling pairs, extra and missing words', () => {
  const txt = wordsOf('Zed we chang the artical Therefore\nit ends'), verified = wordsOf('we change the article Therfore\nit ends here');
  expect(compare(txt, verified)).toEqual({ changed: 3, near: 3, onlyInTxt: 1, onlyVerified: 1 });
});
test('[?] regions and outer punctuation are ignored', () => {
  expect(compare(wordsOf('Hello, [?] world.'), wordsOf('Hello world'))).toEqual({ changed: 0, near: 0, onlyInTxt: 0, onlyVerified: 0 });
});
test('prints counts and photo names only, sorts naturally, flags only photos that differ', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-'));
  try {
    const put = (n, s) => fs.writeFileSync(path.join(dir, n), s);
    put('image2.txt', 'SECRETNAME good text'); put('image2.question.txt', 'good'); put('image2.answer.txt', 'text');
    put('image10.txt', 'same words'); put('image10.question.txt', 'same'); put('image10.answer.txt', 'words');
    put('image3.txt', 'no sidecars');
    const lines = []; const result = run(dir, l => lines.push(l));
    expect(result.rows.map(r => r.name)).toEqual(['image2', 'image3', 'image10']);
    expect(result.recheck).toEqual(['image2', 'image3']);
    const printed = lines.join('\n');
    for (const secret of ['SECRETNAME', 'good', 'same words', 'sidecars']) expect(printed).not.toContain(secret);
    expect(printed).toMatch(/image10\s+2\s+2\s+0\s+0\s+0\s+0\s+OK/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
