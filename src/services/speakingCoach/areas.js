'use strict';
// Speaking Coach: which rubric areas are practised, and with which task type. Pure functions on the stored (final) assessment, no AI.
// - snapshotFromFeedback: every rubric criterion of the stored result, the level reached, the criterion comment and its levels (as percents).
// - weakAreas: criteria that do not pass under the pass rule (policy.passRule, D3), weakest first, then heavier first, then rubric order; at most 3.
// - planTasks: one task per weak area (two for a single weak area). The type follows the criterion: the default speaking rubric by its ids, a
//   custom rubric by the criterion title.
const { isPassingLevel, passRule } = require('./policy');

const MAX_AREAS = 3;
const MAX_TARGETS = 4;
const MIN_TARGETS = 2;
const clip = (value, max) => String(value ?? '').trim().slice(0, max);

/** The criteria snapshot of a stored speaking result, or null when it has no rubric or no criterion scores. */
function snapshotFromFeedback(feedback) {
  const rubric = feedback?.sourceRubric;
  const scores = feedback?.customRubricScores?.criteria;
  if (!Array.isArray(rubric?.criteria) || !rubric.criteria.length || !Array.isArray(scores) || !scores.length) return null;
  const byId = new Map(scores.map(item => [String(item?.criterionId || ''), item]));
  const criteria = rubric.criteria.map(criterion => {
    const score = byId.get(String(criterion.id));
    const percent = Number(score?.configuredLevelPercentage);
    return { criterionId: clip(criterion.id, 120), title: clip(criterion.title, 200), weight: Number.isFinite(Number(criterion.weight)) ? Number(criterion.weight) : null,
      levelTitle: clip(score?.selectedLevel, 120), levelPercent: score && Number.isFinite(percent) ? percent : null, comment: clip(score?.comment, 600),
      levels: (criterion.levels || []).map(level => ({ title: clip(level.title, 120), percent: Number(level.percentage), description: clip(level.description, 600) })) };
  });
  return criteria.some(c => c.levelPercent !== null) ? criteria : null;
}

/** Criteria that do not pass, weakest first (then heavier first, then rubric order); at most three. */
function weakAreas(criteria, passPercent) {
  return (Array.isArray(criteria) ? criteria : []).map((criterion, index) => ({ criterion, index }))
    .filter(({ criterion }) => criterion.levelPercent !== null && !isPassingLevel(criterion.levelPercent, criterion.levels, passPercent))
    .sort((a, b) => a.criterion.levelPercent - b.criterion.levelPercent || (b.criterion.weight || 0) - (a.criterion.weight || 0) || a.index - b.index)
    .slice(0, MAX_AREAS).map(({ criterion }) => criterion);
}

/** Target words for a vocabulary swap: the suggested words of the student's vocabulary corrections (1 to 3 plain words), unique, at most four. */
function vocabTargets(corrections) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(corrections) ? corrections : []) {
    if (item?.category !== 'VOCABULARY') continue;
    const words = String(item.suggestedText || '').trim().replace(/\s+/gu, ' ');
    if (!words || words.length > 40 || !/^[\p{L}][\p{L}' -]*$/u.test(words) || words.split(' ').length > 3) continue;
    const key = words.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key); out.push(words);
    if (out.length === MAX_TARGETS) break;
  }
  return out;
}

/** The task type for one criterion. */
function primaryType(criterion, targets) {
  const id = String(criterion.criterionId || '');
  const title = String(criterion.title || '');
  const vocabulary = id === 'speaking-vocabulary' || (!id.startsWith('speaking-') && /vocab|word choice|lexi/iu.test(title));
  if (id === 'speaking-fluency' || (!id.startsWith('speaking-') && /fluen/iu.test(title))) return 'fluency_drill';
  if (vocabulary) return targets.length >= MIN_TARGETS ? 'vocab_swap' : 'repeat_improve';
  if (id === 'speaking-task' || (!id.startsWith('speaking-') && /\btask\b|content|ideas?\b/iu.test(title))) return 'follow_up';
  return 'repeat_improve';
}

/** The planned tasks (order, type, criterion, area label, targets, pass rule). One weak area: two tasks of different types. */
function planTasks(weak, { vocabTargets: targets = [], passPercent }) {
  const plan = [];
  const add = (criterion, type) => plan.push({ order: plan.length + 1, type, criterionId: criterion.criterionId, areaLabel: criterion.title,
    targets: type === 'vocab_swap' ? [...targets] : [], passRule: passRule(criterion.levels, passPercent) });
  for (const criterion of weak) add(criterion, primaryType(criterion, targets));
  if (weak.length === 1) add(weak[0], plan[0].type === 'repeat_improve' ? 'follow_up' : 'repeat_improve');
  return plan;
}

module.exports = { snapshotFromFeedback, weakAreas, vocabTargets, planTasks, primaryType, MAX_AREAS, MIN_TARGETS };
