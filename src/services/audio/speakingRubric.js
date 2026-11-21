'use strict';
// The rubric a speaking assessment is marked against (audio + speech-to-text, stage 6).
// - A speaking assignment references one of the teacher's saved rubrics (assignment.speaking.rubricRef). When a teacher creates a speaking
//   assignment without choosing one, their own editable copy of the default speaking rubric is created once and referenced; they edit it in
//   the saved-rubric library (PATCH /api/rubrics/:id). An assignment made before that (rubricRef null), or whose rubric was archived, uses the
//   built-in default below.
// - The rubric is normalised by the essay code (assignmentRubric.service, imported, never edited), so the stored custom-rubric scores have the
//   same shape for essays and speaking.
// - The four built-in essay categories that apply to speech (CONTENT, ORGANIZATION, GRAMMAR, VOCABULARY) are derived from the default
//   criterion ids, without AI. MECHANICS (spelling, punctuation) and PRESENTATION (handwriting) never apply: they are stored with maxScore 0.
const SavedRubric = require('../../models/savedRubric.model');
const { normalizeAssignmentRubric, hashNormalizedRubric } = require('../assignmentRubric.service');

const DEFAULT_RUBRIC_NAME = 'Speaking rubric';
const DEFAULT_RUBRIC_VERSION = 'speaking-default-rubric-v1';
const LEVELS = [['Excellent', 4], ['Good', 3], ['Developing', 2], ['Beginning', 1]];
const criterion = (id, name, weight, descriptions) => ({ id, name, weight,
  levels: LEVELS.map(([title, score], index) => ({ title, score, description: descriptions[index] })) });

/** The default speaking rubric (weights 25/20/20/20/15; four levels). Same shape as a saved rubric's rubricData. */
const DEFAULT_RUBRIC = Object.freeze({
  totalPoints: 100,
  criteria: [
    criterion('speaking-task', 'Task and content', 25, ['Fully answers the task with relevant, well-developed ideas and examples.',
      'Answers the task with relevant ideas; some could be developed further.', 'Partly answers the task; ideas are thin or drift from the topic.',
      'Does not answer the task, or the ideas are mostly unrelated to it.']),
    criterion('speaking-organisation', 'Organisation and coherence', 20, ['Ideas follow a clear order with natural linking between them.',
      'Mostly clear order; linking is sometimes simple or repeated.', 'The order is hard to follow in places; little linking.',
      'No clear order; ideas are disconnected.']),
    criterion('speaking-grammar', 'Grammar', 20, ['A range of structures used accurately; errors are rare and do not affect meaning.',
      'Mostly accurate; some errors that rarely affect meaning.', 'Frequent errors; meaning is sometimes unclear.',
      'Errors make much of the answer hard to understand.']),
    criterion('speaking-vocabulary', 'Vocabulary', 20, ['Varied, precise word choice suited to the topic.', 'Adequate range with some imprecise choices.',
      'Limited range; repeated or imprecise words.', 'Very limited words; meaning is often unclear.']),
    criterion('speaking-fluency', 'Fluency', 15, ['Speaks at a steady pace with few long pauses or fillers.', 'Generally steady; some pauses, fillers or restarts.',
      'Frequent pauses, fillers or restarts interrupt the answer.', 'Speech is very halting; long pauses dominate.'])
  ]
});

const BUILT_IN = Object.freeze({ 'speaking-task': 'CONTENT', 'speaking-organisation': 'ORGANIZATION', 'speaking-grammar': 'GRAMMAR', 'speaking-vocabulary': 'VOCABULARY' });
const BUILT_IN_MAX = Object.freeze({ CONTENT: 20, ORGANIZATION: 20, GRAMMAR: 25, VOCABULARY: 20, MECHANICS: 10, PRESENTATION: 5 });
const NOT_APPLICABLE = Object.freeze(['MECHANICS', 'PRESENTATION']);

/** The teacher's own copy of the default speaking rubric: created once, then reused. Returns its id. */
async function ensureDefaultSpeakingRubric(teacherId) {
  const found = await SavedRubric.findOneAndUpdate({ teacher: teacherId, name: DEFAULT_RUBRIC_NAME, writingType: 'speaking', isActive: true },
    { $setOnInsert: { teacher: teacherId, name: DEFAULT_RUBRIC_NAME, writingType: 'speaking', description: 'Default rubric for speaking assignments. You can edit it.',
      rubricData: JSON.parse(JSON.stringify(DEFAULT_RUBRIC)), isActive: true } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }).select('_id').lean();
  return found._id;
}

/**
 * { status: 'valid', rubric (normalised), rubricHash, source: 'saved' | 'default' } or { status: 'invalid', diagnostics }.
 * A referenced rubric that is missing, archived or not the teacher's falls back to the built-in default (never to another teacher's).
 */
async function resolveSpeakingRubric(assignment) {
  const ref = assignment?.speaking?.rubricRef;
  const saved = ref ? await SavedRubric.findOne({ _id: ref, teacher: assignment.teacher, isActive: true }).select('rubricData name').lean() : null;
  const source = saved ? 'saved' : 'default';
  const result = normalizeAssignmentRubric({ rubrics: saved ? saved.rubricData : DEFAULT_RUBRIC, title: saved?.name || DEFAULT_RUBRIC_NAME });
  if (result.status !== 'valid') return { status: 'invalid', diagnostics: result.diagnostics, source };
  return { status: 'valid', rubric: result.rubric, rubricHash: hashNormalizedRubric(result), source };
}

/**
 * The six built-in essay categories for a speaking result, derived from the scored criteria (no AI): the four that apply, scaled to their
 * essay maxima; any of them whose default criterion is not in this rubric, and MECHANICS and PRESENTATION always, get maxScore 0.
 */
function builtInScores(customScores, issueCounts = {}) {
  const out = {};
  for (const key of Object.keys(BUILT_IN_MAX)) out[key] = { score: 0, maxScore: 0, comment: '', issueCount: 0 };
  for (const item of customScores?.criteria || []) {
    const key = BUILT_IN[item.criterionId];
    if (!key) continue;
    const max = BUILT_IN_MAX[key];
    out[key] = { score: Math.round(max * Number(item.configuredLevelPercentage) / 100), maxScore: max, comment: String(item.comment || ''),
      issueCount: Number(issueCounts[key.toLowerCase()] || 0) };
  }
  return out;
}

module.exports = { DEFAULT_RUBRIC, DEFAULT_RUBRIC_NAME, DEFAULT_RUBRIC_VERSION, BUILT_IN, BUILT_IN_MAX, NOT_APPLICABLE, ensureDefaultSpeakingRubric,
  resolveSpeakingRubric, builtInScores };
