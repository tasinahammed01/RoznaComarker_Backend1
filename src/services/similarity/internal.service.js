'use strict';
// Internal similarity (Rubrilo essays, no third party). Each essay whose marking completed is indexed as hashes of its 5-word sequences
// (models/SimilarityFingerprint.js, no text). A check finds candidate essays by their winnowed hashes, then marks exactly which of this
// essay's words they share. Never a source: the essay itself, or the same student's (or guest email's) essay for the same task. Never a
// match: words of the task brief, of the task's active reference files, inside quotes (setting), or common phrasing for the task.
const crypto = require('crypto');
const mongoose = require('mongoose');
const Submission = require('../../models/Submission');
const SimilarityFingerprint = require('../../models/SimilarityFingerprint');
const { buildCanonicalSubmissionTranscript } = require('../../utils/ocrTranscriptNormalizer');
const sourceFidelity = require('../../utils/sourceFidelity');
const { similarityEnabled } = require('./policy');
const { tokenize, quoteMask } = require('./normalize');
const { K, shingleHashes, winnow, matchRuns } = require('./fingerprints');
const logger = require('../../utils/logger');

const MAX_CANDIDATES = 200;
const MAX_INTERNAL_SOURCES = 20;
const MAX_TASK_ESSAYS = 500;
const TRANSCRIPT_FIELDS = Object.freeze(['_id', 'assignment', 'class', 'student', 'submissionMode', 'sourceKind', 'draftNumber', 'ocrJobId', 'files',
  'file', 'fileOrder', 'ocrPages', 'ocrData', 'sourceFidelityMode', 'sourceFidelityStatus', 'sourceFidelityVersion', 'sourceHumanReviewSummary',
  'sourceTranscriptExact', 'sourceTranscriptSha256']);

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const isId = value => mongoose.isValidObjectId(value) && String(new mongoose.Types.ObjectId(String(value))) === String(value);

/** 'student:<id>', 'guest:<24 hex of a one-way key of the email>', or 'submission:<id>' when neither is known (counted alone). */
function ownerKeyOf(submission) {
  if (submission.submissionMode !== 'guest' && submission.student) return `student:${submission.student}`;
  const email = String(submission.guest?.normalizedEmail || '').trim().toLowerCase();
  if (email) return `guest:${sha256(`similarity-guest:${email}`).slice(0, 24)}`;
  return `submission:${submission._id}`;
}

/**
 * The essay as a similarity check sees it, or null when the id is not an essay submission. eligible: an exact transcript only when
 * sourceFidelity.eligible (confirmed), any other transcript when it has words.
 */
async function loadEssay(submissionId) {
  if (!isId(submissionId)) return null;
  const submission = await Submission.findById(submissionId).select(`${TRANSCRIPT_FIELDS.join(' ')} +guest.normalizedEmail`).lean();
  if (!submission || submission.sourceKind === 'audio') return null;
  const [klass, assignment] = await Promise.all([
    mongoose.model('Class').findById(submission.class).select('teacher institutionId').lean(),
    mongoose.model('Assignment').findById(submission.assignment).select('instructions title writingType').lean()
  ]);
  if (!klass || !assignment || assignment.writingType === 'speaking') return null;
  let text = '';
  try { text = buildCanonicalSubmissionTranscript(submission)?.text || ''; } catch { text = ''; }
  const exact = sourceFidelity.isExact(submission);
  const tokens = tokenize(text);
  return { submission, klass, assignment, text, tokens, hashes: shingleHashes(tokens), origin: exact ? 'exact' : 'ocr',
    eligible: tokens.length > 0 && (!exact || sourceFidelity.eligible(submission)), ownerKey: ownerKeyOf(submission) };
}

/** Indexes (or re-indexes) one essay. Not eligible or empty: removes any old fingerprint and returns null. */
async function indexSubmission(submissionId) {
  const essay = await loadEssay(submissionId);
  if (!essay) return null;
  if (!essay.eligible) { await SimilarityFingerprint.deleteOne({ submissionId: essay.submission._id }); return null; }
  const doc = { assignmentId: essay.submission.assignment, classId: essay.submission.class, teacherId: essay.klass.teacher,
    institutionId: essay.klass.institutionId || undefined, ownerKey: essay.ownerKey, textSha256: sha256(essay.text), words: essay.tokens.length,
    hashes: winnow(essay.hashes), allHashes: essay.hashes, indexedAt: new Date() };
  return SimilarityFingerprint.findOneAndUpdate({ submissionId: essay.submission._id }, { $set: doc, ...(doc.institutionId ? {} : { $unset: { institutionId: 1 } }) },
    { upsert: true, returnDocument: 'after', lean: true });
}

/** Called after an essay's marking completes. Off unless SIMILARITY_ENABLED; never throws (marking must not depend on it). */
async function onAssessmentComplete(submissionId, env = process.env) {
  if (!similarityEnabled(env)) return;
  try { await indexSubmission(submissionId); } catch (error) {
    logger.warn?.({ event: 'similarity.index.failed', submissionId: String(submissionId), reason: error?.name || 'Error' });
  }
}

const markSequences = (mask, hashes, set) => hashes.forEach((hash, i) => {
  if (hash !== null && set.has(hash)) for (let j = i; j < i + K && j < mask.length; j++) mask[j] = true;
});

/** The words that never count as a match for this essay: quotes (setting), the brief, the task's active reference files, common phrasing. */
async function blockedMask(essay, settings) {
  const mask = settings.excludeQuotes ? quoteMask(essay.text, essay.tokens) : new Array(essay.tokens.length).fill(false);
  const ReferenceFile = mongoose.model('ReferenceFile');
  const refs = await ReferenceFile.find({ status: 'ready', activeSlot: { $exists: true },
    $or: [{ scope: 'class', class: essay.submission.class }, { scope: 'assignment', assignment: essay.submission.assignment }] })
    .select('+text').limit(10).lean();
  const brief = new Set();
  for (const value of [essay.assignment.instructions, ...refs.map(r => r.text)]) {
    for (const hash of shingleHashes(tokenize(String(value || '')))) if (hash !== null) brief.add(hash);
  }
  markSequences(mask, essay.hashes, brief);
  const others = await SimilarityFingerprint.find({ assignmentId: essay.submission.assignment, submissionId: { $ne: essay.submission._id } })
    .select('allHashes').limit(MAX_TASK_ESSAYS).lean();
  const essays = others.length + 1;
  if (essays >= settings.commonMinEssays) {
    const counts = new Map();
    for (const other of others) for (const hash of new Set(other.allHashes)) if (hash !== null) counts.set(hash, (counts.get(hash) || 0) + 1);
    const common = new Set();
    for (const hash of essay.hashes) {
      if (hash !== null && ((counts.get(hash) || 0) + 1) * 100 >= settings.commonSharePercent * essays) common.add(hash);
    }
    markSequences(mask, essay.hashes, common);
  }
  return mask;
}

const scopeFilter = (essay, scope) => {
  if (scope === 'own') return { teacherId: essay.klass.teacher };
  if (scope === 'institution') return essay.klass.institutionId ? { institutionId: essay.klass.institutionId } : { teacherId: essay.klass.teacher };
  return {};
};

/**
 * Internal sources for this essay: [{ kind: 'internal', refSubmissionId, refTeacherId, sameStudent, spans }], the most matched words first,
 * at most MAX_INTERNAL_SOURCES. Fingerprints of essays that no longer exist are removed.
 */
async function compareInternal(essay, blocked, settings) {
  const query = winnow(essay.hashes);
  if (!query.length) return [];
  const candidates = await SimilarityFingerprint.find({ hashes: { $in: query }, submissionId: { $ne: essay.submission._id },
    ...scopeFilter(essay, settings.internalScope) }).select('submissionId assignmentId teacherId ownerKey allHashes').limit(MAX_CANDIDATES).lean();
  const sameTask = c => c.ownerKey === essay.ownerKey && String(c.assignmentId) === String(essay.submission.assignment);
  const found = [];
  for (const c of candidates) {
    if (sameTask(c)) continue;
    const runs = matchRuns(essay.hashes, new Set(c.allHashes.filter(h => h !== null)), { minWords: settings.minMatchWords, blocked });
    if (!runs.length) continue;
    found.push({ kind: 'internal', refSubmissionId: c.submissionId, refTeacherId: c.teacherId, sameStudent: c.ownerKey === essay.ownerKey,
      spans: runs.map(r => ({ ...r, start: essay.tokens[r.wordStart].start, end: essay.tokens[r.wordEnd - 1].end })),
      words: runs.reduce((n, r) => n + r.wordEnd - r.wordStart, 0) });
  }
  if (found.length) {
    const alive = new Set((await Submission.find({ _id: { $in: found.map(f => f.refSubmissionId) } }).select('_id').lean()).map(s => String(s._id)));
    const gone = found.filter(f => !alive.has(String(f.refSubmissionId))).map(f => f.refSubmissionId);
    if (gone.length) await SimilarityFingerprint.deleteMany({ submissionId: { $in: gone } });
    return found.filter(f => alive.has(String(f.refSubmissionId))).sort((a, b) => b.words - a.words).slice(0, MAX_INTERNAL_SOURCES)
      .map(({ words, ...source }) => source);
  }
  return [];
}

module.exports = { loadEssay, indexSubmission, onAssessmentComplete, blockedMask, compareInternal, ownerKeyOf, MAX_INTERNAL_SOURCES, MAX_CANDIDATES };
