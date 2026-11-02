'use strict';
// What a student may know about their teacher: a display name. Student responses replace populated `teacher` objects and bare teacher ids with
// teacherDisplayName, so no teacher email or id reaches a student. Teacher-facing endpoints do not go through this module.
const FALLBACK_NAME = 'Your teacher';
// Provider and scoring internals. No student page reads them.
const INTERNAL_FIELDS = ['evaluationProvider', 'evaluationModel', 'evaluationAttempts', 'evaluationPolicy', 'analysisInputHash'];

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

/** A submission as a student receives it, whether or not its assignment and class are populated. */
function submissionForStudent(value) {
  const submission = plain(value);
  if (!isObject(submission)) return submission;
  const owner = isObject(submission.assignment) && isObject(plain(submission.assignment).teacher) ? plain(submission.assignment).teacher : undefined;
  const out = withoutInternalFields(submission);
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

module.exports = { FALLBACK_NAME, INTERNAL_FIELDS, teacherDisplayName, classForStudent, assignmentForStudent, submissionForStudent,
  membershipForStudent, legacyFeedbackForStudent, notificationForStudent, withoutInternalFields };
