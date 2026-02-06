function safeNumber(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

function clamp0100(n) {
  return Math.max(0, Math.min(100, n));
}

function normalizeText(text) {
  return typeof text === 'string' ? text : '';
}

function wordCount(text) {
  const t = normalizeText(text).trim();
  if (!t) return 0;
  return t.split(/\s+/).filter(Boolean).length;
}

function sentenceCount(text) {
  const t = normalizeText(text).trim();
  if (!t) return 0;
  const parts = t.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  return parts.length || 0;
}

function paragraphCount(text) {
  const t = normalizeText(text).trim();
  if (!t) return 0;
  return t.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean).length || 0;
}

function groupKeyFromIssue(issue) {
  const k = (issue && (issue.groupKey || issue.groupLabel || issue.category) ? String(issue.groupKey || issue.groupLabel || issue.category) : '').toLowerCase();
  if (!k) return 'other';
  if (k.includes('spell')) return 'spelling';
  if (k.includes('gram')) return 'grammar';
  if (k.includes('typ')) return 'typography';
  if (k.includes('style')) return 'style';
  return k;
}

function computeIssueStats(issues) {
  const stats = { spelling: 0, grammar: 0, typography: 0, style: 0, other: 0, total: 0 };
  for (const issue of Array.isArray(issues) ? issues : []) {
    const key = groupKeyFromIssue(issue);
    if (key in stats) {
      stats[key] += 1;
    } else {
      stats.other += 1;
    }
    stats.total += 1;
  }
  return stats;
}

function severityMultiplier(issue) {
  // LanguageTool doesn't always provide explicit severity; derive a stable multiplier based on type.
  const key = groupKeyFromIssue(issue);
  if (key === 'grammar') return 1.35;
  if (key === 'typography') return 0.9;
  if (key === 'style') return 0.75;
  if (key === 'spelling') return 1.05;
  return 0.65;
}

function buildTopIssueItems(issues, maxItems) {
  const out = [];
  for (const i of Array.isArray(issues) ? issues : []) {
    if (!i) continue;
    const symbol = typeof i.symbol === 'string' ? i.symbol : '';
    const message = typeof i.message === 'string' ? i.message : (typeof i.description === 'string' ? i.description : '');
    const suggestion = typeof i.suggestedText === 'string' ? i.suggestedText : (typeof i.suggestion === 'string' ? i.suggestion : '');
    const groupKey = groupKeyFromIssue(i);
    if (!message && !symbol && !suggestion) continue;

    out.push({
      groupKey,
      symbol,
      message,
      suggestion
    });
    if (out.length >= (typeof maxItems === 'number' ? maxItems : 5)) break;
  }
  return out;
}

function computePenaltyPer100Words(issues, wc) {
  const perWordNorm = wc > 0 ? (100 / wc) : 0;

  // Diminishing returns: repeated issues contribute less (sqrt).
  const grouped = new Map();
  for (const i of Array.isArray(issues) ? issues : []) {
    const key = groupKeyFromIssue(i);
    grouped.set(key, (grouped.get(key) || 0) + 1);
  }

  let penalty = 0;
  for (const [key, count] of grouped.entries()) {
    const baseIssue = { groupKey: key };
    const mult = severityMultiplier(baseIssue);
    const diminished = Math.sqrt(Math.max(0, count));
    penalty += diminished * mult;
  }

  // Normalize for text length.
  return penalty * perWordNorm;
}

function computeCategoryScore({ wc, basePenalty, weightBias }) {
  // Convert penalty to a 0..100 score. The bias controls strictness per category.
  const bias = safeNumber(weightBias, 1);
  const score = 100 - basePenalty * bias;
  return clamp0100(Math.round(score * 10) / 10);
}

function gradeFromOverall(overallScore) {
  const s = safeNumber(overallScore, 0);
  if (s >= 90) return { gradeLetter: 'A', qualitativeLabel: 'Excellent' };
  if (s >= 80) return { gradeLetter: 'B', qualitativeLabel: 'Good' };
  if (s >= 70) return { gradeLetter: 'C', qualitativeLabel: 'Satisfactory' };
  if (s >= 60) return { gradeLetter: 'D', qualitativeLabel: 'Needs Improvement' };
  return { gradeLetter: 'F', qualitativeLabel: 'Unsatisfactory' };
}

function computeRubricScores({ text, issues }) {
  const t = normalizeText(text);
  const wc = wordCount(t);
  const sc = sentenceCount(t);
  const pc = paragraphCount(t);

  const issueStats = computeIssueStats(issues);

  const grammarIssues = (Array.isArray(issues) ? issues : []).filter((i) => {
    const k = groupKeyFromIssue(i);
    return k === 'grammar' || k === 'typography' || k === 'spelling';
  });

  const structureIssues = (Array.isArray(issues) ? issues : []).filter((i) => {
    const k = groupKeyFromIssue(i);
    return k === 'style' || k === 'typography';
  });

  const vocabularyIssues = (Array.isArray(issues) ? issues : []).filter((i) => {
    const k = groupKeyFromIssue(i);
    return k === 'style' || k === 'other';
  });

  // Content relevance is hard to infer from LanguageTool; use "other" + length/paragraph heuristics.
  const contentIssues = (Array.isArray(issues) ? issues : []).filter((i) => groupKeyFromIssue(i) === 'other');

  const grammarPenalty = computePenaltyPer100Words(grammarIssues, wc);
  const structurePenalty = computePenaltyPer100Words(structureIssues, wc);
  const vocabularyPenalty = computePenaltyPer100Words(vocabularyIssues, wc);
  const contentPenaltyFromIssues = computePenaltyPer100Words(contentIssues, wc);

  // Deterministic structure/content heuristics (no AI, no guesswork):
  // - very short answers => content/task penalty
  // - zero paragraphs (no \n\n) but long text is OK
  const shortnessPenalty = wc === 0 ? 100 : wc < 40 ? (40 - wc) * 0.9 : 0;
  const paragraphPenalty = wc >= 80 && pc <= 1 ? 8 : 0;
  const sentencePenalty = wc >= 80 && sc <= 2 ? 10 : 0;

  const contentPenalty = contentPenaltyFromIssues * 1.1 + shortnessPenalty + paragraphPenalty;
  const taskPenalty = shortnessPenalty + sentencePenalty;

  const grammarScore = computeCategoryScore({ wc, basePenalty: grammarPenalty, weightBias: 1.25 });
  const structureScore = computeCategoryScore({ wc, basePenalty: structurePenalty + paragraphPenalty * 0.6 + sentencePenalty * 0.4, weightBias: 1.1 });
  const contentScore = computeCategoryScore({ wc, basePenalty: contentPenalty, weightBias: 0.9 });
  const vocabularyScore = computeCategoryScore({ wc, basePenalty: vocabularyPenalty, weightBias: 0.85 });
  const taskAchievementScore = computeCategoryScore({ wc, basePenalty: taskPenalty, weightBias: 1.0 });

  const weights = {
    grammar: 0.25,
    structure: 0.25,
    content: 0.25,
    vocabulary: 0.15,
    task: 0.10
  };

  const overall =
    grammarScore * weights.grammar +
    structureScore * weights.structure +
    contentScore * weights.content +
    vocabularyScore * weights.vocabulary +
    taskAchievementScore * weights.task;

  const overallScore = clamp0100(Math.round(overall * 10) / 10);
  const grade = gradeFromOverall(overallScore);

  return {
    wordCount: wc,
    sentenceCount: sc,
    paragraphCount: pc,
    issueStats,
    grammarScore,
    structureScore,
    contentScore,
    vocabularyScore,
    taskAchievementScore,
    overallScore,
    gradeLetter: grade.gradeLetter,
    qualitativeLabel: grade.qualitativeLabel,
    scoringBreakdown: {
      weights,
      penaltiesPer100Words: {
        grammar: Math.round(grammarPenalty * 100) / 100,
        structure: Math.round(structurePenalty * 100) / 100,
        content: Math.round(contentPenaltyFromIssues * 100) / 100,
        vocabulary: Math.round(vocabularyPenalty * 100) / 100,
        taskAchievement: Math.round(taskPenalty * 100) / 100
      },
      deterministicHeuristics: {
        shortnessPenalty: Math.round(shortnessPenalty * 10) / 10,
        paragraphPenalty: Math.round(paragraphPenalty * 10) / 10,
        sentencePenalty: Math.round(sentencePenalty * 10) / 10
      }
    }
  };
}

function buildStructuredFeedback({ text, issues }) {
  const stats = computeIssueStats(issues);
  const wc = wordCount(text);

  const issuesList = Array.isArray(issues) ? issues : [];
  const grammarIssues = issuesList.filter((i) => {
    const k = groupKeyFromIssue(i);
    return k === 'grammar' || k === 'typography' || k === 'spelling';
  });
  const structureIssues = issuesList.filter((i) => {
    const k = groupKeyFromIssue(i);
    return k === 'style' || k === 'typography';
  });
  const contentIssues = issuesList.filter((i) => groupKeyFromIssue(i) === 'other');
  const vocabIssues = issuesList.filter((i) => {
    const k = groupKeyFromIssue(i);
    return k === 'style' || k === 'other';
  });

  const grammarTop = buildTopIssueItems(grammarIssues, 6);
  const structureTop = buildTopIssueItems(structureIssues, 6);
  const contentTop = buildTopIssueItems(contentIssues, 6);
  const vocabTop = buildTopIssueItems(vocabIssues, 6);

  const summarize = (label, count) => {
    if (!wc) return `${label}: No text extracted.`;
    if (!count) return `${label}: No issues detected.`;
    return `${label}: Detected ${count} issue${count === 1 ? '' : 's'} based on automated checks.`;
  };

  return {
    grammarFeedback: {
      summary: summarize('Grammar & Mechanics', stats.grammar + stats.spelling + stats.typography),
      keyIssues: grammarTop,
      sentenceNotes: []
    },
    structureFeedback: {
      summary: summarize('Structure & Organization', stats.style + stats.typography),
      coherenceIssues: structureTop,
      paragraphNotes: []
    },
    contentFeedback: {
      summary: summarize('Content & Relevance', stats.other),
      relevanceIssues: contentTop,
      ideaDevelopmentNotes: []
    },
    vocabularyFeedback: {
      summary: summarize('Vocabulary & Style', stats.style + stats.other),
      wordChoiceIssues: vocabTop,
      repetitionIssues: []
    }
  };
}

function applyTeacherOverrides({ baseScores, override }) {
  if (!override || typeof override !== 'object') {
    return { effectiveScores: baseScores, applied: false };
  }

  const pick = (key) => {
    const v = override[key];
    const n = safeNumber(v, NaN);
    return Number.isFinite(n) ? clamp0100(n) : undefined;
  };

  const effective = {
    ...baseScores,
    grammarScore: typeof pick('grammarScore') === 'number' ? pick('grammarScore') : baseScores.grammarScore,
    structureScore: typeof pick('structureScore') === 'number' ? pick('structureScore') : baseScores.structureScore,
    contentScore: typeof pick('contentScore') === 'number' ? pick('contentScore') : baseScores.contentScore,
    vocabularyScore: typeof pick('vocabularyScore') === 'number' ? pick('vocabularyScore') : baseScores.vocabularyScore,
    taskAchievementScore: typeof pick('taskAchievementScore') === 'number' ? pick('taskAchievementScore') : baseScores.taskAchievementScore,
    overallScore: typeof pick('overallScore') === 'number' ? pick('overallScore') : baseScores.overallScore
  };

  const grade = gradeFromOverall(effective.overallScore);
  effective.gradeLetter = grade.gradeLetter;
  effective.qualitativeLabel = grade.qualitativeLabel;

  const applied = ['grammarScore', 'structureScore', 'contentScore', 'vocabularyScore', 'taskAchievementScore', 'overallScore']
    .some((k) => typeof pick(k) === 'number');

  return { effectiveScores: effective, applied };
}

function computeAcademicEvaluation({ text, issues, teacherOverrideScores }) {
  const scores = computeRubricScores({ text, issues });
  const structuredFeedback = buildStructuredFeedback({ text, issues });

  const merged = applyTeacherOverrides({ baseScores: scores, override: teacherOverrideScores });

  return {
    rubric: scores,
    structuredFeedback,
    effectiveRubric: merged.effectiveScores,
    hasTeacherOverrides: merged.applied
  };
}

module.exports = {
  computeAcademicEvaluation
};
