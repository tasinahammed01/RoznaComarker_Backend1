function normalizeLevels(levels) {
  if (!levels) return [];

  if (Array.isArray(levels)) {
    return levels;
  }

  if (typeof levels === "object") {
    return Object.values(levels);
  }

  return [];
}

function normalizeRubricDesignerPayload(payload) {
  if (!payload) {
    return { levels: [], criteria: [] };
  }

  const normalized = { ...payload };

  normalized.levels = normalizeLevels(payload.levels);

  if (!Array.isArray(normalized.criteria)) {
    normalized.criteria = [];
  }

  return normalized;
}

module.exports = {
  normalizeRubricDesignerPayload
};
