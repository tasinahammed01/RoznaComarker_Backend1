'use strict';
/**
 * Metrics for the OCR evaluation harness. Pure functions: no I/O, no network, no dependencies.
 *
 * Conventions
 *  - Texts are normalised first: Unicode NFC, invisible characters removed, typographic quotes/dashes
 *    folded to plain forms, and every whitespace run (including line breaks) collapsed to one space.
 *  - Words are whitespace-separated tokens. Punctuation stays attached, because marking depends on it.
 *  - CER = character edit distance / reference characters. WER = word edit distance / reference words.
 *    A rate is null (not 0) when the reference is empty.
 *  - A ground-truth token containing "[?]" (standalone "[?]" or a suffix such as "word[?]") is an
 *    uncertain region. It is ignored: it matches up to `wildcardSpan` model words (or none) at zero cost,
 *    and the model words it consumed are dropped before scoring. Anything else still counts.
 */

const UNCERTAIN_MARK = '[?]';
const DEFAULT_WILDCARD_SPAN = 2;
const MAX_WILDCARD_SPAN = 250; // alignment back-pointers are stored in one byte
const MAX_ALIGNMENT_CELLS = 60_000_000;
const MAX_DISTANCE_WORK = 2_000_000_000;
const WILDCARD = '\u0000uncertain';

const TYPOGRAPHY_FOLDS = [
  [/[‘’‚‛ʼ′]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/[‐-―−]/g, '-'],
  [/…/g, '...'],
];

function normalizeText(text, { caseSensitive = true, foldTypography = true } = {}) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  let out = text.normalize('NFC').replace(/[﻿​-‍⁠]/g, '');
  if (foldTypography) for (const [pattern, replacement] of TYPOGRAPHY_FOLDS) out = out.replace(pattern, replacement);
  out = out.replace(/\s+/gu, ' ').trim();
  return caseSensitive ? out : out.toLowerCase();
}

function tokenize(text) {
  return String(text).split(/\s+/u).filter(Boolean);
}

function isUncertainToken(token) {
  return typeof token === 'string' && token.includes(UNCERTAIN_MARK);
}

/** A word without leading/trailing punctuation, used where punctuation must not decide a comparison. */
function coreForm(token) {
  return token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

function checkSpan(wildcardSpan) {
  if (!Number.isInteger(wildcardSpan) || wildcardSpan < 0 || wildcardSpan > MAX_WILDCARD_SPAN) {
    throw new RangeError(`wildcardSpan must be an integer between 0 and ${MAX_WILDCARD_SPAN}`);
  }
}

/** Edit distance over strings (by code point) or arrays. Rolling rows, so memory is O(shorter side). */
function levenshteinDistance(a, b) {
  const x = typeof a === 'string' ? Array.from(a) : a;
  const y = typeof b === 'string' ? Array.from(b) : b;
  if (!x.length) return y.length;
  if (!y.length) return x.length;
  if (x.length * y.length > MAX_DISTANCE_WORK) throw new RangeError('Inputs are too large to compare.');
  const [short, long] = x.length >= y.length ? [y, x] : [x, y];
  let previous = new Uint32Array(short.length + 1);
  let current = new Uint32Array(short.length + 1);
  for (let j = 0; j <= short.length; j++) previous[j] = j;
  for (let i = 1; i <= long.length; i++) {
    current[0] = i;
    for (let j = 1; j <= short.length; j++) {
      const substitution = previous[j - 1] + (long[i - 1] === short[j - 1] ? 0 : 1);
      current[j] = Math.min(substitution, previous[j] + 1, current[j - 1] + 1);
    }
    [previous, current] = [current, previous];
  }
  return previous[short.length];
}

/**
 * Minimum-cost alignment of two token lists. Ties prefer match/substitution, then deletion, then insertion,
 * so the result is deterministic. Operations (in order):
 *   match/sub {ref, hyp}   del {ref}   ins {hyp}   wild {ref, hypStart, hypEnd}
 * `ref`/`hyp` are token indices, -1 when not applicable. A wildcard reference token consumes 0..wildcardSpan
 * hypothesis tokens at zero cost.
 */
function alignTokens(ref, hyp, { isWildcard = () => false, wildcardSpan = DEFAULT_WILDCARD_SPAN, equals = (a, b) => a === b } = {}) {
  checkSpan(wildcardSpan);
  const n = ref.length, m = hyp.length, width = m + 1;
  if ((n + 1) * width > MAX_ALIGNMENT_CELLS) throw new RangeError('Inputs are too large to align.');
  const wild = ref.map(token => isWildcard(token));
  const cost = new Uint32Array((n + 1) * width);
  // 0 = diagonal, 1 = deletion, 2 = insertion, 3 + k = wildcard consuming k hypothesis tokens
  const back = new Uint8Array((n + 1) * width);
  for (let j = 1; j <= m; j++) { cost[j] = j; back[j] = 2; }
  for (let i = 1; i <= n; i++) {
    const row = i * width, above = (i - 1) * width;
    if (wild[i - 1]) { cost[row] = cost[above]; back[row] = 3; } else { cost[row] = cost[above] + 1; back[row] = 1; }
    for (let j = 1; j <= m; j++) {
      let best, code;
      if (wild[i - 1]) {
        best = Infinity; code = 3;
        for (let k = 0; k <= Math.min(wildcardSpan, j); k++) {
          const c = cost[above + j - k];
          if (c < best) { best = c; code = 3 + k; }
        }
        const insertion = cost[row + j - 1] + 1;
        if (insertion < best) { best = insertion; code = 2; }
      } else {
        best = cost[above + j - 1] + (equals(ref[i - 1], hyp[j - 1]) ? 0 : 1); code = 0;
        const deletion = cost[above + j] + 1;
        if (deletion < best) { best = deletion; code = 1; }
        const insertion = cost[row + j - 1] + 1;
        if (insertion < best) { best = insertion; code = 2; }
      }
      cost[row + j] = best; back[row + j] = code;
    }
  }
  const ops = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    const code = back[i * width + j];
    if (code === 0) {
      ops.push({ type: equals(ref[i - 1], hyp[j - 1]) ? 'match' : 'sub', ref: i - 1, hyp: j - 1 }); i--; j--;
    } else if (code === 1) {
      ops.push({ type: 'del', ref: i - 1, hyp: -1 }); i--;
    } else if (code === 2) {
      ops.push({ type: 'ins', ref: -1, hyp: j - 1 }); j--;
    } else {
      const k = code - 3;
      ops.push({ type: 'wild', ref: i - 1, hyp: -1, hypStart: j - k, hypEnd: j }); i--; j -= k;
    }
  }
  ops.reverse();
  return { distance: cost[n * width + m], ops };
}

function countOps(ops) {
  const counts = { substitutions: 0, deletions: 0, insertions: 0 };
  for (const op of ops) {
    if (op.type === 'sub') counts.substitutions++;
    else if (op.type === 'del') counts.deletions++;
    else if (op.type === 'ins') counts.insertions++;
  }
  return counts;
}

/** CER and WER for one case mode, after masking [?] regions. */
function scoreTexts(reference, hypothesis, { caseSensitive = true, foldTypography = true, wildcardSpan = DEFAULT_WILDCARD_SPAN } = {}) {
  const options = { caseSensitive, foldTypography };
  const refTokens = tokenize(normalizeText(reference, options));
  const hypTokens = tokenize(normalizeText(hypothesis, options));
  const masking = alignTokens(refTokens, hypTokens, { isWildcard: isUncertainToken, wildcardSpan });
  const consumed = new Set();
  let maskedReference = 0;
  for (const op of masking.ops) {
    if (op.type !== 'wild') continue;
    maskedReference++;
    for (let k = op.hypStart; k < op.hypEnd; k++) consumed.add(k);
  }
  const keptRef = refTokens.filter(token => !isUncertainToken(token));
  const keptHyp = hypTokens.filter((_, index) => !consumed.has(index));
  const words = alignTokens(keptRef, keptHyp);
  const refChars = keptRef.join(' '), hypChars = keptHyp.join(' ');
  const referenceChars = Array.from(refChars).length;
  const cerDistance = levenshteinDistance(refChars, hypChars);
  return {
    cer: referenceChars ? cerDistance / referenceChars : null,
    wer: keptRef.length ? words.distance / keptRef.length : null,
    cerDistance, referenceChars,
    werDistance: words.distance, referenceWords: keptRef.length, hypothesisWords: keptHyp.length,
    ...countOps(words.ops),
    uncertain: { referenceTokensMasked: maskedReference, hypothesisTokensDropped: consumed.size },
  };
}

function evaluatePair(groundTruth, modelOutput, options = {}) {
  return {
    caseSensitive: scoreTexts(groundTruth, modelOutput, { ...options, caseSensitive: true }),
    caseInsensitive: scoreTexts(groundTruth, modelOutput, { ...options, caseSensitive: false }),
  };
}

/**
 * Parses a mistakes sidecar: one "student_form<TAB>correct_form" per line; blank lines and lines starting
 * with # are ignored. Problems are reported with line numbers rather than skipped silently.
 */
function parseMistakes(text) {
  const entries = [], errors = [], seen = new Map();
  String(text).replace(/^﻿/, '').split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    if (!raw.trim() || raw.trimStart().startsWith('#')) return;
    const fields = raw.split('\t');
    if (fields.length !== 2) {
      errors.push({ line, message: fields.length < 2 ? 'Expected "student form<TAB>correct form".' : 'Too many columns; expected exactly two.' });
      return;
    }
    const student = normalizeText(fields[0]), correct = normalizeText(fields[1]);
    if (!student || !correct) { errors.push({ line, message: 'Both the student form and the correct form are required.' }); return; }
    const studentTokens = tokenize(student).map(coreForm), correctTokens = tokenize(correct).map(coreForm);
    if (studentTokens.includes('') || correctTokens.includes('')) {
      errors.push({ line, message: 'Each word needs at least one letter or digit.' }); return;
    }
    const key = studentTokens.join(' ');
    if (key === correctTokens.join(' ')) { errors.push({ line, message: 'The student form and the correct form are identical.' }); return; }
    if (seen.has(key)) { errors.push({ line, message: `Duplicate student form (first listed on line ${seen.get(key)}).` }); return; }
    seen.set(key, line);
    entries.push({ line, student, correct, studentTokens, correctTokens });
  });
  return { entries, errors };
}

const sameTokens = (a, b) => a.length === b.length && a.every((token, i) => token === b[i]);

/**
 * Over-correction: for every listed student mistake found in the ground truth, did the model silently
 * replace it with the correct form? Words are compared without surrounding punctuation but WITH case,
 * because capitalisation slips are student mistakes too. Outcomes per occurrence:
 *   preserved (model kept the student's form) | overcorrected (model wrote the correct form)
 *   misread (anything else) | dropped (no model word aligned)
 * Occurrences inside [?] regions are excluded. Without a list the metric is unavailable, not zero.
 */
function overCorrection(groundTruth, modelOutput, mistakes, { wildcardSpan = DEFAULT_WILDCARD_SPAN } = {}) {
  const entries = mistakes?.entries ?? [];
  if (!entries.length) return { available: false, reason: 'no mistake list', overcorrectionRate: null, preservedRate: null };
  const refTokens = tokenize(normalizeText(groundTruth)), hypTokens = tokenize(normalizeText(modelOutput));
  const refCore = refTokens.map(coreForm), hypCore = hypTokens.map(coreForm);
  const masked = refTokens.map(isUncertainToken);
  const alignment = alignTokens(refCore.map((core, i) => (masked[i] ? WILDCARD : core)), hypCore,
    { isWildcard: token => token === WILDCARD, wildcardSpan });
  const opIndexByRef = new Array(refTokens.length).fill(-1);
  alignment.ops.forEach((op, index) => { if (op.ref >= 0) opIndexByRef[op.ref] = index; });

  // Longest phrases first, left to right, no word counted twice.
  const ordered = [...entries].sort((a, b) => b.studentTokens.length - a.studentTokens.length || a.line - b.line);
  const taken = new Array(refTokens.length).fill(false);
  const matched = new Set(), found = [];
  let excludedUncertain = 0;
  for (let i = 0; i < refTokens.length; i++) {
    if (taken[i]) continue;
    for (const entry of ordered) {
      const length = entry.studentTokens.length;
      if (i + length > refTokens.length) continue;
      if (!entry.studentTokens.every((token, k) => refCore[i + k] === token && !taken[i + k])) continue;
      for (let k = 0; k < length; k++) taken[i + k] = true;
      matched.add(entry);
      if (masked.slice(i, i + length).some(Boolean)) excludedUncertain++; else found.push({ entry, start: i });
      break;
    }
  }

  const counts = { preserved: 0, overcorrected: 0, misread: 0, dropped: 0 };
  const occurrences = found.map(({ entry, start }) => {
    const span = alignment.ops.slice(opIndexByRef[start], opIndexByRef[start + entry.studentTokens.length - 1] + 1);
    const modelIndices = span.filter(op => op.hyp >= 0).map(op => op.hyp);
    const modelCoreWords = modelIndices.map(j => hypCore[j]).filter(Boolean);
    let outcome;
    if (!modelCoreWords.length) outcome = 'dropped';
    else if (sameTokens(modelCoreWords, entry.studentTokens)) outcome = 'preserved';
    else if (sameTokens(modelCoreWords, entry.correctTokens)) outcome = 'overcorrected';
    else outcome = 'misread';
    counts[outcome]++;
    return { student: entry.student, correct: entry.correct, position: start, modelText: modelIndices.map(j => hypTokens[j]).join(' '), outcome };
  });

  const unlisted = [];
  for (const op of alignment.ops) {
    if (op.type === 'sub' && !taken[op.ref] && !masked[op.ref]) unlisted.push({ gt: refTokens[op.ref], model: hypTokens[op.hyp] });
  }
  const listed = found.length;
  return {
    available: true, listed, ...counts, excludedUncertain,
    unmatchedEntries: entries.filter(entry => !matched.has(entry)).map(entry => entry.student),
    overcorrectionRate: listed ? counts.overcorrected / listed : null,
    preservedRate: listed ? counts.preserved / listed : null,
    occurrences,
    unlistedSubstitutions: { count: unlisted.length, examples: unlisted.slice(0, 50) },
  };
}

/**
 * Draft helper: ground-truth words that at least one output changed by a small edit (likely spelling
 * corrections, or misreads). A human reviews the result; only genuine student mistakes belong in the list.
 */
function suggestMistakes(groundTruth, outputs, { maxEditDistance = 2, wildcardSpan = DEFAULT_WILDCARD_SPAN } = {}) {
  const refTokens = tokenize(normalizeText(groundTruth));
  const refCore = refTokens.map(coreForm);
  const forAlign = refTokens.map((token, i) => (isUncertainToken(token) ? WILDCARD : refCore[i]));
  const byPosition = new Map();
  for (const { label, text } of outputs) {
    const hypCore = tokenize(normalizeText(text)).map(coreForm);
    const { ops } = alignTokens(forAlign, hypCore, { isWildcard: token => token === WILDCARD, wildcardSpan });
    for (const op of ops) {
      if (op.type !== 'sub') continue;
      const student = refCore[op.ref], changed = hypCore[op.hyp];
      if (!student || !changed || levenshteinDistance(student, changed) > maxEditDistance) continue;
      if (!byPosition.has(op.ref)) byPosition.set(op.ref, { position: op.ref, student, suggestions: new Map() });
      const suggestions = byPosition.get(op.ref).suggestions;
      if (!suggestions.has(changed)) suggestions.set(changed, []);
      if (!suggestions.get(changed).includes(label)) suggestions.get(changed).push(label);
    }
  }
  return [...byPosition.values()].map(({ position, student, suggestions }) => {
    const list = [...suggestions].map(([correct, models]) => ({ correct, models }));
    return { position, student, suggestions: list, modelCount: new Set(list.flatMap(item => item.models)).size };
  }).sort((a, b) => b.modelCount - a.modelCount || a.position - b.position);
}

/** Renders suggestions as a valid mistakes file (commented header, one active line per student form). */
function formatMistakesDraft(candidates, { name } = {}) {
  const lines = [
    `# Draft mistake list${name ? ` for ${name}` : ''}. Review before use: keep only genuine STUDENT mistakes, correct the right-hand form if needed, delete the rest.`,
    '# Format: student_form<TAB>correct_form (one per line; a line starting with # is a comment).',
  ];
  const pairs = new Map();
  for (const candidate of candidates) {
    for (const { correct, models } of candidate.suggestions) {
      const key = `${candidate.student}\t${correct}`;
      if (!pairs.has(key)) pairs.set(key, { student: candidate.student, correct, positions: [], models: new Set() });
      const pair = pairs.get(key);
      pair.positions.push(candidate.position + 1);
      models.forEach(model => pair.models.add(model));
    }
  }
  const emitted = new Set();
  for (const pair of [...pairs.values()].sort((a, b) => b.models.size - a.models.size || a.positions[0] - b.positions[0])) {
    lines.push(`# word ${pair.positions.join(', ')} - changed by: ${[...pair.models].join(', ')}`);
    // A student form may appear once: further suggestions for it are kept as comments.
    if (emitted.has(pair.student)) lines.push(`# alternative: ${pair.student}\t${pair.correct}`);
    else { emitted.add(pair.student); lines.push(`${pair.student}\t${pair.correct}`); }
  }
  return `${lines.join('\n')}\n`;
}

module.exports = {
  UNCERTAIN_MARK, DEFAULT_WILDCARD_SPAN,
  normalizeText, tokenize, isUncertainToken, coreForm,
  levenshteinDistance, alignTokens, scoreTexts, evaluatePair,
  parseMistakes, overCorrection, suggestMistakes, formatMistakesDraft,
};
