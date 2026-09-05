const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 1000;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function objectFrom(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function designerToRubrics(designer) {
  const levels = Array.isArray(designer?.levels) ? designer.levels : [];
  const criteria = Array.isArray(designer?.criteria) ? designer.criteria : [];
  if (!levels.length || !criteria.length) return null;

  return {
    totalPoints: Number(designer.totalPoints) || 100,
    criteria: criteria.map((criterion) => ({
      name: String(criterion?.name || criterion?.title || '').trim(),
      weight: Number(criterion?.weight),
      levels: levels.map((level, index) => ({
        title: String(level?.title || level?.name || '').trim(),
        score: Number(level?.maxPoints ?? level?.score),
        description: String(
          Array.isArray(criterion?.cells) ? criterion.cells[index]
            : Array.isArray(criterion?.descriptions) ? criterion.descriptions[index] : ''
        ).trim()
      }))
    }))
  };
}

function normalizeRubricData(value) {
  const input = objectFrom(value);
  if (!input) return null;
  const source = Array.isArray(input.criteria)
    && input.criteria.some((criterion) => Array.isArray(criterion?.levels))
    ? input
    : designerToRubrics(input);
  if (!source || !Array.isArray(source.criteria)) return null;

  return {
    totalPoints: Number(source.totalPoints) || 100,
    criteria: source.criteria.map((criterion) => ({
      name: String(criterion?.name || criterion?.title || '').trim(),
      weight: Number(criterion?.weight),
      levels: (Array.isArray(criterion?.levels) ? criterion.levels : []).map((level) => ({
        title: String(level?.title || level?.name || '').trim(),
        score: Number(level?.score ?? level?.maxPoints),
        description: String(level?.description || '').trim()
      }))
    }))
  };
}

function normalizeRubricFromAssignment(assignment) {
  if (assignment?.rubrics) return normalizeRubricData(assignment.rubrics);
  return normalizeRubricData(assignment?.rubric);
}

function validateRubricData(rubricData) {
  const errors = [];
  if (!rubricData) return ['Rubric must be a valid object.'];
  if (!Number.isFinite(rubricData.totalPoints) || rubricData.totalPoints <= 0 || rubricData.totalPoints > 10000) {
    errors.push('Rubric total points must be a positive number no greater than 10000.');
  }
  const criteria = Array.isArray(rubricData.criteria) ? rubricData.criteria : [];
  if (criteria.length < 3 || criteria.length > 100) {
    errors.push('Rubric must contain between 3 and 100 criteria.');
  }
  criteria.forEach((criterion, criterionIndex) => {
    const label = `Criterion ${criterionIndex + 1}`;
    if (!criterion.name || criterion.name.length > 200) errors.push(`${label} requires a title of at most 200 characters.`);
    if (!Number.isFinite(criterion.weight) || criterion.weight <= 0) errors.push(`${label} requires a positive weight.`);
    const levels = Array.isArray(criterion.levels) ? criterion.levels : [];
    if (levels.length < 2 || levels.length > 5) errors.push(`${label} must contain between 2 and 5 levels.`);
    levels.forEach((level, levelIndex) => {
      if (!level.title || level.title.length > 120) errors.push(`${label}, level ${levelIndex + 1} requires a title.`);
      if (!Number.isFinite(level.score) || level.score < 0) errors.push(`${label}, level ${levelIndex + 1} requires a non-negative score.`);
      if (!level.description || level.description.length > 4000) errors.push(`${label}, level ${levelIndex + 1} requires a description.`);
    });
  });
  const weightTotal = criteria.reduce((sum, criterion) => sum + (Number.isFinite(criterion.weight) ? criterion.weight : 0), 0);
  if (Math.abs(weightTotal - 100) > 0.0001) errors.push('Rubric criterion weights must total 100.');
  const levelCount = criteria[0]?.levels?.length;
  if (criteria.some((criterion) => criterion.levels.length !== levelCount)) errors.push('Every criterion must use the same levels.');
  return [...new Set(errors)];
}

function normalizeMetadata(body = {}, { partial = false } = {}) {
  const output = {};
  const errors = [];
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'name')) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) errors.push('name is required');
    else if (name.length > MAX_NAME_LENGTH) errors.push(`name must be at most ${MAX_NAME_LENGTH} characters`);
    else output.name = name;
  }
  for (const [field, max] of [['description', MAX_DESCRIPTION_LENGTH], ['writingType', 120]]) {
    if (!partial || Object.prototype.hasOwnProperty.call(body, field)) {
      if (body[field] == null || body[field] === '') output[field] = undefined;
      else if (typeof body[field] !== 'string') errors.push(`${field} must be a string`);
      else if (body[field].trim().length > max) errors.push(`${field} must be at most ${max} characters`);
      else output[field] = body[field].trim() || undefined;
    }
  }
  return { value: output, errors };
}

module.exports = {
  cloneRubricData: clone,
  normalizeRubricData,
  normalizeRubricFromAssignment,
  normalizeMetadata,
  validateRubricData
};
