'use strict';

const hasOwn = (value, key) => Boolean(value && Object.prototype.hasOwnProperty.call(value, key));

function asPlain(value) {
  return value && typeof value.toObject === 'function' ? value.toObject() : value;
}

function resolveTeacherComments({ submissionFeedback, legacyFeedback } = {}) {
  const canonical = asPlain(submissionFeedback);
  const legacy = asPlain(legacyFeedback);
  if (hasOwn(canonical, 'teacherComments')) return String(canonical.teacherComments ?? '');
  if (typeof legacy?.teacherComments === 'string' && legacy.teacherComments.trim()) return legacy.teacherComments;
  if (typeof legacy?.textFeedback === 'string' && legacy.textFeedback.trim()) return legacy.textFeedback;
  if (typeof canonical?.aiFeedback?.overallComments === 'string') return canonical.aiFeedback.overallComments;
  return '';
}

module.exports = { resolveTeacherComments, hasOwn };
