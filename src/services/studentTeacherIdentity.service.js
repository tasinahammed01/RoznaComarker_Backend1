'use strict';
// What a student may know about their teacher: a display name. Student responses replace populated `teacher` objects and bare teacher ids with
// teacherDisplayName, so no teacher email or id reaches a student. Teacher-facing endpoints do not go through this module.
// The same module removes what a student has no use for: the creator of a worksheet or flashcard set, the teacher's source text, and the internals of
// the AI pipeline (providers, models, prompts, hashes, leases, job ids, diagnostics).
const FALLBACK_NAME = 'Your teacher';
// Provider and scoring internals. No student page reads them.
const INTERNAL_FIELDS = ['evaluationProvider', 'evaluationModel', 'evaluationAttempts', 'evaluationPolicy', 'analysisInputHash'];
// Removed at any depth from a student response. Every name was searched for in the student pages (RoznaComarker/src/app, outside the teacher and admin pages):
// none reads it. Names that a page does read stay (the correction, evaluation and policy source hashes, ocrJobId, the semantic status counters): see
// STUDENT_READS in tests/studentTeacherIdentity.test.js for each one and its reader. Specific names only: nothing is matched by a pattern.
const STUDENT_HIDDEN_KEYS = new Set([...INTERNAL_FIELDS,
  // AI pipeline: who ran it, with what, and how
  'semanticProvider', 'semanticModel', 'semanticPromptVersion', 'semanticSourceKey', 'correctionGenerationConfig', 'correctionLegendSource', 'correctionLegendVersion',
  'correctionLegendContentHash', 'deductionPolicyVersion', 'languageToolStatus', 'languageToolSourceHash', 'languageToolVersion', 'languageToolMappingVersion',
  'languageToolTranscriptLayoutVersion', 'evaluationDiagnostics', 'evaluationBuiltInContextHash', 'evaluationJobId', 'evaluationError',
  // Workers: who holds the job and when it retries
  'analysisLeaseOwner', 'analysisLeaseExpiresAt', 'analysisAttempt', 'analysisNextRetryAt',
  // Internal identities of runs, evidence and earlier revisions
  'assessmentRunId', 'correctionOcrJobId', 'correctionOcrEvidenceHash', 'ocrEvidenceHash', 'ocrRunId', 'correctionFingerprint', 'rasterHash', 'sourceHumanReviewId',
  'reusedFromRevisionId', 'previousRevision', 'fileContentIdentity', 'transcriptFingerprint', 'sourceFingerprint', 'responseFingerprint', 'guestRequestKey', 'guestRevisionLease',
  'guestAcceptedRevisionKey',
  // Who created a worksheet or flashcard set, and what only they see
  'createdBy', 'ownerId', 'sourceContent', 'shareToken', 'isPublic', 'isPublished', 'generationSource', 'answerKey',
  // Task 9: searched in the student pages, none reads them. evaluationErrorCode is NOT here: canonical-result-state.util.ts reads it.
  'sourcePrimaryProvider', 'sourcePrimaryModel', 'sourceSecondaryProvider', 'sourceSecondaryModel', 'ocrProvider', 'ocrApi', 'ocrPipelineVersion', 'sourceVerificationSummary',
  'correctionJobId', 'correctionError', 'analysisErrorCode', 'assessmentErrorCode', 'sourceHumanReviewSummary', 'sourceRubric', 'detailedFeedbackVersion', 'overrideReason',
  'ocrExifOrientation', 'rasterizationVersion', 'idempotencyKey', 'qrCodeUrl',
  // Task 20: the correction-only retry's job and counters. Students read only the booleans correctionRetryActive / correctionRetryAllowed.
  'correctionRetry',
  // Phase B2: the teacher's score-edit record (history, reason, who). Students get the final values in the existing score fields instead.
  'teacherEvaluation']);

// ALLOWLISTS (Task 9). A field not named here does not reach a student, so a field added to a schema or written by a provider cannot leak on these shapes.
// One page of the transcript. Read by my-submission-page.ts and transcript-page-views.util.ts (fileId, pageNumber, page, width, height, sourceGeometry, pageImageUrl,
// status, ocrStatus, text, words), annotation-image-geometry.ts (coordinateSpace), annotation-geometry.ts (lines). The rest are kept until a browser check shows them unused.
const OCR_PAGE_FIELDS = new Set(['_id', 'fileId', 'fileOrder', 'pageNumber', 'pageIndex', 'page', 'width', 'height', 'coordinateSpace', 'sourceGeometry', 'text', 'words', 'lines',
  'pageImageUrl', 'derivedImageFileId', 'status', 'ocrStatus']);
// One correction: what studentCorrectionView.service.js and canonicalCorrectionRender.service.js produce for display, and what transcript-page-views.util.ts,
// my-submission-page.ts, handwritten-ocr-page.ts and correction-overlay.ts read. Marks of a correction (deductions) and pipeline identities are not displayed.
const CORRECTION_FIELDS = new Set(['id', '_id', 'fileId', 'page', 'pageNumber', 'startChar', 'endChar', 'quotedText', 'originalText', 'suggestedText', 'message', 'category', 'group', 'groupKey',
  'symbol', 'symbolLabel', 'color', 'source', 'editable', 'wordIds', 'evidenceWordIds', 'visualTarget', 'renderTarget', 'bboxList', 'bboxCoordinateSpace', 'ocrConfidence', 'ocrSuspect', 'moderationStatus']);
// One uploaded file. my-submission-page.ts reads _id, id and url; originalName and filename name the file.
const FILE_FIELDS = new Set(['_id', 'id', 'originalName', 'filename', 'url']);

const plain = value => (typeof value?.toJSON === 'function' ? value.toJSON() : value);
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && !value._bsontype;

/** A display name that is really an email is not shown: some accounts have the address stored as their name. */
function teacherDisplayName(teacher) {
  const name = isObject(teacher) && typeof teacher.displayName === 'string' ? teacher.displayName.trim() : '';
  return name && !name.includes('@') ? name : FALLBACK_NAME;
}

/** A populated class or assignment without its owner. `known`: the teacher to name when this object only holds their id. */
function withoutOwner(value, known) {
  const object = plain(value);
  if (!isObject(object)) return object;
  const { teacher, ...rest } = object;
  return { ...rest, teacherDisplayName: teacherDisplayName(isObject(teacher) ? teacher : known) };
}

const classForStudent = (value, known) => withoutOwner(value, known);

function assignmentForStudent(value, known) {
  const assignment = plain(value);
  if (!isObject(assignment)) return assignment;
  const owner = isObject(assignment.teacher) ? assignment.teacher : known;
  const out = withoutOwner(assignment, owner);
  if (isObject(out.class)) out.class = classForStudent(out.class, owner);
  return out;
}

function withoutInternalFields(value) {
  const out = { ...value };
  for (const key of INTERNAL_FIELDS) delete out[key];
  return out;
}

// Blocks that record which provider and model produced something, and how: the practice generation and the answer check. The page reads the failure
// message of a check (adaptive-writing-studio.ts: checking.errorMessage) and nothing else of either, so only the outcome stays.
const PROVENANCE_BLOCKS = new Map([['generation', ['startedAt', 'completedAt', 'errorCode', 'errorMessage']], ['checking', ['startedAt', 'completedAt', 'errorCode', 'errorMessage']]]);

/** The value without STUDENT_HIDDEN_KEYS at any depth. Dates, ids, buffers and class instances are left as they are. */
function withoutInternal(value) {
  if (Array.isArray(value)) return value.map(withoutInternal);
  // A mongoose document becomes plain data; a Date or an ObjectId (which also have toJSON) is returned as it is.
  const object = typeof value?.toObject === 'function' ? value.toObject() : value;
  if (!isObject(object) || Object.getPrototypeOf(object) !== Object.prototype) return object;
  const out = {};
  for (const [key, nested] of Object.entries(object)) {
    if (STUDENT_HIDDEN_KEYS.has(key)) continue;
    const kept = PROVENANCE_BLOCKS.get(key);
    out[key] = kept && isObject(nested) && Object.getPrototypeOf(nested) === Object.prototype ? Object.fromEntries(Object.entries(nested).filter(([name]) => kept.includes(name))) : withoutInternal(nested);
  }
  return out;
}

/** The named fields of an object, in their stored order. Anything that is not an object (a bare id, null) is returned as it is. */
function picked(value, fields) {
  const object = plain(value);
  return isObject(object) ? Object.fromEntries(Object.entries(object).filter(([key]) => fields.has(key))) : value;
}
const ocrPageForStudent = value => picked(value, OCR_PAGE_FIELDS);
const correctionForStudent = value => picked(value, CORRECTION_FIELDS);
const fileForStudent = value => picked(value, FILE_FIELDS);
const each = (list, sanitize) => (Array.isArray(list) ? list.map(sanitize) : list);

/** The ocr-corrections response as a student or guest gets it. */
function ocrCorrectionsForStudent(value) {
  const out = withoutInternal(value);
  return isObject(out) ? { ...out, ...('corrections' in out ? { corrections: each(out.corrections, correctionForStudent) } : {}), ...('ocr' in out ? { ocr: each(out.ocr, ocrPageForStudent) } : {}) } : out;
}

/** A worksheet as a student gets it: no creator, no source text, no share link. (The answer key and model answers are removed by the handler.) */
const worksheetForStudent = value => withoutInternal(value);
/** A flashcard set as a student gets it: no owner, no share link or folder. */
function flashcardSetForStudent(value) {
  const { folderId: _folderId, ...rest } = plain(value);
  return withoutInternal(rest);
}

/** A submission as a student receives it, whether or not its assignment and class are populated. */
function submissionForStudent(value) {
  const submission = plain(value);
  if (!isObject(submission)) return submission;
  const owner = isObject(submission.assignment) && isObject(plain(submission.assignment).teacher) ? plain(submission.assignment).teacher : undefined;
  const out = withoutInternal(submission);
  if (isObject(out.assignment)) out.assignment = assignmentForStudent(out.assignment);
  if (isObject(out.class)) out.class = classForStudent(out.class, owner);
  for (const [key, sanitize] of [['ocrPages', ocrPageForStudent], ['writingCorrections', correctionForStudent], ['files', fileForStudent]]) if (key in out) out[key] = each(out[key], sanitize);
  if ('file' in out) out.file = fileForStudent(out.file);
  return out;
}

/** A membership with its populated class. */
function membershipForStudent(value) {
  const membership = plain(value);
  return isObject(membership) ? { ...membership, class: classForStudent(membership.class) } : membership;
}

/** The legacy feedback document (populateFeedback): teacher, class, assignment, submission, and who overrode it. */
function legacyFeedbackForStudent(value) {
  const { teacher, overriddenBy: _overriddenBy, overrideReason: _overrideReason, ...rest } = plain(value);
  const owner = isObject(teacher) ? teacher : undefined;
  return { ...rest, teacherDisplayName: teacherDisplayName(owner),
    ...(isObject(rest.assignment) ? { assignment: assignmentForStudent(rest.assignment, owner) } : {}),
    ...(isObject(rest.class) ? { class: classForStudent(rest.class, owner) } : {}),
    ...(isObject(rest.submission) ? { submission: submissionForStudent(rest.submission) } : {}),
    ...(isObject(rest.evaluation) ? { evaluation: withoutInternal(rest.evaluation) } : {}) };
}

/** A notification as its student recipient sees it: the sender by name only. */
function notificationForStudent(value) {
  const notification = plain(value);
  if (!isObject(notification)) return notification;
  const { actor, ...rest } = notification;
  return { ...rest, ...(isObject(actor) ? { actor: { displayName: actor.role === 'teacher' ? teacherDisplayName(actor) : actor.displayName } } : {}) };
}

module.exports = { FALLBACK_NAME, INTERNAL_FIELDS, STUDENT_HIDDEN_KEYS, OCR_PAGE_FIELDS, CORRECTION_FIELDS, FILE_FIELDS, ocrPageForStudent, correctionForStudent, fileForStudent, ocrCorrectionsForStudent, withoutInternal, worksheetForStudent, flashcardSetForStudent, teacherDisplayName, classForStudent, assignmentForStudent, submissionForStudent,
  membershipForStudent, legacyFeedbackForStudent, notificationForStudent, withoutInternalFields };
