'use strict';

const MARK_KEYS = new Set([
  'score',
  'scoreOutOf5',
  'overallScore',
  'grade',
  'percentage',
  'earnedPoints',
  'weightedPoints',
  'configuredLevelPercentage',
  'selectedLevel'
]);

function showMarksToStudent(assignment) {
  return !assignment || assignment.showMarksToStudent !== false;
}

function redactMarkFields(value) {
  if (Array.isArray(value)) return value.map(redactMarkFields);
  if (!value || typeof value !== 'object') return value;

  // Preserve ObjectIds, Dates, Buffers, and other serializable class values.
  // Recursing into them would turn identifiers into implementation details.
  if (
    value instanceof Date ||
    Buffer.isBuffer(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return value;
  }

  const redacted = {};
  for (const [key, nested] of Object.entries(value)) {
    if (MARK_KEYS.has(key) || key === 'overriddenScores') continue;
    redacted[key] = redactMarkFields(nested);
  }
  return redacted;
}

function redactStudentMarks(payload) {
  const redacted = {
    ...redactMarkFields(payload),
    marksVisible: false
  };
  redacted.previousEvaluation = null;
  return redacted;
}

function sanitizeAdaptiveSession(session, marksVisible, revealedActivityIds = []) {
  if (!session) return session;
  const safe = session && typeof session.toObject === 'function' ? session.toObject() : { ...session };
  const revealed = new Set(Array.from(revealedActivityIds || [], String));
  safe.activities = Array.isArray(safe.activities) ? safe.activities.map((activity) => {
    const publicActivity = { ...activity };
    delete publicActivity.correctOptionId;
    delete publicActivity.acceptedAnswers;
    if (!revealed.has(String(activity.activityId))) delete publicActivity.modelAnswer;
    return publicActivity;
  }) : [];
  if (!marksVisible && safe.sourceSnapshot) {
    safe.sourceSnapshot = {
      transcriptFingerprint: safe.sourceSnapshot.transcriptFingerprint,
      feedbackId: safe.sourceSnapshot.feedbackId,
      feedbackUpdatedAt: safe.sourceSnapshot.feedbackUpdatedAt
    };
  }
  return safe;
}

module.exports = {
  showMarksToStudent,
  redactStudentMarks,
  sanitizeAdaptiveSession
};
