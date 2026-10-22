'use strict';
// Private experiment only. No application OCR, correction or publication authority is changed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { root, home, localDirectory } = require('./config.cjs');
const { writeExclusive } = require('./sol-verbatim.cjs');
const { polygonValid } = require('../../src/services/hybridSource/reconcile');
const HASH = 'dea93eca607e5b6a20c2d9362fe5c58a41c7e97a7d514459d8c031ee89375772';
const MODEL = 'openai/gpt-5.6-sol';
const DIR = path.join(home, 'private', 'source-fidelity-crop-v2-page01');
const SOURCE = path.resolve(root, '../staging-test-data/handwritten-page-01.jpeg');
const OLD = path.join(home, 'private', 'sol-verbatim-page01');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const read = (d, n) => JSON.parse(fs.readFileSync(path.join(d, n), 'utf8'));
const save = (d, n, v) => {
  if (!Buffer.isBuffer(v)) return writeExclusive(path.join(d, n), v);
  const fd = fs.openSync(path.join(d,n), 'wx', 0o600);
  try { fs.writeFileSync(fd,v); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};
function source() {
  if (!fs.lstatSync(SOURCE).isFile() || fs.lstatSync(SOURCE).isSymbolicLink() || fs.realpathSync(SOURCE) !== SOURCE) throw Error('SOURCE_PATH_INVALID');
  const bytes = fs.readFileSync(SOURCE);
  if (sha(bytes) !== HASH) throw Error('SOURCE_SHA_MISMATCH');
  return bytes;
}
class Budget {
  constructor(dir) { this.dir = dir; }
  reserve(kind) {
    if (!['google-attempt', 'google-http', 'google-auth', 'sol-1-attempt', 'sol-1-http', 'sol-2-attempt', 'sol-2-http'].includes(kind)) throw Error('PROVIDER_BUDGET_FORBIDDEN');
    if (kind.startsWith('sol-2') && (!fs.existsSync(path.join(this.dir, 'batch-1-result.json')) || read(this.dir, 'batch-1-result.json').status !== 'COMPLETE')) throw Error('PRIOR_STAGE_NOT_COMPLETE');
    try { save(this.dir, kind + '.reserved.json', { kind, sourceSha256: HASH, timestamp: new Date().toISOString() }); }
    catch (e) { if (e.code === 'EEXIST') throw Error('PROVIDER_BUDGET_CONSUMED'); throw e; }
  }
}
function snapshot() {
  const files = new Set();
  const walk = d => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name); if (e.isSymbolicLink()) throw Error('SNAPSHOT_LINK'); if (e.isDirectory()) walk(p); else files.add(p);
  } };
  for (const d of [path.join(root, 'src'), path.resolve(root, '../RoznaComarker/src'), OLD, path.join(home, 'private', 'real-one')]) walk(d);
  for (const f of ['.env', '.env.example', 'package.json', 'package-lock.json']) files.add(path.join(root, f));
  for (const f of ['angular.json', 'package.json', 'package-lock.json', 'pnpm-lock.yaml']) {
    const p = path.resolve(root, '../RoznaComarker', f); if (fs.existsSync(p)) files.add(p);
  }
  const frozen = JSON.parse(fs.readFileSync(path.resolve(root, '../output/phase6-protected-hashes.json')));
  for (const [p, hash] of Object.entries(frozen)) {
    const f = path.resolve(root, '..', p); if (sha(fs.readFileSync(f)) !== hash) throw Error('FROZEN_BASELINE_CHANGED'); files.add(f);
  }
  return Object.fromEntries([...files].sort().map(f => [path.relative(path.resolve(root, '..'), f), sha(fs.readFileSync(f))]));
}
function assertSnapshot(expected) {
  source();
  const actual = snapshot();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error('PROTECTED_FILES_CHANGED');
  return Object.keys(actual).length;
}
function initialize() {
  source(); localDirectory(DIR);
  if (!fs.existsSync(path.join(DIR, 'baseline.json'))) save(DIR, 'baseline.json', snapshot());
  assertSnapshot(read(DIR, 'baseline.json'));
}
// Tokenization retains all punctuation as individual tokens and exact source offsets.
// No character is case-folded, stripped or corrected.
function tokens(text) {
  return [...text.matchAll(/[\p{L}\p{M}\p{N}]+|[^\s\p{L}\p{M}\p{N}]/gu)].map(m => ({ text: m[0], start: m.index, end: m.index + m[0].length }));
}
function align(a, b) {
  const n = a.length, m = b.length;
  if (n > 1200 || m > 1200) throw Error('ALIGNMENT_LIMIT');
  const f = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  const r = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = 0; i <= n; i++) f[i][0] = i;
  for (let j = 0; j <= m; j++) f[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) f[i][j] = Math.min(f[i-1][j]+1, f[i][j-1]+1, f[i-1][j-1]+(a[i-1].text === b[j-1].text ? 0 : 1));
  for (let i = n; i >= 0; i--) r[i][m] = n-i;
  for (let j = m; j >= 0; j--) r[n][j] = m-j;
  for (let i = n-1; i >= 0; i--) for (let j = m-1; j >= 0; j--) r[i][j] = Math.min(r[i+1][j]+1, r[i][j+1]+1, r[i+1][j+1]+(a[i].text === b[j].text ? 0 : 1));
  const possible = a.map(() => new Set()), total = f[n][m];
  for (let i = 0; i < n; i++) for (let j = 0; j <= m; j++) {
    if (f[i][j]+1+r[i+1][j] === total) possible[i].add(null);
    if (j < m && f[i][j]+(a[i].text === b[j].text ? 0 : 1)+r[i+1][j+1] === total) possible[i].add(j);
  }
  const operations = []; let i = 0, j = 0;
  while (i < n || j < m) {
    // Deterministic diagnostic path; ambiguous alternatives NEVER establish occurrence authority.
    if (i < n && j < m && r[i][j] === r[i+1][j+1]+(a[i].text === b[j].text ? 0 : 1)) {
      operations.push({ googleIndex: i, solIndex: j, exact: a[i].text === b[j].text, ambiguous: possible[i].size !== 1 }); i++; j++;
    } else if (i < n && r[i][j] === r[i+1][j]+1) { operations.push({ googleIndex: i, solIndex: null, exact: false, ambiguous: possible[i].size !== 1 }); i++; }
    else { operations.push({ googleIndex: null, solIndex: j, exact: false, ambiguous: true }); j++; }
  }
  return { distance: total, operations, alternatives: possible.map(s => [...s]) };
}
// Classification is AFTER exact alignment. Explicit ASCII case pairs classify diagnostics only.
// Neither the alignment nor any output/source authority consumes the diagnostic labels.
const pairs = 'aA bB cC dD eE fF gG hH iI jJ kK lL mM nN oO pP qQ rR sS tT uU vV wW xX yY zZ'.split(' ');
function difference(a, b) {
  if (a === b) return 'EXACT';
  if (a.length === b.length && [...a].every((c, i) => c === b[i] || pairs.some(p => p.includes(c) && p.includes(b[i])))) return 'CASE_ONLY';
  if (/^[\p{P}\p{S}]*$/u.test(a) || /^[\p{P}\p{S}]*$/u.test(b)) return 'PUNCTUATION_OR_GAP';
  return 'SPELLING_OR_OTHER';
}
function googleWords(annotation, dimensions) {
  if (annotation.pages?.length !== 1 || annotation.pages[0].width !== dimensions.width || annotation.pages[0].height !== dimensions.height) throw Error('GOOGLE_COORDINATE_SPACE_UNPROVEN');
  const words = []; let line = 1;
  for (const block of annotation.pages[0].blocks || []) for (const para of block.paragraphs || []) for (const w of para.words || []) {
    const symbols = w.symbols || [], polygon = (w.boundingBox?.vertices || []).map(p => ({ x: p.x ?? 0, y: p.y ?? 0 }));
    const confidences = [w.confidence, ...symbols.map(s => s.confidence)].filter(Number.isFinite);
    const word = { id: `word_page01_1_${words.length+1}`, text: symbols.map(s => s.text || '').join(''), confidence: confidences.length ? Math.min(...confidences) : null,
      nativeConfidence: w.confidence ?? null, polygon, nativeBoundingBox: w.boundingBox, symbols, line, geometryValid: polygonValid(polygon, dimensions),
      breakType: symbols.at(-1)?.property?.detectedBreak?.type ?? null };
    words.push(word);
    if (['LINE_BREAK', 'EOL_SURE_SPACE', 3, 5].includes(word.breakType)) line++;
  }
  return words;
}
const closed = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const str = { type: 'string' }, num = { type: 'number', minimum: 0, maximum: 1 };
const schema = closed({ crops: { type: 'array', items: closed({
  cropId: str, status: { type: 'string', enum: ['READABLE', 'UNCERTAIN', 'SOURCE_UNREADABLE'] },
  characters: { type: 'array', items: closed({ index: { type: 'integer', minimum: 0 }, char: { type: ['string', 'null'] }, case: { type: 'string', enum: ['LOWER', 'UPPER', 'NONE'] }, confidence: num }) },
  verbatim: { type: ['string', 'null'] }, punctuation: str, crossedOutVisible: { type: 'boolean' },
  uncertainCharacterIndexes: { type: 'array', items: { type: 'integer', minimum: 0 } }, visualReason: str
}) } });
function validate(raw, ids) {
  const value = JSON.parse(raw);
  const exactKeys = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join('|') === keys.slice().sort().join('|');
  if (!exactKeys(value, ['crops']) || !Array.isArray(value.crops) || value.crops.length !== ids.length) throw Error('CROP_SCHEMA_INVALID');
  const seen = new Set();
  for (const c of value.crops) {
    if (!exactKeys(c, Object.keys(schema.properties.crops.items.properties)) || !ids.includes(c.cropId) || seen.has(c.cropId) ||
        !['READABLE', 'UNCERTAIN', 'SOURCE_UNREADABLE'].includes(c.status) || !Array.isArray(c.characters) || c.characters.length > 500 ||
        !(c.verbatim === null || typeof c.verbatim === 'string') || typeof c.punctuation !== 'string' || typeof c.visualReason !== 'string' ||
        typeof c.crossedOutVisible !== 'boolean' || !Array.isArray(c.uncertainCharacterIndexes)) throw Error('CROP_SCHEMA_INVALID');
    seen.add(c.cropId);
    c.characters.forEach((v, i) => {
      if (!exactKeys(v, ['index','char','case','confidence']) || v.index !== i || !(v.char === null || typeof v.char === 'string' && [...v.char].length === 1) ||
          !['LOWER','UPPER','NONE'].includes(v.case) || !Number.isFinite(v.confidence) || v.confidence < 0 || v.confidence > 1) throw Error('CROP_CHARACTER_INVALID');
      if (v.char && /^[a-z]$/.test(v.char) && v.case !== 'LOWER' || v.char && /^[A-Z]$/.test(v.char) && v.case !== 'UPPER' ||
          v.char && !/[\p{L}]/u.test(v.char) && v.case !== 'NONE') throw Error('CROP_CASE_INVALID');
    });
    if (new Set(c.uncertainCharacterIndexes).size !== c.uncertainCharacterIndexes.length || c.uncertainCharacterIndexes.some(i => !Number.isInteger(i) || i < 0 || i >= c.characters.length)) throw Error('CROP_UNCERTAINTY_INVALID');
    if (c.characters.some((v, i) => v.char === null && !c.uncertainCharacterIndexes.includes(i))) throw Error('CROP_UNCERTAINTY_INVALID');
    if (c.status === 'READABLE' && (!c.characters.length || c.characters.some(v => v.char === null) || c.uncertainCharacterIndexes.length || c.characters.map(v => v.char).join('') !== c.verbatim)) throw Error('CROP_RECONSTRUCTION_INVALID');
    if (c.status !== 'READABLE' && c.verbatim !== null) throw Error('CROP_UNCERTAIN_GUESS');
    if (c.status === 'READABLE' && c.punctuation !== c.characters.filter(v => /[\p{P}\p{S}]/u.test(v.char)).map(v => v.char).join('')) throw Error('CROP_PUNCTUATION_INVALID');
  }
  return value;
}
function decision(c) {
  if (!c) return { state: 'OCR_UNCERTAIN', text: null, reason: 'NOT_CROP_VERIFIED' };
  if (c.status === 'SOURCE_UNREADABLE') return { state: 'SOURCE_UNREADABLE', text: null, reason: 'VISUAL_SOURCE_UNREADABLE' };
  if (c.status !== 'READABLE' || c.crossedOutVisible || c.uncertainCharacterIndexes.length || c.characters.some(v => v.char === null || v.confidence < 0.95))
    return { state: 'OCR_UNCERTAIN', text: null, reason: c.crossedOutVisible ? 'DELETED_ACTIVE_SEPARATION_REQUIRES_REVIEW' : 'VISUAL_CONFIDENCE_INSUFFICIENT' };
  return { state: 'VERIFIED_SOURCE', text: c.verbatim, reason: 'EXACT_CROP_CHARACTERS_MODEL_EVIDENCE_ONLY' };
}
module.exports = { HASH, MODEL, DIR, SOURCE, OLD, sha, read, save, source, Budget, snapshot, assertSnapshot, initialize, tokens, align, difference, googleWords, schema, validate, decision };
