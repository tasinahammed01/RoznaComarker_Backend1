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
  'createdBy', 'ownerId', 'sourceContent', 'shareToken', 'isPublic', 'isPublished', 'generationSource', 'answerKey']);

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
  return out;
}

/** A membership with its populated class. */
function membershipForStudent(value) {
  const membership = plain(value);
  return isObject(membership) ? { ...membership, class: classForStudent(membership.class) } : membership;
}

/** The legacy feedback document (populateFeedback): teacher, class, assignment, submission, and who overrode it. */
function legacyFeedbackForStudent(value) {
  const { teacher, overriddenBy: _overriddenBy, ...rest } = plain(value);
  const owner = isObject(teacher) ? teacher : undefined;
  return { ...rest, teacherDisplayName: teacherDisplayName(owner),
    ...(isObject(rest.assignment) ? { assignment: assignmentForStudent(rest.assignment, owner) } : {}),
    ...(isObject(rest.class) ? { class: classForStudent(rest.class, owner) } : {}),
    ...(isObject(rest.submission) ? { submission: submissionForStudent(rest.submission) } : {}) };
}

/** A notification as its student recipient sees it: the sender by name only. */
function notificationForStudent(value) {
  const notification = plain(value);
  if (!isObject(notification)) return notification;
  const { actor, ...rest } = notification;
  return { ...rest, ...(isObject(actor) ? { actor: { displayName: actor.role === 'teacher' ? teacherDisplayName(actor) : actor.displayName } } : {}) };
}

module.exports = { FALLBACK_NAME, INTERNAL_FIELDS, STUDENT_HIDDEN_KEYS, withoutInternal, worksheetForStudent, flashcardSetForStudent, teacherDisplayName, classForStudent, assignmentForStudent, submissionForStudent,
  membershipForStudent, legacyFeedbackForStudent, notificationForStudent, withoutInternalFields };
