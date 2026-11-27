'use strict';
// The line a student or guest sees on the essay upload page while Similarity Reporting is on. The ONE place its wording and version live:
// GET /api/similarity/notice sends both to the page, and the upload stores the version it was shown with the time
// (Submission.similarityNotice). Only an essay that carries this notice may be sent to an external similarity service. Change the text ->
// change the version (services/similarity/policy.js NOTICE_VERSION), so every stored notice still says which wording was shown.
// It names no provider: the service is swappable (Copyscape, Copyleaks).
const { NOTICE_VERSION } = require('../services/similarity/policy');

const ESSAY_SIMILARITY_NOTICE_TEXT = 'Your teacher may check your essay for similarity. It can be compared with other essays in Rubrilo and sent to an '
  + 'external similarity-checking service that compares it with text on the internet. Only your teacher sees the result.';

/** The notice fields to store on a submission, or {} when the page did not show this exact version (or the feature is off). */
function noticeFields(body, { enabled, now = new Date() }) {
  if (!enabled || body?.similarityNoticeVersion !== NOTICE_VERSION) return {};
  return { similarityNotice: { version: NOTICE_VERSION, acceptedAt: now } };
}

module.exports = Object.freeze({ ESSAY_SIMILARITY_NOTICE_VERSION: NOTICE_VERSION, ESSAY_SIMILARITY_NOTICE_TEXT, noticeFields });
