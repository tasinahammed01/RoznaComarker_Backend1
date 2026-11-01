#!/usr/bin/env node
'use strict';
/**
 * READ-ONLY. For every imageN, compares imageN.txt (full transcription) with imageN.question.txt + imageN.answer.txt (verified files)
 * and prints ONLY counts per photo. No text, no words, no names are printed.
 *
 *   node scripts/ocr-eval/compare-ground-truth.cjs [folder]        (default folder: OCR_EVAL_DIR)
 *
 * Words are compared case-sensitively with outer punctuation removed. Words containing [?] are skipped on both sides.
 *   changed        words that differ in the two files (a substitution)
 *   near           of those, pairs that differ by 1-2 letters (length 3+): suggests a corrected spelling
 *   only_in_txt    words in imageN.txt that the verified files do not have (for example a name)
 *   only_verified  words in the verified files that imageN.txt does not have
 * Exit code 0 when every photo matches, 1 when at least one photo needs a re-check, 2 on a usage error.
 */
const fs = require('fs');
const path = require('path');

const strip = word => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
const wordsOf = text => text.split(/\s+/u).filter(w => w && !w.includes('[?]')).map(strip).filter(Boolean);

function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

/** Word-level alignment. Returns counts only. */
function compare(txtWords, verifiedWords) {
  const n = txtWords.length, m = verifiedWords.length, width = m + 1, cost = new Uint32Array((n + 1) * width);
  for (let j = 1; j <= m; j++) cost[j] = j;
  for (let i = 1; i <= n; i++) {
    cost[i * width] = i;
    for (let j = 1; j <= m; j++) cost[i * width + j] = Math.min(cost[(i - 1) * width + j - 1] + (txtWords[i - 1] === verifiedWords[j - 1] ? 0 : 1), cost[(i - 1) * width + j] + 1, cost[i * width + j - 1] + 1);
  }
  const out = { changed: 0, near: 0, onlyInTxt: 0, onlyVerified: 0 };
  for (let i = n, j = m; i > 0 || j > 0;) {
    if (i > 0 && j > 0 && cost[i * width + j] === cost[(i - 1) * width + j - 1] + (txtWords[i - 1] === verifiedWords[j - 1] ? 0 : 1)) {
      if (txtWords[i - 1] !== verifiedWords[j - 1]) {
        out.changed++;
        const a = txtWords[i - 1], b = verifiedWords[j - 1], d = distance(a, b);
        if (d >= 1 && d <= 2 && Math.min(a.length, b.length) >= 3) out.near++;
      }
      i--; j--;
    } else if (i > 0 && cost[i * width + j] === cost[(i - 1) * width + j] + 1) { out.onlyInTxt++; i--; }
    else { out.onlyVerified++; j--; }
  }
  return out;
}

const natural = (a, b) => a.localeCompare(b, 'en', { numeric: true });

function run(folder, write = line => process.stdout.write(line + '\n')) {
  const names = fs.readdirSync(folder).filter(f => /^image\d+\.txt$/i.test(f)).map(f => f.replace(/\.txt$/i, '')).sort(natural);
  const rows = [];
  for (const name of names) {
    const read = suffix => { const p = path.join(folder, `${name}${suffix}`); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; };
    const full = read('.txt'), question = read('.question.txt'), answer = read('.answer.txt');
    if (question === null || answer === null) { rows.push({ name, missing: [question === null && '.question.txt', answer === null && '.answer.txt'].filter(Boolean) }); continue; }
    const txtWords = wordsOf(full), verifiedWords = wordsOf(`${question}\n${answer}`);
    rows.push({ name, txtWords: txtWords.length, verifiedWords: verifiedWords.length, ...compare(txtWords, verifiedWords) });
  }
  write('photo        words_txt  words_verified  changed  near(1-2 letters)  only_in_txt  only_verified  verdict');
  for (const r of rows) {
    if (r.missing) { write(`${r.name.padEnd(12)}missing: ${r.missing.join(', ')}  verdict=CANNOT_COMPARE`); continue; }
    const ok = r.changed === 0 && r.onlyInTxt === 0 && r.onlyVerified === 0;
    write(`${r.name.padEnd(12)}${String(r.txtWords).padEnd(11)}${String(r.verifiedWords).padEnd(16)}${String(r.changed).padEnd(9)}${String(r.near).padEnd(19)}${String(r.onlyInTxt).padEnd(13)}${String(r.onlyVerified).padEnd(15)}${ok ? 'OK' : 'RE-CHECK'}`);
  }
  const recheck = rows.filter(r => r.missing || r.changed || r.onlyInTxt || r.onlyVerified).map(r => r.name);
  write(recheck.length ? `re-check imageN.txt for: ${recheck.join(', ')}` : 'all photos match');
  return { rows, recheck };
}

if (require.main === module) {
  const folder = process.argv[2] || process.env.OCR_EVAL_DIR;
  if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    console.error('Usage: node scripts/ocr-eval/compare-ground-truth.cjs [folder]   (or set OCR_EVAL_DIR)');
    process.exit(2);
  }
  process.exit(run(folder).recheck.length ? 1 : 0);
}
module.exports = { run, compare, wordsOf };
