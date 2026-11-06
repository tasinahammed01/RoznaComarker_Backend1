'use strict';
// Maximum drafts per assignment (DRAFT_LIMIT_ENABLED, default off). Off: no limit anywhere and `maxDrafts` is neither stored nor shown, so
// everything behaves as before. On: an assignment that allows another draft has a limit (its own maxDrafts, else DEFAULT_MAX), counted as
// the submission chain's draftNumber, including the first draft. Registered students and guests use the same rule.
const MIN = 2;
const MAX = 10;
const DEFAULT_MAX = 3;
const CODE = 'DRAFT_LIMIT_REACHED';
const MESSAGE = 'Maximum number of drafts reached.';

const enabled = () => String(process.env.DRAFT_LIMIT_ENABLED || '').trim().toLowerCase() === 'true';
const validMax = value => Number.isInteger(value) && value >= MIN && value <= MAX;

/** The limit that applies to an assignment now, or null (no limit: flag off or no other draft allowed). */
function effectiveMax(assignment) {
  if (!enabled() || assignment?.allowResubmission !== true) return null;
  const stored = Number(assignment.maxDrafts);
  return validMax(stored) ? stored : DEFAULT_MAX;
}
const draftsUsed = submission => Math.max(1, Number(submission?.draftNumber) || 1);
/** True when the chain already has as many drafts as the limit allows. */
const limitReached = (assignment, submission) => { const max = effectiveMax(assignment); return max !== null && draftsUsed(submission) >= max; };
const limitError = () => Object.assign(new Error(MESSAGE), { statusCode: 403, code: CODE });

/**
 * A teacher's maxDrafts from a request body: undefined (not sent), null (clear), or a valid integer. Throws a 400 for anything else.
 * Flag off: always undefined (ignored), so nothing is stored.
 */
function parseFromBody(body) {
  if (!enabled() || !body || !Object.prototype.hasOwnProperty.call(body, 'maxDrafts')) return undefined;
  const value = body.maxDrafts;
  if (value === null) return null;
  if (!validMax(value)) throw Object.assign(new Error(`maxDrafts must be a whole number from ${MIN} to ${MAX}`), { statusCode: 400, code: 'INVALID_MAX_DRAFTS' });
  return value;
}

/** What a student or guest is told about an assignment: the effective limit, or no field at all. */
function forStudent(assignment) {
  if (!assignment || typeof assignment !== 'object') return assignment;
  const { maxDrafts: _stored, ...rest } = assignment;
  const max = effectiveMax(assignment);
  return max === null ? rest : { ...rest, maxDrafts: max };
}

const config = () => ({ enabled: enabled(), min: MIN, max: MAX, default: DEFAULT_MAX });

module.exports = { MIN, MAX, DEFAULT_MAX, CODE, MESSAGE, enabled, effectiveMax, draftsUsed, limitReached, limitError, parseFromBody, forStudent, config };
