function repairAiRubric(data) {
  if (!data || typeof data !== "object") return null;

  let levels = data.levels;
  let criteria = data.criteria;

  if (!Array.isArray(levels)) {
    if (levels && typeof levels === "object") {
      levels = Object.values(levels);
    } else {
      levels = [];
    }
  }

  levels = levels.map((l) => ({
    title: String((l && l.title) || "Level"),
    maxPoints: Number((l && (l.maxPoints || l.score)) || 0)
  }));

  if (!Array.isArray(criteria)) {
    if (criteria && typeof criteria === "object") {
      criteria = Object.values(criteria);
    } else {
      criteria = [];
    }
  }

  criteria = criteria.map((c) => {
    let cells = (c && (c.cells || c.descriptions || c.levels)) || [];

    if (!Array.isArray(cells)) {
      if (cells && typeof cells === "object") {
        cells = Object.values(cells);
      } else {
        cells = [];
      }
    }

    return {
      title: String((c && (c.title || c.name)) || "Criteria"),
      cells: cells.map((x) => String(x))
    };
  });

  return {
    title: String(data.title || "Rubric"),
    levels,
    criteria
  };
}

module.exports = { repairAiRubric };
