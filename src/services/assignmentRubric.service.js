const crypto = require('crypto');

const CUSTOM_RUBRIC_VERSION = 'assignment-custom-rubric-v1';
const stable = (value) => value == null ? null : Array.isArray(value) ? value.map(stable)
  : typeof value === 'object' ? Object.keys(value).sort().reduce((out, key) => {
    if (!['_id', '__v', 'createdAt', 'updatedAt'].includes(key)) out[key] = stable(value[key]);
    return out;
  }, {}) : value;

function parseLegacy(value) {
  if (typeof value !== 'string' || !value.trim()) return value;
  try { return JSON.parse(value); } catch { return { __invalidLegacyJson: true }; }
}

function rubricSource(assignment = {}) {
  if (assignment.rubrics != null) return { value: assignment.rubrics, source: 'rubrics' };
  if (assignment.rubric != null) return { value: parseLegacy(assignment.rubric), source: 'rubric' };
  return { value: null, source: null };
}

function normalizeAssignmentRubric(assignment = {}) {
  const source = rubricSource(assignment);
  if (source.value == null || source.value === '') return { status: 'absent', rubric: null, diagnostics: [] };
  const raw = source.value && typeof source.value === 'object' ? source.value : null;
  const diagnostics = [];
  if (!raw || raw.__invalidLegacyJson) diagnostics.push('Rubric must be a valid object or JSON object.');
  const rows = Array.isArray(raw?.criteria) ? raw.criteria : [];
  if (!rows.length) diagnostics.push('Rubric must contain at least one criterion.');
  const prepared = rows.map((row, index) => {
    const title = String(row?.name || row?.title || '').trim();
    const weight = Number(row?.weight);
    const rawLevels = Array.isArray(row?.levels) ? row.levels.map((level) => ({
      title: String(level?.title || '').trim(),
      percentage: Number(level?.score ?? level?.percentage),
      description: String(level?.description || '').trim()
    })) : [];
    const maximumLevel = Math.max(...rawLevels.map((level) => level.percentage).filter(Number.isFinite), 0);
    const levels = rawLevels.map((level) => ({
      ...level,
      percentage: maximumLevel > 0 ? Math.round((level.percentage / maximumLevel) * 10000) / 100 : level.percentage
    }));
    if (!title) diagnostics.push(`Criterion ${index + 1} requires a title.`);
    if (!Number.isFinite(weight) || weight <= 0) diagnostics.push(`Criterion "${title || index + 1}" requires a positive weight.`);
    if (levels.length < 2) diagnostics.push(`Criterion "${title || index + 1}" requires at least two performance levels.`);
    if (levels.some((level) => !level.title || !level.description || !Number.isFinite(level.percentage)))
      diagnostics.push(`Criterion "${title || index + 1}" requires a title, percentage, and description for every level.`);
    return { id: `criterion-${index + 1}`, title, weight, levels };
  });
  if (diagnostics.length) return { status: 'invalid', rubric: null, diagnostics, source: source.source };
  const weightTotal = prepared.reduce((sum, row) => sum + row.weight, 0);
  const criteria = prepared.map((row) => ({
    ...row,
    weight: Math.round((row.weight / weightTotal) * 1000000) / 10000,
    levels: row.levels.map((level) => ({ ...level, percentage: Math.max(0, Math.min(100, level.percentage)) }))
  }));
  const normalizedTotal = criteria.reduce((sum, row) => sum + row.weight, 0);
  criteria[criteria.length - 1].weight = Math.round((criteria[criteria.length - 1].weight + 100 - normalizedTotal) * 10000) / 10000;
  const rubric = Object.freeze({
    version: CUSTOM_RUBRIC_VERSION,
    source: source.source,
    title: String(raw.title || assignment.title || 'Assignment rubric').trim(),
    totalPoints: Number.isFinite(Number(raw.totalPoints)) && Number(raw.totalPoints) > 0 ? Number(raw.totalPoints) : 100,
    criteria: Object.freeze(criteria.map(Object.freeze))
  });
  return { status: 'valid', rubric, diagnostics: [], source: source.source };
}

function hashNormalizedRubric(result) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(result?.rubric || null))).digest('hex');
}

function calculateCustomRubricScore(rubric, assessments) {
  const assessmentList = Array.isArray(assessments) ? assessments : [];
  const knownIds = new Set(rubric.criteria.map((criterion) => criterion.id));
  const byId = new Map();
  for (const item of assessmentList) {
    const criterionId = String(item?.criterionId || '');
    if (!knownIds.has(criterionId))
      throw Object.assign(new Error(`Unknown custom rubric criterion ${criterionId || '(missing)'}`),
        { code: 'CUSTOM_RUBRIC_CRITERION_UNKNOWN' });
    if (byId.has(criterionId))
      throw Object.assign(new Error(`Duplicate assessment for ${criterionId}`),
        { code: 'CUSTOM_RUBRIC_ASSESSMENT_DUPLICATE' });
    byId.set(criterionId, item);
  }
  const criteria = rubric.criteria.map((criterion) => {
    const item = byId.get(criterion.id);
    if (!item) throw Object.assign(new Error(`Missing assessment for ${criterion.title}`), { code: 'CUSTOM_RUBRIC_ASSESSMENT_INCOMPLETE' });
    const selectedLevel = String(item.levelTitle || item.selectedLevel || '');
    const configuredLevel = criterion.levels.find((level) => level.title === selectedLevel);
    if (!configuredLevel)
      throw Object.assign(new Error(`Unknown selected level "${selectedLevel}" for ${criterion.title}`),
        { code: 'CUSTOM_RUBRIC_LEVEL_INVALID' });
    const returnedPercentage = item.percentage ?? item.scorePercent;
    if (returnedPercentage !== undefined
      && (!Number.isFinite(Number(returnedPercentage))
        || Number(returnedPercentage) !== configuredLevel.percentage))
      throw Object.assign(new Error(`Returned percentage does not match selected level for ${criterion.title}`),
        { code: 'CUSTOM_RUBRIC_PERCENTAGE_MISMATCH' });
    const configuredLevelPercentage = configuredLevel.percentage;
    const weightedPoints = Math.round((criterion.weight * configuredLevelPercentage / 100) * 100) / 100;
    const evidence = Array.isArray(item.evidence) ? item.evidence : [];
    const evidenceIds = evidence.map((entry) => String(entry?.evidenceId || entry?.id || '')).filter(Boolean);
    return {
      criterionId: criterion.id,
      title: criterion.title,
      normalizedWeight: criterion.weight,
      selectedLevel,
      configuredLevelPercentage,
      weightedPoints,
      comment: String(item.comment || ''),
      evidenceIds,
      // Compatibility aliases for clients that consumed the first custom-rubric contract.
      weight: criterion.weight,
      percentage: configuredLevelPercentage,
      levelTitle: selectedLevel,
      evidence
    };
  });
  const overallScore = Math.round(criteria.reduce((sum, item) => sum + item.weightedPoints, 0) * 100) / 100;
  return { overallScore: Math.max(0, Math.min(100, overallScore)), criteria };
}

function validateAssignmentRubricInput(raw, designer = false) {
  if (raw == null) return [];
  const errors = [];
  const rows = raw.criteria;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 100) return ['Rubric requires 1–100 criteria.'];
  if (raw.totalPoints !== 100) errors.push('totalPoints must equal 100.');
  const names = new Set();
  let sum = 0;
  for (const row of rows) {
    const name = String(row?.name || row?.title || '').trim().toLowerCase();
    if (!name || names.has(name)) errors.push('Criterion names must be non-empty and unique.');
    names.add(name);
    if (typeof row?.weight !== 'number' || !Number.isFinite(row.weight) || row.weight <= 0) errors.push('Weights must be positive finite numbers.');
    sum += row?.weight;
    const levels = designer ? raw.levels : row?.levels;
    if (!Array.isArray(levels) || levels.length < 2 || levels.length > 10) {
      errors.push('Each criterion requires 2–10 performance levels.');
      continue;
    }
    const levelNames = new Set();
    let maximum = 0;
    levels.forEach((level, index) => {
      const title = String(level?.title || '').trim().toLowerCase();
      const score = designer ? level?.maxPoints : level?.score;
      const description = designer ? row?.cells?.[index] : level?.description;
      if (!title || levelNames.has(title)) errors.push('Performance level titles must be non-empty and unique.');
      levelNames.add(title);
      if (typeof score !== 'number' || !Number.isFinite(score) || score < 0) errors.push('Level points must be finite and non-negative.');
      maximum = Math.max(maximum, score);
      if (typeof description !== 'string' || !description.trim()) errors.push('Every performance level requires a description.');
    });
    if (!(maximum > 0)) errors.push('Performance levels require a positive maximum.');
    if (designer && (!Array.isArray(row?.cells) || row.cells.length !== levels.length)) errors.push('Cells must align exactly with levels.');
    if (!designer && Array.isArray(rows[0]?.levels) && JSON.stringify(levels.map(l => [l?.title, l?.score])) !== JSON.stringify(rows[0].levels.map(l => [l?.title, l?.score]))) errors.push('Criteria must use aligned performance levels.');
  }
  if (Math.abs(sum - 100) > 1e-8 || !Number.isFinite(sum)) errors.push('Weights must total exactly 100.');
  return [...new Set(errors)];
}

module.exports = { CUSTOM_RUBRIC_VERSION, normalizeAssignmentRubric, hashNormalizedRubric, calculateCustomRubricScore, validateAssignmentRubricInput };
