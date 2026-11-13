'use strict';
// Converts a reference file's text into the app's rubric designer format with the EXISTING AI rubric parser (rubricAIParser.service), then
// validates it with the same rule the rubric editor uses (validateAssignmentRubricInput, designer mode). Free: no credits (owner decision).
// The result is a draft for the teacher to review and edit; nothing is saved here. When conversion fails, the file stays normal reference
// material and the teacher is told why.
const { validateAssignmentRubricInput } = require('../assignmentRubric.service');

class RubricConversionError extends Error {
  constructor(code, message, issues = []) { super(message); this.name = 'RubricConversionError'; this.code = code; this.issues = issues; }
}
const FAILED = 'This file could not be turned into a rubric. It is still used as background material for marking.';
const UNAVAILABLE = 'Rubric conversion is unavailable right now. Please try again in a few minutes.';
const clean = (value, max) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, max);

/** Whole-number weights adding up to exactly 100: the parsed weights when they already do, otherwise an equal split. */
function weightsFor(criteria) {
  const given = criteria.map(row => Number(row.weight));
  if (given.every(weight => Number.isFinite(weight) && weight > 0) && Math.abs(given.reduce((a, b) => a + b, 0) - 100) < 1e-8)
    return { weights: given, equalized: false };
  const base = Math.floor(100 / criteria.length), extra = 100 - base * criteria.length;
  return { weights: criteria.map((_, index) => base + (index < extra ? 1 : 0)), equalized: true };
}

/** Parser output ({ title, levels: [{ name, score }], criteria: [{ title, weight, descriptions }] }) to designer format, plus review notes. */
function toDesigner(parsed, fallbackTitle) {
  const levels = (Array.isArray(parsed?.levels) ? parsed.levels : []).map(level => ({ title: clean(level?.name ?? level?.title, 80),
    maxPoints: Number(level?.score ?? level?.maxPoints) }));
  const rows = (Array.isArray(parsed?.criteria) ? parsed.criteria : []).filter(row => clean(row?.title ?? row?.name, 120));
  if (!levels.length || !rows.length) return { designer: null, notes: [] };
  const { weights, equalized } = weightsFor(rows);
  const designer = {
    title: clean(parsed?.title, 120) || fallbackTitle,
    totalPoints: 100,
    levels,
    criteria: rows.map((row, index) => {
      const cells = Array.isArray(row?.descriptions) ? row.descriptions : Array.isArray(row?.cells) ? row.cells : [];
      return { title: clean(row?.title ?? row?.name, 120), weight: weights[index], cells: levels.map((_, i) => clean(cells[i], 1000)) };
    })
  };
  return { designer, notes: equalized ? ['WEIGHTS_SET_EQUALLY'] : [] };
}

/** { rubricDesigner, notes } or throws RubricConversionError (code REFERENCE_RUBRIC_CONVERSION_FAILED or REFERENCE_RUBRIC_AI_UNAVAILABLE). */
async function convertTextToRubric(text, { fallbackTitle = 'Rubric', parse = require('../rubricAIParser.service').parseRubricTextToJson } = {}) {
  let parsed;
  try { parsed = await parse({ text }); } catch (error) {
    const status = Number(error?.statusCode);
    if (status === 422 || status === 400) throw new RubricConversionError('REFERENCE_RUBRIC_CONVERSION_FAILED', FAILED, ['NO_RUBRIC_STRUCTURE']);
    throw new RubricConversionError('REFERENCE_RUBRIC_AI_UNAVAILABLE', UNAVAILABLE);
  }
  const { designer, notes } = toDesigner(parsed, fallbackTitle);
  if (!designer) throw new RubricConversionError('REFERENCE_RUBRIC_CONVERSION_FAILED', FAILED, ['NO_RUBRIC_STRUCTURE']);
  const issues = validateAssignmentRubricInput(designer, true);
  if (issues.length) throw new RubricConversionError('REFERENCE_RUBRIC_CONVERSION_FAILED', FAILED, issues);
  return { rubricDesigner: designer, notes };
}

module.exports = { convertTextToRubric, toDesigner, weightsFor, RubricConversionError };
