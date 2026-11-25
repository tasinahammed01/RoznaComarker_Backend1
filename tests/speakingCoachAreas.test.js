'use strict';
// Speaking Coach: which areas are practised and how (services/speakingCoach/areas.js, tasks.js). Pure functions, no database.
// - The snapshot of the stored result: every rubric criterion with the level reached and the criterion's levels.
// - Weak areas: criteria that do not pass under the pass rule (D3), weakest first, then by weight; at most three.
// - Task types: fluency -> fluency drill; vocabulary -> vocabulary swap (needs two target words from the vocabulary corrections, else repeat and
//   improve); task and content -> follow-up question; anything else (organisation, grammar, custom criteria) -> repeat and improve. One weak
//   area gets two tasks. Three-level, four-level and custom rubrics.
process.env.NODE_ENV = 'test';
const areas = require('../src/services/speakingCoach/areas');
const tasks = require('../src/services/speakingCoach/tasks');
const { DEFAULT_RUBRIC } = require('../src/services/audio/speakingRubric');
const { normalizeAssignmentRubric } = require('../src/services/assignmentRubric.service');

const rubricOf = data => normalizeAssignmentRubric({ rubrics: data, title: 'Synthetic rubric' }).rubric;
const DEFAULT = rubricOf(DEFAULT_RUBRIC);
/** The stored feedback shape: sourceRubric plus customRubricScores.criteria with one level per criterion. */
function feedbackFor(rubric, levelsById) {
  return { sourceRubric: rubric, customRubricScores: { criteria: rubric.criteria.map(c => {
    const level = c.levels.find(l => l.title === (levelsById[c.id] || c.levels[0].title));
    return { criterionId: c.id, title: c.title, selectedLevel: level.title, configuredLevelPercentage: level.percentage, comment: `Comment for ${c.title}.` };
  }) } };
}
const THREE_LEVELS = rubricOf({ criteria: [
  { id: 'c-ideas', name: 'Ideas', weight: 50, levels: [{ title: 'Strong', score: 3, description: 'Clear ideas.' }, { title: 'Fair', score: 2, description: 'Some ideas.' },
    { title: 'Weak', score: 1, description: 'Few ideas.' }] },
  { id: 'c-speech-flow', name: 'Fluency and flow', weight: 30, levels: [{ title: 'Strong', score: 3, description: 'Smooth.' },
    { title: 'Fair', score: 2, description: 'Some pauses.' }, { title: 'Weak', score: 1, description: 'Halting.' }] },
  { id: 'c-words', name: 'Word choice', weight: 20, levels: [{ title: 'Strong', score: 3, description: 'Varied.' }, { title: 'Fair', score: 2, description: 'Plain.' },
    { title: 'Weak', score: 1, description: 'Limited.' }] }
] });

describe('the snapshot of the stored result', () => {
  test('every criterion with its level, comment and levels (as percents)', () => {
    const snap = areas.snapshotFromFeedback(feedbackFor(DEFAULT, { 'speaking-grammar': 'Developing' }));
    expect(snap.map(c => c.criterionId)).toEqual(['speaking-task', 'speaking-organisation', 'speaking-grammar', 'speaking-vocabulary', 'speaking-fluency']);
    expect(snap[2]).toMatchObject({ criterionId: 'speaking-grammar', title: 'Grammar', levelTitle: 'Developing', levelPercent: 50, comment: 'Comment for Grammar.' });
    expect(snap[2].levels.map(l => [l.title, l.percent])).toEqual([['Excellent', 100], ['Good', 75], ['Developing', 50], ['Beginning', 25]]);
  });

  test('null when the result has no rubric or no criterion scores', () => {
    expect(areas.snapshotFromFeedback(null)).toBeNull();
    expect(areas.snapshotFromFeedback({ sourceRubric: DEFAULT })).toBeNull();
    expect(areas.snapshotFromFeedback({ customRubricScores: { criteria: [] } })).toBeNull();
  });
});

describe('weak areas', () => {
  test('4 levels: Developing and Beginning are weak, Good and Excellent are not; weakest first, then by weight', () => {
    const snap = areas.snapshotFromFeedback(feedbackFor(DEFAULT, { 'speaking-task': 'Good', 'speaking-organisation': 'Excellent',
      'speaking-grammar': 'Developing', 'speaking-vocabulary': 'Beginning', 'speaking-fluency': 'Developing' }));
    expect(areas.weakAreas(snap, 70).map(c => c.criterionId)).toEqual(['speaking-vocabulary', 'speaking-grammar', 'speaking-fluency']);
  });

  test('at most three areas', () => {
    const snap = areas.snapshotFromFeedback(feedbackFor(DEFAULT, Object.fromEntries(DEFAULT.criteria.map(c => [c.id, 'Beginning']))));
    expect(areas.weakAreas(snap, 70)).toHaveLength(3);
    expect(areas.weakAreas(snap, 70).map(c => c.criterionId)).toEqual(['speaking-task', 'speaking-organisation', 'speaking-grammar']);
  });

  test('3 levels (D3): the middle level passes, so only the lowest is weak', () => {
    const snap = areas.snapshotFromFeedback(feedbackFor(THREE_LEVELS, { 'c-ideas': 'Fair', 'c-speech-flow': 'Weak', 'c-words': 'Strong' }));
    expect(areas.weakAreas(snap, 70).map(c => c.criterionId)).toEqual(['c-speech-flow']);
  });

  test('nothing weak: an empty list', () => {
    const snap = areas.snapshotFromFeedback(feedbackFor(DEFAULT, Object.fromEntries(DEFAULT.criteria.map(c => [c.id, 'Good']))));
    expect(areas.weakAreas(snap, 70)).toEqual([]);
  });
});

describe('vocabulary targets from the corrections', () => {
  test('suggested words of vocabulary corrections only: short, unique, at most four', () => {
    const corrections = [{ category: 'VOCABULARY', suggestedText: 'on foot' }, { category: 'GRAMMAR', suggestedText: 'It has' },
      { category: 'VOCABULARY', suggestedText: 'On foot' }, { category: 'VOCABULARY', suggestedText: 'crowded' },
      { category: 'VOCABULARY', suggestedText: 'a very long suggestion with many words' }, { category: 'VOCABULARY', suggestedText: '' },
      { category: 'VOCABULARY', suggestedText: '<b>x</b>' }, { category: 'VOCABULARY', suggestedText: 'lively' }, { category: 'VOCABULARY', suggestedText: 'scenic' },
      { category: 'VOCABULARY', suggestedText: 'ancient' }];
    expect(areas.vocabTargets(corrections)).toEqual(['on foot', 'crowded', 'lively', 'scenic']);
  });
});

describe('task types', () => {
  const plan = (snapLevels, rubric = DEFAULT, targets = []) => {
    const weak = areas.weakAreas(areas.snapshotFromFeedback(feedbackFor(rubric, snapLevels)), 70);
    return areas.planTasks(weak, { vocabTargets: targets, passPercent: 70 });
  };

  test('the default rubric: fluency drill, vocabulary swap, follow-up question, repeat and improve', () => {
    const all = Object.fromEntries(DEFAULT.criteria.map(c => [c.id, 'Good']));
    expect(plan({ ...all, 'speaking-fluency': 'Beginning', 'speaking-vocabulary': 'Developing', 'speaking-task': 'Developing' }, DEFAULT, ['on foot', 'crowded'])
      .map(t => [t.criterionId, t.type])).toEqual([['speaking-fluency', 'fluency_drill'], ['speaking-task', 'follow_up'], ['speaking-vocabulary', 'vocab_swap']]);
    expect(plan({ ...all, 'speaking-grammar': 'Beginning', 'speaking-organisation': 'Developing' }).map(t => t.type)).toEqual(['repeat_improve', 'repeat_improve']);
  });

  test('vocabulary with fewer than two target words: repeat and improve instead of a swap', () => {
    const all = Object.fromEntries(DEFAULT.criteria.map(c => [c.id, 'Good']));
    const out = plan({ ...all, 'speaking-vocabulary': 'Beginning', 'speaking-grammar': 'Beginning' }, DEFAULT, ['on foot']);
    expect(out.find(t => t.criterionId === 'speaking-vocabulary').type).toBe('repeat_improve');
    expect(out.every(t => t.targets.length === 0)).toBe(true);
  });

  test('the swap carries its target words; one weak area gets two tasks of different types', () => {
    const all = Object.fromEntries(DEFAULT.criteria.map(c => [c.id, 'Good']));
    const out = plan({ ...all, 'speaking-vocabulary': 'Beginning' }, DEFAULT, ['on foot', 'crowded', 'lively']);
    expect(out.map(t => [t.order, t.type, t.criterionId])).toEqual([[1, 'vocab_swap', 'speaking-vocabulary'], [2, 'repeat_improve', 'speaking-vocabulary']]);
    expect(out[0].targets).toEqual(['on foot', 'crowded', 'lively']);
    const grammarOnly = plan({ ...all, 'speaking-grammar': 'Developing' });
    expect(grammarOnly.map(t => t.type)).toEqual(['repeat_improve', 'follow_up']);
  });

  test('a custom rubric: the type follows the criterion title (fluency, word choice, ideas)', () => {
    const out = plan({ 'c-ideas': 'Weak', 'c-speech-flow': 'Weak', 'c-words': 'Weak' }, THREE_LEVELS, ['on foot', 'crowded']);
    expect(out.map(t => [t.criterionId, t.type])).toEqual([['c-ideas', 'follow_up'], ['c-speech-flow', 'fluency_drill'], ['c-words', 'vocab_swap']]);
    expect(out[0].passRule).toEqual({ rule: 'second_highest', minimumPercent: 66.67 });
  });

  test('no weak area: no tasks', () => {
    expect(areas.planTasks([], { vocabTargets: [], passPercent: 70 })).toEqual([]);
  });
});

describe('template tasks (used when the AI wording is not available)', () => {
  test.each(['repeat_improve', 'follow_up', 'fluency_drill', 'vocab_swap'])('%s: a short prompt and tip in plain English that pass the student text check', type => {
    const out = tasks.templateText({ type, areaLabel: 'Grammar', assignmentTitle: 'Describe your town', targets: ['on foot', 'crowded'] });
    expect(out.prompt.length).toBeGreaterThan(20);
    expect(out.prompt.length).toBeLessThanOrEqual(400);
    expect(out.tip.length).toBeLessThanOrEqual(300);
    const coachText = require('../src/services/speakingCoach/coachText');
    expect(() => coachText.checkCoachText(out.prompt, { max: 400 })).not.toThrow();
    expect(() => coachText.checkCoachText(out.tip, { max: 300 })).not.toThrow();
  });

  test('buildTasks: ids t1..tN, the first task active and the others locked, the recording limit on every task', () => {
    const planned = [{ order: 1, type: 'follow_up', criterionId: 'a', areaLabel: 'Task', targets: [], passRule: { rule: 'threshold', minimumPercent: 70 } },
      { order: 2, type: 'repeat_improve', criterionId: 'b', areaLabel: 'Grammar', targets: [], passRule: { rule: 'threshold', minimumPercent: 70 } }];
    const out = tasks.buildTasks(planned, { assignmentTitle: 'Describe your town', maxSeconds: 90 });
    expect(out.map(t => [t.taskId, t.status, t.maxSeconds, t.attemptCount])).toEqual([['t1', 'active', 90, 0], ['t2', 'locked', 90, 0]]);
    const worded = tasks.buildTasks(planned, { assignmentTitle: 'x', maxSeconds: 60, texts: { t2: { prompt: 'Say it again with care.', tip: 'Go slowly.' } } });
    expect(worded[1]).toMatchObject({ prompt: 'Say it again with care.', tip: 'Go slowly.' });
  });
});
