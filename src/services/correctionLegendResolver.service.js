'use strict';

const crypto = require('crypto');
const CorrectionLegend = require('../models/CorrectionLegend');
const logger = require('../utils/logger');

const REQUIRED = Object.freeze({
  CONTENT: ['REL', 'DEV', 'TA', 'CL', 'SD'],
  ORGANIZATION: ['COH', 'CO', 'PU', 'TS', 'CONC'],
  GRAMMAR: ['T', 'VF', 'AGR', 'FRAG', 'RO', 'WO', 'ART', 'PREP'],
  VOCABULARY: ['WC', 'WF', 'REP', 'FORM', 'COL'],
  MECHANICS: ['SP', 'P', 'CAP', 'SPC', 'FMT']
});
const FALLBACK_VERSION = 'correction-legend-fallback-v2';
const DEFAULT_DEDUCTIONS = Object.freeze({
  REL: 2, DEV: 1, TA: 2, CL: 1, SD: 1,
  COH: 1, CO: 1, PU: 1, TS: 1, CONC: 1,
  T: 0.5, VF: 0.5, AGR: 0.5, FRAG: 1, RO: 1, WO: 0.5, ART: 0.5, PREP: 0.5,
  WC: 0.5, WF: 0.5, REP: 0.5, FORM: 1, COL: 0.5,
  SP: 0.5, P: 0.5, CAP: 0.25, SPC: 0.25, FMT: 0.25
});
const GROUPS = [
  ['CONTENT', 'Content (Ideas & Relevance)', '#FFD6A5', [
    ['REL', 'Relevance', 'The idea is not related to the topic or task.'], ['DEV', 'Idea Development', 'The point is too general or lacks details or examples.'],
    ['TA', 'Task Achievement', 'The response does not fully answer the prompt or question.'], ['CL', 'Clarity of Ideas', 'The message is unclear or confusing.'],
    ['SD', 'Supporting Details', 'Examples or explanations are missing to support the main idea.']]],
  ['ORGANIZATION', 'Organization (Structure & Flow)', '#CDE7F0', [
    ['COH', 'Coherence', 'Ideas are not logically connected.'], ['CO', 'Cohesion', 'Linking words or transitions are missing or misused.'],
    ['PU', 'Paragraph Unity', 'The paragraph contains unrelated ideas.'], ['TS', 'Topic Sentence', 'The topic sentence is missing or unclear.'],
    ['CONC', 'Conclusion', 'The conclusion is weak or missing.']]],
  ['GRAMMAR', 'Grammar (Sentence & Structure)', '#B7E4C7', [
    ['T', 'Tense', 'Incorrect verb tense.'], ['VF', 'Verb Form', 'Incorrect verb form.'], ['AGR', 'Subject–Verb Agreement', 'The verb does not agree with the subject.'],
    ['FRAG', 'Sentence Fragment', 'Incomplete sentence missing a subject or verb.'], ['RO', 'Run-on Sentence', 'Two or more sentences are joined incorrectly.'],
    ['WO', 'Word Order', 'The order of words in the sentence is incorrect.'], ['ART', 'Article Use', 'Missing or incorrect article (a, an, the).'],
    ['PREP', 'Preposition', 'Incorrect or missing preposition.']]],
  ['VOCABULARY', 'Vocabulary (Word Use & Form)', '#E4C1F9', [
    ['WC', 'Word Choice', 'A more suitable word could be used.'], ['WF', 'Word Form', 'Incorrect form of the word.'],
    ['REP', 'Repetition', 'The same word or phrase is repeated too often.'], ['FORM', 'Formal / Inappropriate Word', 'The word is too informal or not suitable for academic context.'],
    ['COL', 'Collocation', 'Words do not naturally go together.']]],
  ['MECHANICS', 'Mechanics (Spelling & Punctuation)', '#FFF3BF', [
    ['SP', 'Spelling', 'The word is spelled incorrectly.'], ['P', 'Punctuation', 'Punctuation mark is missing, extra, or incorrect.'],
    ['CAP', 'Capitalization', 'Incorrect use of capital or lowercase letters.'], ['SPC', 'Spacing', 'Missing or extra space between words or sentences.'],
    ['FMT', 'Formatting', 'Inconsistent formatting, alignment, or spacing.']]]
];

function fallbackLegend() {
  return { version: FALLBACK_VERSION, description: 'Versioned complete academic correction legend fallback',
    groups: GROUPS.map(([key, label, color, symbols]) => ({ key, label, color,
      symbols: symbols.map(([symbol, itemLabel, description]) => ({ symbol, label: itemLabel, description,
        defaultDeduction: DEFAULT_DEDUCTIONS[symbol] })) })) };
}

function normalizeLegend(input) {
  const value = input?.toObject ? input.toObject() : input;
  if (!value || !Array.isArray(value.groups)) return null;
  return { version: String(value.version || '').trim(), description: String(value.description || '').trim(),
    groups: value.groups.map((group) => ({ key: String(group?.key || group?.category || '').trim().toUpperCase(),
      label: String(group?.label || '').trim(), color: String(group?.color || '').trim(),
      symbols: Array.isArray(group?.symbols) ? group.symbols.map((item) => ({ symbol: String(item?.symbol || '').trim().toUpperCase(),
        label: String(item?.label || '').trim(), description: String(item?.description || '').trim(),
        defaultDeduction: Number(item?.defaultDeduction) })) : [] })) };
}

function validateLegend(input) {
  const legend = normalizeLegend(input);
  const errors = [];
  if (!legend || legend.groups.length !== 5) return { valid: false, errors: ['REQUIRED_GROUP_COUNT'], legend: null };
  const groupKeys = new Set(); const symbols = new Set();
  for (const group of legend.groups) {
    if (!Object.hasOwn(REQUIRED, group.key)) errors.push(`UNSUPPORTED_GROUP:${group.key}`);
    if (groupKeys.has(group.key)) errors.push(`DUPLICATE_GROUP:${group.key}`); groupKeys.add(group.key);
    if (!group.label) errors.push(`EMPTY_GROUP_LABEL:${group.key}`);
    if (!/^#[0-9A-F]{6}$/iu.test(group.color)) errors.push(`INVALID_COLOR:${group.key}`);
    for (const item of group.symbols) {
      if (symbols.has(item.symbol)) errors.push(`DUPLICATE_SYMBOL:${item.symbol}`); symbols.add(item.symbol);
      if (!item.label) errors.push(`EMPTY_LABEL:${item.symbol}`);
      if (!item.description) errors.push(`EMPTY_DESCRIPTION:${item.symbol}`);
      if (!Number.isFinite(item.defaultDeduction) || item.defaultDeduction < 0) errors.push(`INVALID_DEDUCTION:${item.symbol}`);
    }
  }
  for (const [key, required] of Object.entries(REQUIRED)) {
    const group = legend.groups.find((item) => item.key === key);
    if (!group) errors.push(`MISSING_GROUP:${key}`);
    else for (const symbol of required) if (!group.symbols.some((item) => item.symbol === symbol)) errors.push(`MISSING_SYMBOL:${key}/${symbol}`);
    if (group && group.symbols.length !== required.length) errors.push(`UNEXPECTED_SYMBOL_COUNT:${key}`);
  }
  return { valid: errors.length === 0, errors, legend };
}

function contentHash(legend) {
  return crypto.createHash('sha256').update(JSON.stringify(legend)).digest('hex');
}

async function resolveLegend({ model = CorrectionLegend } = {}) {
  let candidate = null; let databaseError = null;
  try {
    const disconnectedDefaultModel = model === CorrectionLegend && Number(model?.db?.readyState || 0) !== 1;
    if (!disconnectedDefaultModel) candidate = await model.findOne({}).lean();
    else databaseError = Object.assign(new Error('CorrectionLegend database connection is unavailable.'), { code: 'DATABASE_UNAVAILABLE' });
  } catch (error) { databaseError = error; }
  const checked = validateLegend(candidate);
  const legend = checked.valid ? checked.legend : fallbackLegend();
  const source = checked.valid ? 'DATABASE' : 'VERSIONED_FALLBACK';
  const resolved = { ...legend, source, contentHash: contentHash(legend), validationErrors: checked.valid ? [] : checked.errors };
  logger.info({ message: 'Correction legend resolved', source, version: legend.version, contentHash: resolved.contentHash,
    validationErrors: resolved.validationErrors, databaseErrorCode: databaseError?.code || null });
  return resolved;
}

module.exports = { REQUIRED, FALLBACK_VERSION, DEFAULT_DEDUCTIONS, fallbackLegend, normalizeLegend, validateLegend, contentHash, resolveLegend };
