'use strict';
// The ONE display order (and display labels) of the assessment categories for everything the backend renders for people (the feedback
// PDF). Same order as the frontend's src/app/constants/assessment-categories.ts and the AI-assisted Evaluation on screen.
// Display only: internal keys, score maxima, stored data, prompts and the assessment/correction pipeline do not use this.
const ASSESSMENT_CATEGORY_ORDER = Object.freeze(['GRAMMAR', 'VOCABULARY', 'ORGANIZATION', 'CONTENT', 'MECHANICS', 'PRESENTATION']);
const ASSESSMENT_CATEGORY_LABELS = Object.freeze({
  GRAMMAR: 'Grammar', VOCABULARY: 'Vocabulary', ORGANIZATION: 'Organization & Structure', CONTENT: 'Content & Task Achievement',
  MECHANICS: 'Spelling & Punctuation', PRESENTATION: 'Presentation & Handwriting'
});

/** Position in the display order (case-insensitive); unknown keys go last, keeping their order. */
function assessmentCategoryRank(key) {
  const index = ASSESSMENT_CATEGORY_ORDER.indexOf(String(key ?? '').toUpperCase());
  return index < 0 ? ASSESSMENT_CATEGORY_ORDER.length : index;
}

/** A copy of the list in the display order (stable). */
function sortByAssessmentCategory(items, keyOf) {
  return items.map((item, index) => ({ item, index }))
    .sort((a, b) => assessmentCategoryRank(keyOf(a.item)) - assessmentCategoryRank(keyOf(b.item)) || a.index - b.index)
    .map(entry => entry.item);
}

module.exports = { ASSESSMENT_CATEGORY_ORDER, ASSESSMENT_CATEGORY_LABELS, assessmentCategoryRank, sortByAssessmentCategory };
