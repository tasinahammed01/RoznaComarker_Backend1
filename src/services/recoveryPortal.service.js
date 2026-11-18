'use strict';
// Multi-assignment recovery portal. One emailed link lists every submission made with that email address: guest submissions (the
// student's own and work a teacher uploaded) open from the list; work saved on the student ACCOUNT with that exact address (a class
// member, self-submitted or uploaded by the teacher) is listed as "Sign in to view" (title, class and date only, never results).
//   link token    32 random bytes (base64url, 43 chars), sent only in the email (URL fragment), stored as SHA-256, expires (default 24 h),
//                 usable a limited number of times (default 10), revocable.
//   portal session 32 random bytes, returned once by the exchange, sent as X-Recovery-Session, stored as SHA-256, short-lived
//                 (default 30 min, never past the link's expiry), READ-ONLY, and scoped to the link's email.
// Every lookup is constrained by the email behind the verified token: there is no other identity in this flow.
const crypto = require('crypto');
const RecoveryToken = require('../models/RecoveryToken');
const RecoverySession = require('../models/RecoverySession');
const Submission = require('../models/Submission');
const access = require('./guestAccess.service');
const logger = require('../utils/logger');

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const MAX_LIST = 200;
const PURGE_AFTER_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const GENERIC_INVALID = 'This recovery link is invalid or has expired. Request a new link.';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const sameHash = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length
  && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const bounded = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

function config(env = process.env) {
  return {
    linkHours: bounded(env.RECOVERY_LINK_TTL_HOURS, 1, 168, 24),
    maxUses: bounded(env.RECOVERY_LINK_MAX_USES, 1, 100, 10),
    sessionMinutes: bounded(env.RECOVERY_SESSION_MINUTES, 5, 240, 30),
  };
}

const invalidLink = () => access.fail(410, GENERIC_INVALID, 'RECOVERY_LINK_INVALID');

/** Validates and normalises an email address (same rules as guest submissions). Throws a 400 for a malformed address only. */
function normalizeEmail(email) {
  return access.identity({ name: 'Recovery', email }).normalizedEmail;
}

const portalLink = token => access.frontendLink(`/recover/portal#${token}`);

/** The student account registered with exactly this (normalised) address, if any. The emailed token proves control of the mailbox. */
const accountFor = emailNormalized => require('../models/user.model').findOne({ email: emailNormalized, role: 'student' }).select('_id').lean();

/**
 * Creates a link and emails it, but only when the address has at least one guest submission and has not asked too often.
 * Returns what happened (for tests and the future teacher flow); callers facing the public never reveal it.
 * `source`/`issuedBy` let a teacher issue a link later (Task 5) through this same function.
 */
async function issueLink(emailNormalized, { source = 'student', issuedBy = null, now = new Date(), env = process.env } = {}) {
  const settings = config(env);
  const account = await accountFor(emailNormalized);
  const hasSubmissions = await Submission.exists({ submissionMode: 'guest', 'guest.normalizedEmail': emailNormalized, 'guest.revokedAt': null })
    || (account && (await accountWork(account._id)).length > 0);   // very old records have no submissionMode
  if (!hasSubmissions) return { sent: false, reason: 'no_submissions' };
  // Shared with the single-submission link resend: per-address cool-down and hourly cap, both atomic.
  const slot = await require('./recoveryEmailQuota.service').claim(emailNormalized, { now, env });
  if (!slot.granted) return { sent: false, reason: slot.reason };
  const token = crypto.randomBytes(32).toString('base64url');
  let link;
  try { link = portalLink(token); }   // validates FRONTEND_URL before anything is stored
  catch (error) { await slot.release(); throw error; }
  const expiresAt = new Date(now.getTime() + settings.linkHours * 3600000);
  const doc = await RecoveryToken.create({ emailNormalized, tokenHash: sha(token), expiresAt, source, issuedBy,
    purgeAt: new Date(expiresAt.getTime() + PURGE_AFTER_EXPIRY_MS) });
  const delivery = await require('./email.service').sendRecoveryPortalEmail({ to: emailNormalized, link, expiresInHours: settings.linkHours });
  if (!delivery?.success) {
    // An undelivered link is useless; revoke it so it can never be used.
    await RecoveryToken.updateOne({ _id: doc._id }, { $set: { revokedAt: new Date() } });
    // The student must be able to ask again at once: the cool-down and hourly slot are given back.
    await slot.release();
    logger.warn({ event: 'recovery_link_delivery_failed', code: /^[A-Z_]{1,40}$/.test(delivery?.code || '') ? delivery.code : 'UNKNOWN' });
    return { sent: false, reason: 'delivery_failed' };
  }
  logger.info({ event: 'recovery_link_issued', source });
  return { sent: true };
}

/** Link token -> portal session. Any problem (shape, unknown, expired, revoked, used up) is the same generic 410. */
async function exchange(rawToken, { now = new Date(), env = process.env } = {}) {
  if (typeof rawToken !== 'string' || !TOKEN_SHAPE.test(rawToken)) throw invalidLink();
  const settings = config(env), tokenHash = sha(rawToken);
  const found = await RecoveryToken.findOne({ tokenHash }).select('+tokenHash').lean();
  if (!found || !sameHash(found.tokenHash, tokenHash)) { logger.warn({ event: 'recovery_link_rejected', reason: 'unknown' }); throw invalidLink(); }
  // Count the use atomically, only while the link is still valid.
  const used = await RecoveryToken.findOneAndUpdate({ _id: found._id, revokedAt: null, expiresAt: { $gt: now }, usedCount: { $lt: settings.maxUses } },
    { $inc: { usedCount: 1 }, $set: { lastUsedAt: now } }, { returnDocument: 'after' }).lean();
  if (!used) {
    logger.warn({ event: 'recovery_link_rejected', reason: found.revokedAt ? 'revoked' : found.expiresAt <= now ? 'expired' : 'used_up' });
    throw invalidLink();
  }
  const session = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Math.min(now.getTime() + settings.sessionMinutes * 60000, new Date(used.expiresAt).getTime()));
  await RecoverySession.create({ tokenId: used._id, emailNormalized: used.emailNormalized, sessionHash: sha(session), expiresAt });
  logger.info({ event: 'recovery_link_exchanged', useCount: used.usedCount });
  return { session, expiresAt };
}

/** X-Recovery-Session -> { emailNormalized }. Rejects unknown, expired or revoked sessions, and sessions of a revoked link. */
async function verifySession(rawSession, { now = new Date() } = {}) {
  if (typeof rawSession !== 'string' || !TOKEN_SHAPE.test(rawSession)) throw invalidLink();
  const sessionHash = sha(rawSession);
  const found = await RecoverySession.findOne({ sessionHash, revokedAt: null, expiresAt: { $gt: now } }).select('+sessionHash').lean();
  if (!found || !sameHash(found.sessionHash, sessionHash)) throw invalidLink();
  const link = await RecoveryToken.findOne({ _id: found.tokenId, revokedAt: null }).select('_id').lean();
  if (!link) throw invalidLink();
  return { emailNormalized: found.emailNormalized, sessionId: found._id };
}

// Same status rule as the result page (canonicalResultState.guestResultStatus), so the list never promises what the page does not show.
const listStatus = (submission, feedback) => {
  const { status } = require('./canonicalResultState.service').guestResultStatus({ submission, feedback });
  return status === 'complete' ? 'ready' : ['failed', 'blocked'].includes(status) ? 'failed' : 'processing';
};

/** A guest recording's list status from the speaking result state (speakingResult.stateOf, as the student sees it). */
const speakingListStatus = (submission, recording, feedback) => {
  const state = require('./audio/speakingResult.service').stateOf({ recording: recording || null, submission, feedback, audience: 'student' });
  return state === 'ready' ? 'ready' : ['transcribing', 'assessing'].includes(state) ? 'processing' : 'failed';
};

// Old records can carry a missing, null or invalid assignment/class id. String() of those gave "undefined", "null" or e.g.
// "legacy-class", and one such value in an $in query threw a CastError that failed the WHOLE list (503 RECOVERY_FAILED). Ids are now
// checked first; a row that cannot be read is skipped and logged with its submission id and a fixed reason code only.
const OBJECT_ID = /^[a-f\d]{24}$/i;
/** The id as a 24-hex string, or null. Accepts an ObjectId, a populated document or a 24-hex string (isValidObjectId alone also
 *  accepts any 12-character string, such as "legacy-class"). */
function idString(value) {
  const raw = value && typeof value === 'object' && value._id ? value._id : value;
  if (raw == null || (typeof raw !== 'string' && typeof raw !== 'object')) return null;
  const text = String(raw);
  return OBJECT_ID.test(text) ? text : null;
}
/** MISSING_* for an absent/null value, INVALID_* for one that is present but not an id, null when usable. */
const idProblem = (value, what) => (value == null || value === '' ? `MISSING_${what}` : idString(value) ? null : `INVALID_${what}`);
/** Ids, counts and codes only: never the email, a title or the error text. */
const skipRow = (submissionId, reason) => logger.warn({ event: 'recovery_portal_row_skipped', code: 'RECOVERY_ROW_SKIPPED',
  reason: /^[A-Z_]{1,40}$/.test(reason) ? reason : 'MAPPING_FAILED', submissionId: idString(submissionId) || 'unknown' });
const STAGES = ['account_lookup', 'lookup', 'mapping'];

// The listing queries fetch LIGHT rows and are not sorted by the database. Sorting heavy submissions (OCR pages with per-word boxes,
// corrections, annotations) needed a blocking in-memory sort with no supporting index; where that sort may not spill to disk it
// failed with MongoServerError 292 (QueryExceededMemoryLimitNoDiskUseAllowed) and the whole list answered 503. Rows are now
// sorted here, newest first, after at most LIST_SCAN_CAP rows per query (far more than one address has; reaching it is logged).
const LIST_SCAN_CAP = 1000;
// Exactly what a guest row reads: the row itself (_id, assignment, dates, teacherUpload.uploadedBy) and the result page's status
// (canonicalResultState.guestResultStatus: the stage statuses, hashes and versions; only the `source` of each correction; for
// exact-source submissions the page-level source fields, never the per-word data).
// sourceKind and audioRecording (stage 10): a guest recording is listed with kind 'speaking' and the speaking result state.
const GUEST_LIST_FIELDS = ['_id', 'assignment', 'submittedAt', 'createdAt', 'teacherUpload.uploadedBy', 'sourceKind', 'audioRecording',
  'assessmentStatus', 'assessmentCompletedAt', 'ocrStatus', 'ocrErrorCode',
  'correctionStatus', 'correctionError', 'correctionRetry', 'correctionSourceHash', 'correctionStatistics', 'correctionTranscriptLayoutVersion',
  'evaluationStatus', 'evaluationError', 'evaluationErrorCode', 'evaluationJobId', 'evaluationPolicyHash', 'evaluationRubricSourceHash', 'evaluationVersion',
  'semanticStatus', 'semanticAttempt', 'semanticMaxAttempts', 'semanticMetrics', 'semanticNextRetryAt', 'semanticErrorCode',
  'writingCorrections.source',
  'sourceFidelityMode', 'sourceFidelityStatus', 'sourceHumanReviewSummary', 'sourceTranscriptExact', 'sourceTranscriptSha256', 'files', 'file',
  'ocrPages.fileId', 'ocrPages.fileOrder', 'ocrPages.pageIndex', 'ocrPages.sourceFidelityStatus', 'ocrPages.sourceVerificationStage',
  'ocrPages.sourceTextExact', 'ocrPages.sourceTextSha256'].join(' ');
// An account row reads only its ids and dates; submissionMode separates account work from guest work.
const ACCOUNT_LIST_FIELDS = '_id assignment class submittedAt createdAt submissionMode';
const timeOf = value => { const at = value ? new Date(value).getTime() : NaN; return Number.isFinite(at) ? at : -Infinity; };
/** Newest submittedAt first (missing dates last), then the newer _id: the order the database sort gave. */
const newestFirst = rows => rows.slice().sort((a, b) => (timeOf(b.submittedAt) - timeOf(a.submittedAt)) || (String(b._id) < String(a._id) ? -1 : String(b._id) > String(a._id) ? 1 : 0));
/** Account work of a student: queried by student only (so only student-led indexes apply); any non-guest submission counts. */
const accountWork = async studentId => (await Submission.find({ student: studentId }).select(ACCOUNT_LIST_FIELDS).limit(LIST_SCAN_CAP).lean())
  .filter(s => s.submissionMode !== 'guest');

/**
 * Every guest submission made with this email whose assignment and class are still open to guests (the same conditions the result
 * page checks), then the essay submissions on the student account with this exact address in its active classes ("Sign in to
 * view"); any submission that is not a guest submission counts as account work, so very old records without submissionMode are
 * included. Minimal projection: no scores, no feedback, no names, no email, no teacher or class ids; account rows carry an opaque
 * key instead of the submission id and no status. Archived classes and inactive assignments are left out. A row with an unusable
 * assignment or class id, or one that fails while it is mapped, is skipped (RECOVERY_ROW_SKIPPED); the rest are listed. A failure
 * of the whole list carries error.stage ('account_lookup' | 'lookup' | 'mapping') for the controller's log.
 */
async function listAssignments(emailNormalized) {
  let stage = 'account_lookup';
  try {
    const Assignment = require('../models/assignment.model'), Class = require('../models/class.model');
    const account = await accountFor(emailNormalized);
    stage = 'lookup';
    const [guestFound, accountFound] = await Promise.all([
      Submission.find({ submissionMode: 'guest', 'guest.normalizedEmail': emailNormalized, 'guest.revokedAt': null })
        .select(GUEST_LIST_FIELDS).limit(LIST_SCAN_CAP).lean(),
      account ? accountWork(account._id) : []]);
    if (guestFound.length >= LIST_SCAN_CAP || accountFound.length >= LIST_SCAN_CAP) logger.warn({ event: 'recovery_portal_cap_reached', code: 'RECOVERY_CAP_REACHED' });
    const submissions = newestFirst(guestFound).slice(0, MAX_LIST), accountSubmissions = newestFirst(accountFound).slice(0, MAX_LIST);
    if (!submissions.length && !accountSubmissions.length) return [];
    // Rows whose own ids cannot be used are skipped before any query sees them.
    const usable = (rows, { needsClass }) => rows.filter(s => {
      const reason = idProblem(s.assignment, 'ASSIGNMENT') || (needsClass ? idProblem(s.class, 'CLASS') : null);
      if (reason) skipRow(s._id, reason);
      return !reason;
    });
    const guestSubs = usable(submissions, { needsClass: false }), accountSubs = usable(accountSubmissions, { needsClass: true });
    const assignmentIds = [...new Set([...guestSubs, ...accountSubs].map(s => idString(s.assignment)))];
    const assignments = assignmentIds.length ? await Assignment.find({ _id: { $in: assignmentIds }, isActive: true })
      .select('_id title class teacher allowGuestSubmission resourceType').lean() : [];
    const assignmentById = new Map(assignments.map(a => [String(a._id), a]));
    const classIds = [...new Set(assignments.map(a => idString(a.class)).filter(Boolean))];
    const classes = classIds.length ? await Class.find(require('./classLifecycle.service').withActiveStatus({ _id: { $in: classIds }, isActive: true }))
      .select('_id name teacher').lean() : [];
    const classById = new Map(classes.map(c => [String(c._id), c]));
    const feedbacks = guestSubs.length ? await require('../models/SubmissionFeedback').find({ submissionId: { $in: guestSubs.map(x => x._id) } }).lean() : [];
    const feedbackBySubmission = new Map(feedbacks.map(fb => [String(fb.submissionId), fb]));
    const recordingIds = guestSubs.filter(s => s.sourceKind === 'audio' && s.audioRecording).map(s => s.audioRecording);
    const recordings = recordingIds.length ? await require('../models/AudioRecording').find({ _id: { $in: recordingIds } }).select('_id status').lean() : [];
    const recordingById = new Map(recordings.map(r => [String(r._id), r]));
    stage = 'account_lookup';
    const memberClassIds = [...new Set(accountSubs.map(s => idString(s.class)))];
    const memberOf = account && memberClassIds.length ? new Set((await require('../models/membership.model')
      .find({ student: account._id, class: { $in: memberClassIds }, status: 'active' }).select('class').lean()).map(m => String(m.class))) : new Set();
    stage = 'mapping';
    /** The assignment and class of one row, or null (a deleted or closed one is left out silently, as before; an assignment whose
     *  own class id is unusable is skipped and logged). */
    const placeOf = s => {
      const assignment = assignmentById.get(idString(s.assignment));
      if (!assignment) return null;
      const classProblem = idProblem(assignment.class, 'CLASS');
      if (classProblem) { skipRow(s._id, classProblem); return null; }
      const classDoc = classById.get(idString(assignment.class));
      if (!classDoc || String(classDoc.teacher) !== String(assignment.teacher)) return null;
      return { assignment, classDoc };
    };
    const mapRow = (s, build) => { try { return build(); } catch { skipRow(s._id, 'MAPPING_FAILED'); return []; } };
    const guestRows = guestSubs.flatMap(s => mapRow(s, () => {
      const place = placeOf(s);
      if (!place) return [];
      const { assignment, classDoc } = place;
      // Guest submissions need an assignment open to guests; work a teacher uploaded is listed whatever that setting is.
      if (assignment.allowGuestSubmission !== true && !s.teacherUpload?.uploadedBy) return [];
      const row = { id: String(s._id), assignmentTitle: String(assignment.title || '').slice(0, 200), className: String(classDoc.name || '').slice(0, 120),
        submittedAt: s.submittedAt || s.createdAt || null };
      // A recording: the speaking result state (the essay rule reads OCR fields a recording never has) and its kind, so it opens the speaking page.
      if (s.sourceKind === 'audio') return [{ ...row, status: speakingListStatus(s, recordingById.get(String(s.audioRecording)), feedbackBySubmission.get(String(s._id)) || null),
        kind: 'speaking' }];
      return [{ ...row, status: listStatus(s, feedbackBySubmission.get(String(s._id)) || null) }];
    }));
    // Account work: essays in classes the student is still an active member of. Only the student, signed in, can open it.
    const accountRows = accountSubs.flatMap(s => mapRow(s, () => {
      const place = placeOf(s);
      if (!place || !memberOf.has(String(place.classDoc._id))) return [];
      const { assignment, classDoc } = place;
      if (assignment.resourceType && !['essay', 'speaking'].includes(assignment.resourceType)) return [];
      return [{ access: 'signIn', assignmentTitle: String(assignment.title || '').slice(0, 200), className: String(classDoc.name || '').slice(0, 120),
        submittedAt: s.submittedAt || s.createdAt || null, ...(assignment.resourceType === 'speaking' ? { kind: 'speaking' } : {}) }];
    }));
    const time = row => { const at = row.submittedAt ? new Date(row.submittedAt).getTime() : 0; return Number.isFinite(at) ? at : 0; };
    return [...guestRows, ...accountRows.sort((a, b) => time(b) - time(a)).map((row, index) => ({ id: `account-${index + 1}`, ...row }))].slice(0, MAX_LIST);
  } catch (error) {
    if (error && typeof error === 'object' && !STAGES.includes(error.stage)) error.stage = stage;
    throw error;
  }
}

/** The guest submission, only if it belongs to the session's email. Same generic error otherwise (no existence oracle). */
async function submissionForSession(submissionId, rawSession) {
  const { emailNormalized } = await verifySession(rawSession);
  if (!/^[a-f\d]{24}$/i.test(String(submissionId || ''))) throw invalidLink();
  const doc = await Submission.findOne({ _id: submissionId, submissionMode: 'guest', 'guest.normalizedEmail': emailNormalized, 'guest.revokedAt': null });
  if (!doc) { logger.warn({ event: 'recovery_portal_denied' }); throw access.fail(404, 'Results unavailable.', 'RECOVERY_NOT_FOUND'); }
  return doc;
}

async function endSession(rawSession) {
  if (typeof rawSession !== 'string' || !TOKEN_SHAPE.test(rawSession)) return;
  await RecoverySession.updateOne({ sessionHash: sha(rawSession), revokedAt: null }, { $set: { revokedAt: new Date() } });
}

/** Revokes every live link (and so every portal session) of an address. For support and the future teacher flow. */
async function revokeAllForEmail(emailNormalized) {
  const result = await RecoveryToken.updateMany({ emailNormalized, revokedAt: null }, { $set: { revokedAt: new Date() } });
  return result.modifiedCount || 0;
}

module.exports = { config, normalizeEmail, issueLink, exchange, verifySession, listAssignments, submissionForSession, endSession, revokeAllForEmail,
  sha, TOKEN_SHAPE, GENERIC_INVALID };
