'use strict';
// Deterministic "does this file look like a rubric?" check, run once when an assignment-scope file becomes ready. No AI, no cost.
// It only decides whether to ASK the teacher ("This file looks like a rubric. Use it as the main rubric?"); nothing is applied automatically.
// Signals: the word rubric, criteria and descriptor headings, performance-level names, point/mark patterns, and table-like rows.

const DETECTION_VERSION = 'reference-rubric-detect-v1';
const SAMPLE_CHARS = 20000;
const LEVEL_WORDS = ['exemplary', 'excellent', 'outstanding', 'exceeds', 'proficient', 'accomplished', 'meets', 'good', 'satisfactory', 'developing',
  'approaching', 'emerging', 'beginning', 'fair', 'limited', 'poor', 'needs improvement', 'below', 'unsatisfactory', 'novice', 'competent', 'advanced'];
const escape = word => word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const LEVEL_RE = new RegExp(`\\b(${LEVEL_WORDS.map(escape).join('|')})\\b`, 'giu');
const POINTS_RE = /\b\d{1,3}\s*(?:-|to)\s*\d{1,3}\s*(?:points?|pts|marks?)\b|\b\d{1,3}\s*(?:points?|pts|marks?)\b|\(\s*\d{1,3}\s*\)|\b\d{1,3}\s*\/\s*\d{1,3}\b/giu;

/** { looksLikeRubric, confidence: 'high'|'medium'|'low', score (0-1), signals: [code], version }. Signals are codes, never file text. */
function detectRubric(text) {
  const sample = String(text || '').slice(0, SAMPLE_CHARS);
  const lower = sample.toLowerCase();
  const lines = sample.split('\n').map(line => line.trim()).filter(Boolean);
  const signals = [];
  let score = 0;
  const add = (code, weight) => { signals.push(code); score += weight; };

  if (/\brubrics?\b/u.test(lower)) add('RUBRIC_WORD', 0.3);
  if (/\b(criteria|criterion)\b/u.test(lower)) add('CRITERIA_HEADING', 0.2);
  if (/\b(descriptors?|performance levels?|levels? of performance|scoring guide|marking (?:scheme|criteria|guide)|band descriptors?)\b/u.test(lower))
    add('DESCRIPTOR_HEADING', 0.15);
  const levels = new Set((lower.match(LEVEL_RE) || []).map(word => word.toLowerCase()));
  if (levels.size >= 3) add('LEVEL_NAMES', 0.25); else if (levels.size === 2) add('SOME_LEVEL_NAMES', 0.1);
  const points = (sample.match(POINTS_RE) || []).length;
  if (points >= 4) add('POINT_VALUES', 0.2); else if (points >= 2) add('SOME_POINT_VALUES', 0.08);
  // Table-like: many short lines (cells), or rows with several "|" or tab-separated cells.
  const cellRows = lines.filter(line => (line.match(/\|/gu) || []).length >= 2 || (line.match(/\t/gu) || []).length >= 2).length;
  const shortLines = lines.filter(line => line.length <= 60).length;
  if (cellRows >= 3 || (lines.length >= 12 && shortLines / lines.length >= 0.6)) add('TABLE_STRUCTURE', 0.1);

  score = Math.min(1, Math.round(score * 100) / 100);
  const confidence = score >= 0.7 ? 'high' : score >= 0.45 ? 'medium' : 'low';
  return { looksLikeRubric: score >= 0.45, confidence, score, signals, version: DETECTION_VERSION };
}

module.exports = { detectRubric, DETECTION_VERSION };
