'use strict';
// THE ONE PLACE that decides which corrections a student sees (Task 6A). Every student-facing surface (results API, counts, feedback,
// PDF, draft comparison and progress, my-submission lists) and the teacher preview go through buildStudentCorrectionView or its loader;
// tests/annotationRawReadGuard.test.js fails when a new surface reads the raw correction list instead.
//
// Rules (read-time, deterministic):
//   - no overlay entry changes the visible set -> the submission and its persisted statistics are returned untouched (byte-identical);
//   - hidden and archived entries suppress their AI correction; when the AI correction was regenerated (new id) or the OCR changed,
//     every current correction matching the anchor (annotationAnchor.matches, any category) is suppressed: fail closed;
//   - edited entries replace the text of the one AI correction they match (same category, best IoU); no unique match -> orphaned;
//   - manual entries are shown where their anchor locates; otherwise orphaned;
//   - orphaned entries are never shown to students; the teacher snapshot lists them;
//   - counts follow the visible set, including counts inside stored text and rubric rows (studentPayload); scores are never touched.
const { ocrEvidenceHash } = require('./correctionEvidenceIdentity.service');
const { buildCanonicalSubmissionTranscript } = require('../utils/ocrTranscriptNormalizer');
const { statistics: canonicalStatistics } = require('./correctionCanonical.service');
const { dominantSymbols, examples } = require('./canonicalDetailedFeedback.service');
const anchors = require('./annotationAnchor.service');
const { normalizeState } = require('./teacherAnnotation.service');
const { languageComment } = require('./rubricLanguageScoring.service');

const SUPPRESSING = ['hidden', 'archived'];
const notLoaded = () => Object.assign(new Error('ANNOTATION_OVERLAY_NOT_LOADED'), { statusCode: 500, code: 'ANNOTATION_OVERLAY_NOT_LOADED' });
const idOf = c => String(c?.id || c?._id || '');

/** The stored overlay of a submission-like object, or a thrown error when it was not loaded (never guessed as "none"). */
function overlayOf(submission, explicit) {
  if (explicit !== undefined) return explicit;
  if (typeof submission?.isSelected === 'function') {
    if (!submission.isSelected('teacherAnnotations')) throw notLoaded();
    return submission.get('teacherAnnotations') ?? null;
  }
  if (submission && Object.prototype.hasOwnProperty.call(submission, 'teacherAnnotations')) return submission.teacherAnnotations ?? null;
  throw notLoaded();
}

/** Entries that govern the current draft. Legacy (version 1) entries carry no draft number. */
const activeEntries = (state, draftNumber) => state.entries.filter(e => e.draftNumber == null || Number(e.draftNumber) === draftNumber);

/** A teacher value placed at a located span of the current transcript, bound to the current OCR evidence. */
function placed(value, span, canonical, hash, submission, extra) {
  const wordIds = anchors.wordIdsFor(canonical, span);
  const { createdAt: _createdAt, ...rest } = value;
  return { ...rest, ...extra, fileId: String(span.fileId), page: span.page, startChar: span.startChar, endChar: span.endChar,
    quotedText: canonical.text.slice(span.startChar, span.endChar), wordIds, evidenceWordIds: wordIds, bboxList: [],
    ocrEvidenceHash: hash, ...(submission.ocrJobId ? { ocrRunId: String(submission.ocrJobId) } : {}), teacherGrounded: true };
}

/**
 * Resolves the overlay against the current corrections and transcript. Pure. Returns
 * { changed, visible, suppressedIds, editedById, orphans (need review), archivedOrphans (removed by the teacher), rows (teacher list), aiById,
 * entryIdByAiId, orphanIds (both kinds), state, revision }.
 */
function resolveOverlay(submission, overlay, { corrections } = {}) {
  const state = normalizeState(overlay);
  const raw = Array.isArray(corrections) ? corrections : Array.isArray(submission?.writingCorrections) ? submission.writingCorrections : [];
  const draftNumber = Math.max(1, Number(submission?.draftNumber) || 1);
  const entries = activeEntries(state, draftNumber);
  const aiById = new Map(raw.map(c => [idOf(c), c]));
  const base = { state, revision: state.revision, scoringReviewRequired: Boolean(state.scoringReviewRequired), aiById,
    entryIdByAiId: new Map(), orphanIds: new Set(), orphans: [], archivedOrphans: [], suppressedIds: new Set(), editedById: new Map() };
  if (!entries.length) return { ...base, changed: false, visible: raw, manual: [], rows: raw.map(c => ({ ...c, moderationStatus: 'visible' })) };

  const canonical = buildCanonicalSubmissionTranscript(submission);
  const hash = ocrEvidenceHash(canonical, submission);
  const suppressedBy = new Map(), editClaims = new Map(), manual = [];
  const orphan = (entry, reason, extra = {}) => { base.orphanIds.add(entry.id);
    (entry.status === 'archived' ? base.archivedOrphans : base.orphans).push({ entryId: entry.id, kind: entry.kind, status: entry.status, edited: Boolean(entry.edited), reason,
      anchor: entry.anchor || null, value: entry.value || null, ...extra }); };
  // Legacy entries cannot tell which draft they belong to: they relocate only on the first draft, except suppressions (fail closed).
  const mayRelocate = entry => !entry.legacy || draftNumber === 1 || SUPPRESSING.includes(entry.status);
  const where = (anchor, entry) => anchor?.sourceHash === hash || mayRelocate(entry) ? anchors.locate(anchor, canonical, hash)
    : { orphan: 'LEGACY_DRAFT_UNKNOWN', candidates: [] };

  for (const entry of entries) {
    if (entry.kind === 'manual') {
      const found = where(entry.valueAnchor || entry.anchor, entry);
      if (!found.span) { orphan(entry, found.orphan); continue; }
      manual.push({ entry, correction: placed(entry.value, found.span, canonical, hash, submission, { id: entry.id, source: 'Teacher' }) });
      continue;
    }
    // AI entry: its own correction when still present on the same evidence, else every correction at the located anchor.
    const direct = entry.anchor?.sourceHash === hash && aiById.get(entry.targetId);
    // A restored, unedited AI entry changes nothing: it is never an orphan.
    const effective = SUPPRESSING.includes(entry.status) || entry.edited;
    let targets;
    if (direct) targets = [direct];
    else {
      const found = where(entry.anchor, entry);
      const spans = found.span ? [found.span] : found.candidates;
      targets = raw.filter(c => spans.some(span => anchors.matches(span, c)));
      if (effective && !found.span) orphan(entry, found.orphan, { suppressing: SUPPRESSING.includes(entry.status) && targets.length > 0 });
      else if (effective && !targets.length) orphan(entry, 'NO_MATCHING_CORRECTION');
    }
    if (SUPPRESSING.includes(entry.status)) {
      for (const c of targets) { suppressedBy.set(idOf(c), entry); base.entryIdByAiId.set(idOf(c), entry.id); }
      continue;
    }
    if (base.orphanIds.has(entry.id)) continue;
    if (!entry.edited) { for (const c of targets) if (!base.entryIdByAiId.has(idOf(c))) base.entryIdByAiId.set(idOf(c), entry.id); continue; }
    // Edited: exactly one same-category correction, the best overlap.
    const category = entry.value?.category || entry.anchor?.category;
    const same = direct ? targets : targets.filter(c => !category || c.category === category || c.category === entry.value?.category)
      .sort((a, b) => anchors.overlap(entry.anchor, b).iou - anchors.overlap(entry.anchor, a).iou);
    if (!same.length || (same.length > 1 && anchors.overlap(entry.anchor, same[0]).iou === anchors.overlap(entry.anchor, same[1]).iou)) {
      orphan(entry, same.length ? 'AMBIGUOUS' : 'NO_MATCHING_CORRECTION'); continue;
    }
    const target = same[0];
    if (editClaims.has(idOf(target))) { orphan(entry, 'CONFLICT'); orphan(editClaims.get(idOf(target)).entry, 'CONFLICT'); editClaims.delete(idOf(target)); continue; }
    editClaims.set(idOf(target), { entry, target });
    base.entryIdByAiId.set(idOf(target), entry.id);
  }

  const visible = [], rows = [];
  for (const c of raw) {
    const id = idOf(c);
    const hider = suppressedBy.get(id);
    if (hider) {
      base.suppressedIds.add(id);
      // Teacher list only: a hidden or archived entry that was edited shows the teacher's own text. Students never get this row.
      let shown = c;
      if (hider.edited && hider.value) {
        const found = where(hider.valueAnchor, hider);
        shown = found.span ? placed(hider.value, found.span, canonical, hash, submission, { id, source: c.source, teacherEdited: true })
          : { ...c, symbol: hider.value.symbol, category: hider.value.category, symbolLabel: hider.value.symbolLabel, message: hider.value.message, suggestedText: hider.value.suggestedText, teacherEdited: true };
      }
      rows.push({ ...shown, moderationStatus: hider.status, entryId: hider.id });
      continue;
    }
    const claim = editClaims.get(id);
    if (claim && !base.orphanIds.has(claim.entry.id)) {
      const found = where(claim.entry.valueAnchor, claim.entry);
      if (!found.span) { orphan(claim.entry, found.orphan); visible.push(c); rows.push({ ...c, moderationStatus: 'visible' }); continue; }
      const edited = placed(claim.entry.value, found.span, canonical, hash, submission, { id, source: c.source, teacherEdited: true });
      base.editedById.set(id, edited);
      visible.push(edited); rows.push({ ...edited, moderationStatus: 'visible', entryId: claim.entry.id });
      continue;
    }
    visible.push(c); rows.push({ ...c, moderationStatus: 'visible', ...(base.entryIdByAiId.has(id) ? { entryId: base.entryIdByAiId.get(id) } : {}) });
  }
  for (const { entry, correction } of manual) {
    if (entry.status === 'visible') visible.push(correction);
    rows.push({ ...correction, moderationStatus: entry.status, entryId: entry.id });
  }
  const changed = base.suppressedIds.size > 0 || base.editedById.size > 0 || visible.length !== raw.length;
  return { ...base, changed, visible: changed ? visible : raw, manual, rows };
}

/** Copy of a submission without the overlay; the object itself when it carries none (mongoose documents drop it in toJSON). */
function withoutOverlay(submission) {
  if (!submission || typeof submission.toJSON === 'function' || !Object.prototype.hasOwnProperty.call(submission, 'teacherAnnotations')) return submission;
  const { teacherAnnotations: _overlay, ...rest } = submission;
  return rest;
}

/**
 * What a student sees of one submission's corrections.
 *   audience 'student' (default): { changed, corrections, statistics, submission (projected: visible corrections + statistics, no overlay),
 *     revision, scoringReviewRequired, suppressedIds, editedById }
 *   audience 'teacher': additionally { rows (every correction with its status), orphans, archivedOrphans }.
 * `overlay` must be given or loaded on the submission; a missing overlay throws instead of leaking hidden corrections.
 */
function buildStudentCorrectionView(submission, { overlay, audience = 'student', corrections } = {}) {
  const resolution = resolveOverlay(submission, overlayOf(submission, overlay), { corrections });
  const statistics = resolution.changed ? canonicalStatistics(resolution.visible) : submission?.correctionStatistics;
  let projected = withoutOverlay(submission);
  if (resolution.changed) {
    const base = typeof submission.toJSON === 'function' ? submission.toJSON() : { ...projected };
    delete base.teacherAnnotations;
    // Diagnostics count the raw list. Coverage has no correction counts and is what the result state and draft comparison read.
    delete base.evaluationDiagnostics;
    if (base.semanticMetrics) base.semanticMetrics = base.semanticMetrics.coverage ? { coverage: base.semanticMetrics.coverage } : undefined;
    projected = { ...base, writingCorrections: resolution.visible, correctionStatistics: statistics };
  }
  const view = { changed: resolution.changed, corrections: resolution.visible, statistics, submission: projected,
    revision: resolution.revision, scoringReviewRequired: resolution.scoringReviewRequired,
    suppressedIds: resolution.suppressedIds, editedById: resolution.editedById };
  return audience === 'teacher' ? { ...view, rows: resolution.rows, orphans: resolution.orphans, archivedOrphans: resolution.archivedOrphans, resolution } : view;
}

/**
 * Loads the overlays of submissions (or of SubmissionRevision snapshots) in one query and builds each view. Whatever the caller
 * selected is ignored: the overlay is always read here, so no surface can forget it.
 */
async function loadStudentCorrectionViews(documents, { model = 'Submission', audience } = {}) {
  const list = documents || [];
  // An overlay the caller already loaded (select '+teacherAnnotations') is used as is; only the rest cost one query.
  const loaded = d => typeof d.isSelected === 'function' ? d.isSelected('teacherAnnotations') : Object.prototype.hasOwnProperty.call(d, 'teacherAnnotations');
  const missing = list.filter(d => d && !loaded(d));
  const stored = missing.length ? await require(`../models/${model}`).find({ _id: { $in: missing.map(d => d._id) } }).select('teacherAnnotations').lean() : [];
  const byId = new Map(stored.map(d => [String(d._id), d.teacherAnnotations ?? null]));
  return list.map(d => d && buildStudentCorrectionView(d, { overlay: loaded(d) ? undefined : byId.get(String(d._id)) ?? null, audience }));
}
const loadStudentCorrectionView = async (document, options) => (await loadStudentCorrectionViews([document], options))[0];

/** The visible list as the correction endpoints and the PDF send it: plain copies, each marked visible. */
const visibleCorrectionList = view => (view.corrections || []).map(c => ({ ...JSON.parse(JSON.stringify(c)), moderationStatus: 'visible' }));

// "3 grammar issues", "3 validated canonical grammar corrections" (the wording semanticRubricAssessment.normalizeStatisticsComment writes).
const COUNT_CLAIM = /\b\d+(\s+(?:(?:validated|canonical|detected|localized)\s+)*(?:\w+\s+)?)(correction|error|issue)s?\b/giu;
const COUNTED_CATEGORIES = ['CONTENT', 'ORGANIZATION', 'GRAMMAR', 'VOCABULARY', 'MECHANICS'];
const visibleCount = (view, category) => Number(view.statistics?.[String(category).toLowerCase()] || 0);
/** Stored text with its correction count replaced by the visible one. The deterministic language comment is rebuilt, as its wording follows the count. */
function restateCount(text, count, item) {
  if (typeof text !== 'string') return text;
  const language = text.match(/^\d+ (grammar|mechanics) issues? detected\./);
  if (language && Number.isFinite(Number(item?.score)) && Number(item?.maxScore) > 0) return languageComment(language[1], count, Number(item.score), Number(item.maxScore));
  return text.replace(COUNT_CLAIM, (_, middle, noun) => `${count}${middle}${noun}${count === 1 ? '' : 's'}`);
}
/** Text with no category to count: the claim stays, the number goes. */
const withoutCount = text => typeof text === 'string' ? text.replace(COUNT_CLAIM, (_, middle, noun) => `${middle.trim()} ${noun}s`.trim()) : text;
/** Rubric rows for the visible set: issue counts and comments restated, scores untouched. */
function rubricForView(rubric, view) {
  const out = { ...rubric };
  for (const category of COUNTED_CATEGORIES) {
    const item = out[category];
    if (!item || typeof item !== 'object') continue;
    const count = visibleCount(view, category);
    out[category] = { ...item, issueCount: count, ...(typeof item.comment === 'string' ? { comment: restateCount(item.comment, count, item) } : {}) };
  }
  return out;
}

const templated = {
  explanation: (n, symbols) => `${n} distinct issue${n === 1 ? '' : 's'} affected this category. `
    + (symbols.length ? `The main recorded pattern${symbols.length === 1 ? ' is' : 's are'} ${symbols.join(', ')}.` : 'The canonical analysis identified revision evidence.'),
  action: (symbols, n) => `Revise the ${symbols.join('/')} correction${n === 1 ? '' : 's'} in the highlighted passages.`,
  reason: (n, title) => `${n} canonical ${title.toLowerCase()} issue${n === 1 ? '' : 's'} currently affect this category.`,
};

/** Structured detailed feedback restated for the visible set: counts, symbols, examples and the deterministic sentences built from them. */
function detailedFeedbackForView(detailed, view) {
  if (!detailed || !Array.isArray(detailed.areasForImprovement)) return detailed;
  const byCategory = new Map();
  for (const c of view.corrections) byCategory.set(c.category, [...(byCategory.get(c.category) || []), c]);
  const rewritten = new Map();
  const areas = detailed.areasForImprovement.map(area => {
    if (!area || typeof area !== 'object' || area.evidenceKind === 'holistic' || !Number.isFinite(Number(area.issueCount))) return area;
    const items = byCategory.get(area.category) || [];
    const count = Number(view.statistics?.[String(area.category).toLowerCase()] ?? items.length);
    if (!count) { rewritten.set(area.category, null); return null; }
    const symbols = dominantSymbols(items);
    const next = { ...area, issueCount: count, dominantSymbols: symbols, examples: examples(items),
      explanation: area.explanation === templated.explanation(area.issueCount, area.dominantSymbols || []) ? templated.explanation(count, symbols) : restateCount(area.explanation, count) };
    rewritten.set(area.category, { before: area, after: next });
    return next;
  }).filter(Boolean);
  const actionSteps = Array.isArray(detailed.actionSteps) ? detailed.actionSteps.map(step => {
    if (!step || !rewritten.has(step.category) || step.evidenceKind === 'holistic') return step;
    const change = rewritten.get(step.category);
    if (!change) return null;
    const { before, after } = change;
    return { ...step, relatedSymbols: after.dominantSymbols, relatedCorrectionIds: after.examples.map(item => item.correctionId),
      action: step.action === templated.action(before.dominantSymbols || [], before.issueCount) ? templated.action(after.dominantSymbols, after.issueCount) : step.action,
      reason: step.reason === templated.reason(before.issueCount, before.title || '') ? templated.reason(after.issueCount, after.title || '') : restateCount(step.reason, after.issueCount) };
  }).filter(Boolean) : detailed.actionSteps;
  const strengths = Array.isArray(detailed.strengths) ? detailed.strengths.map(item => COUNTED_CATEGORIES.includes(item?.category) && typeof item.explanation === 'string'
    ? { ...item, explanation: restateCount(item.explanation, visibleCount(view, item.category), item) } : item) : detailed.strengths;
  // A category with visible corrections but no counted area (a teacher added the first one): a card from the same templates. It has no score
  // fields: stored feedback never scored this category's corrections. A holistic card is not a count of corrections, so it stays beside it.
  const counted = new Set(areas.filter(area => area?.evidenceKind !== 'holistic' && Number.isFinite(Number(area?.issueCount))).map(area => area.category));
  const added = COUNTED_CATEGORIES.filter(category => !counted.has(category) && visibleCount(view, category) && byCategory.get(category)?.length).map(category => {
    const items = byCategory.get(category), count = visibleCount(view, category), symbols = dominantSymbols(items);
    return { id: `area_${category.toLowerCase()}`, category, title: category[0] + category.slice(1).toLowerCase(), issueCount: count,
      explanation: templated.explanation(count, symbols), dominantSymbols: symbols, examples: examples(items) };
  });
  const addedSteps = added.map((area, index) => ({ id: `action_${area.category.toLowerCase()}`, priority: (actionSteps?.length || 0) + index + 1, category: area.category,
    action: templated.action(area.dominantSymbols, area.issueCount), reason: templated.reason(area.issueCount, area.title),
    relatedSymbols: area.dominantSymbols, relatedCorrectionIds: area.examples.map(item => item.correctionId) }));
  return { ...detailed, areasForImprovement: [...areas, ...added], actionSteps: Array.isArray(actionSteps) ? [...actionSteps, ...addedSteps] : actionSteps, strengths };
}

// Correction id shapes: canonical `<source>_<16 hex>`, manual `teacher_<uuid>`, legacy LanguageTool `lt_<n>`.
const CORRECTION_ID = /^(?:[a-z]+_[0-9a-f]{16}|teacher_[0-9a-f-]{36}|lt_\d+)$/;

/**
 * Any student-facing payload restated for the visible set. Allowlist: an object that references a correction (correctionId or
 * evidenceId 'correction:<id>') or a correction-id string survives only when that correction is visible, so stale references (feedback
 * written before a regenerate or OCR re-run) are dropped too. Refreshes example text of edited corrections and restates structured
 * detailed feedback, rubric rows and any stored count of the raw list (scoring audit and diagnostics reduced or removed). Scores stay.
 * Returns the payload itself when nothing changed.
 */
function studentPayload(payload, view) {
  if (!view?.changed || payload == null) return payload;
  const visibleIds = new Set(view.corrections.map(idOf));
  const hiddenRef = id => Boolean(id) && !visibleIds.has(String(id));
  const referenced = value => (typeof value?.correctionId === 'string' && hiddenRef(value.correctionId))
    || (typeof value?.evidenceId === 'string' && value.evidenceId.startsWith('correction:') && hiddenRef(value.evidenceId.slice(11)));
  const walk = (value, key) => {
    if (Array.isArray(value)) return value.filter(item => !(typeof item === 'string' && CORRECTION_ID.test(item) && hiddenRef(item))
      && !(item && typeof item === 'object' && referenced(item))).map(item => walk(item, key));
    if (!value || typeof value !== 'object' || value instanceof Date || value._bsontype || Buffer.isBuffer(value)) return value;
    // The page reads overallMethod; the custom rubric block holds no correction counts.
    if (key === 'scoringAudit') return { overallMethod: value.overallMethod, ...(value.customRubric ? { customRubric: value.customRubric } : {}) };
    if (Array.isArray(value.areasForImprovement)) value = detailedFeedbackForView(value, view);   // detailedFeedback, and the ocr-corrections evaluation block
    if (key === 'rubricScores' || key === 'categoryScores') value = rubricForView(value, view);
    if (key === 'aiFeedback' && Array.isArray(value.perCategory)) value = { ...value, perCategory: value.perCategory.map(item => {
      const category = String(item?.category || '').toUpperCase();
      return { ...item, message: COUNTED_CATEGORIES.includes(category) ? restateCount(item.message, visibleCount(view, category)) : withoutCount(item.message) };
    }) };
    if (key === 'customRubricScores' && Array.isArray(value.criteria)) value = { ...value, criteria: value.criteria.map(item => ({ ...item, comment: withoutCount(item?.comment) })) };
    const out = {};
    for (const [k, v] of Object.entries(value)) if (k !== 'evaluationDiagnostics') out[k] = walk(v, k);
    const edited = out.correctionId && view.editedById.get(String(out.correctionId));
    if (edited && 'quotedText' in out) Object.assign(out, { symbol: edited.symbol, quotedText: edited.quotedText,
      ...('message' in out ? { message: edited.message } : {}), ...('suggestedText' in out ? { suggestedText: edited.suggestedText } : {}) });
    return out;
  };
  return walk(typeof payload.toObject === 'function' ? payload.toObject() : payload, '');
}

module.exports = { buildStudentCorrectionView, loadStudentCorrectionView, loadStudentCorrectionViews, resolveOverlay, studentPayload,
  detailedFeedbackForView, overlayOf, visibleCorrectionList };
