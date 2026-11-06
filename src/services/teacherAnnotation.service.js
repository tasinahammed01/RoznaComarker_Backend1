'use strict';
// Teacher annotation overlay: state, lifecycle and validation (Task 6A). What students see is decided only by
// studentCorrectionView.service; this module never filters corrections itself.
//
// Stored in Submission.teacherAnnotations (select:false):
//   { version: 2, revision, scoringReviewRequired, scoringReview (scoreReview.service), entries: [Entry], recent: [last RECENT_AUDIT audit rows] }
//   Entry = { id, kind: 'ai' | 'manual', targetId (ai: the AI correction id it was created for), status: 'visible' | 'hidden' | 'archived',
//             edited (ai: teacher replaced the AI text), value (edited/manual correction), anchor (where the decision applies),
//             valueAnchor (where an edited/manual value is placed), draftNumber, createdAt, createdBy, updatedAt, updatedBy }
// "Orphaned / needs review" is derived on every read (the anchor no longer locates or matches), never stored, so a later regenerate
// that re-detects the text applies the decision again.
// Version 1 overlays ({ revision, entries: [{ id, sourceHash, status: visible|hidden|rejected, value, original }], audit }) are read
// through normalizeState(); the first write stores version 2.
const crypto = require('crypto');
const { ocrEvidenceHash } = require('./correctionEvidenceIdentity.service');
const { legendIndex } = require('./correctionCanonical.service');
const { buildCanonicalSubmissionTranscript } = require('../utils/ocrTranscriptNormalizer');
const anchors = require('./annotationAnchor.service');

const fail = (statusCode, code) => Object.assign(new Error(code), { statusCode, code });
const copy = value => value == null ? null : JSON.parse(JSON.stringify(value));
const ACTIONS = ['add', 'edit', 'hide', 'restore', 'archive', 'reject'];
const RECENT_AUDIT = 20;
const MAX_ENTRIES = 1000;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
// Lifecycle. `reject` is the version-1 name of `archive`.
const TRANSITIONS = Object.freeze({
  hide: { from: ['visible'], to: 'hidden' },
  restore: { from: ['hidden', 'archived'], to: 'visible' },
  archive: { from: ['visible', 'hidden'], to: 'archived' },
  edit: { from: ['visible', 'hidden'], to: null },
  add: { from: [], to: 'visible' },
});
// Orphaned entries (derived: the anchor no longer matches) have their own table. Orphans are never shown to students, so restoring an
// archived orphan returns it to "needs review", not to the student: see restoredOrphanStatus.
const ORPHAN_TRANSITIONS = Object.freeze({
  edit: { from: ['visible', 'hidden'], to: null },
  archive: { from: ['visible', 'hidden'], to: 'archived' },
  restore: { from: ['archived'], to: 'orphaned' },
});
/**
 * The status an archived orphan comes back with. An AI entry goes to hidden, so it keeps suppressing any re-detected correction (fail
 * closed; as "visible" it would stop doing so and the correction could reach the student). A manual entry goes to visible: it is shown
 * only if and when its text can be located again, like any manual correction.
 */
const restoredOrphanStatus = entry => entry.kind === 'manual' ? 'visible' : 'hidden';
const EDITABLE = ['symbol', 'category', 'message', 'suggestedText', 'startChar', 'endChar', 'quotedText', 'fileId', 'page'];

function emptyState() { return { version: 2, revision: 0, scoringReviewRequired: false, scoringReview: null, entries: [], recent: [] }; }

/** Version 1 entry -> version 2 entry. Anchors have no context (the old text is gone), so repeated quotes may become ambiguous. */
function upgradeEntry(e) {
  const kind = String(e.id || '').startsWith('teacher_') ? 'manual' : 'ai';
  const target = e.original || e.value || {};
  const legacyAnchor = (v, hash) => v && Number.isInteger(v.startChar) ? { fileId: String(v.fileId), page: Number(v.page || 1),
    startChar: v.startChar, endChar: v.endChar, quotedText: v.quotedText, before: '', after: '', sourceHash: hash } : null;
  const edited = kind === 'ai' && Boolean(e.value && e.original) && EDITABLE.some(k => JSON.stringify(e.value[k]) !== JSON.stringify(e.original[k]));
  return { id: String(e.id), kind, ...(kind === 'ai' ? { targetId: String(e.id) } : {}), status: e.status === 'rejected' ? 'archived' : e.status,
    edited, ...(edited || kind === 'manual' ? { value: copy(e.value), valueAnchor: legacyAnchor(e.value, e.sourceHash) } : {}),
    anchor: legacyAnchor(target, e.sourceHash), legacy: true };
}

/** The overlay as a version 2 state (never mutates the stored value). */
function normalizeState(raw) {
  if (!raw || typeof raw !== 'object') return emptyState();
  if (raw.version === 2) return { ...emptyState(), ...copy(raw) };
  return { ...emptyState(), revision: Number(raw.revision || 0), scoringReviewRequired: Boolean(raw.scoringReviewRequired), scoringReview: copy(raw.scoringReview),
    entries: (raw.entries || []).map(upgradeEntry), legacyAudit: copy(raw.audit || []) };
}

function source(doc) {
  if (!require('../utils/sourceFidelity').eligible(doc)) throw fail(409, 'ANNOTATION_SOURCE_UNAVAILABLE');
  const canonical = buildCanonicalSubmissionTranscript(doc);
  if (!canonical.isComplete || !canonical.text) throw fail(409, 'ANNOTATION_SOURCE_UNAVAILABLE');
  return { canonical, sourceHash: ocrEvidenceHash(canonical, doc) };
}

function boundary(text, at) {
  return !(at > 0 && at < text.length && /[\uD800-\uDBFF]/.test(text[at-1]) && /[\uDC00-\uDFFF]/.test(text[at]))
    && !(text[at-1] === '\r' && text[at] === '\n');
}
/** A teacher-supplied correction value, checked against the current canonical transcript. Text is stored raw and escaped at render. */
function validateValue(raw, canonical, hash, id, origin) {
  const keys = ['fileId','page','startChar','endChar','quotedText','symbol','category','message','suggestedText'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !keys.includes(k))) throw fail(400,'ANNOTATION_INVALID_FIELDS');
  const meta = legendIndex().get(raw.symbol);
  if (!meta || raw.category !== meta.category) throw fail(400,'ANNOTATION_INVALID_CATEGORY');
  for (const [key, max] of [['message',2000],['suggestedText',2000],['quotedText',4000]]) {
    if (typeof raw[key] !== 'string' || !raw[key].trim() || raw[key].length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(raw[key])) throw fail(400,'ANNOTATION_INVALID_TEXT');
  }
  const page = canonical.pages.find(p => String(p.fileId) === raw.fileId && p.pageNumber === raw.page);
  const start = raw.startChar, end = raw.endChar;
  if (!page || !Number.isInteger(start) || !Number.isInteger(end) || start < page.startChar || end > page.endChar || end <= start
      || !boundary(canonical.text,start) || !boundary(canonical.text,end) || canonical.text.slice(start,end) !== raw.quotedText) throw fail(400,'ANNOTATION_INVALID_SPAN');
  const spans = canonical.wordSpans.filter(w => String(w.fileId) === raw.fileId && w.page === raw.page && start < w.end && end > w.start);
  if (!spans.length) throw fail(400,'ANNOTATION_UNMAPPED_SPAN');
  // Only canonical active words establish source authority. Never accept client boxes.
  return { ...copy(raw), id, source: origin, category: meta.category, canonicalCategory: meta.category,
    groupKey: meta.category, color: meta.color, symbolLabel: meta.symbolLabel,
    wordIds: spans.map(w => w.wordId), evidenceWordIds: spans.map(w => w.wordId), bboxList: [],
    ocrEvidenceHash: hash, teacherGrounded: true, editable: false };
}

const requestHashOf = (actor, body) => crypto.createHash('sha256').update(JSON.stringify({ actor: String(actor), ...body })).digest('hex');

/** Shape checks that need no database state. Returns the normalised action. */
function checkBody(body) {
  if (JSON.stringify(body || {}).length > 16000) throw fail(413,'ANNOTATION_PAYLOAD_TOO_LARGE');
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(k => !['action','id','revision','sourceHash','requestId','value'].includes(k))) throw fail(400,'ANNOTATION_INVALID_FIELDS');
  if (!ACTIONS.includes(body.action) || !/^[a-f0-9-]{36}$/i.test(body.requestId || '') || !Number.isInteger(body.revision)
      || typeof body.sourceHash !== 'string' || (body.action !== 'add' && (typeof body.id !== 'string' || !body.id || body.id.length > 120))) throw fail(400,'ANNOTATION_INVALID_REQUEST');
  if (['add', 'edit'].includes(body.action) ? body.value === undefined : body.value !== undefined) throw fail(400,'ANNOTATION_INVALID_FIELDS');
  return body.action === 'reject' ? 'archive' : body.action;
}

/** An earlier request with the same id: replay it, or refuse a different body under a reused id. */
function replayOf(prior, actor, body) {
  if (!prior) return null;
  if (prior.requestHash !== requestHashOf(actor, body)) throw fail(409,'ANNOTATION_IDEMPOTENCY_CONFLICT');
  return { replay: true, revision: prior.newRevision };
}

/**
 * Applies one teacher action to the overlay. `resolution` is the current read-time resolution (studentCorrectionView.resolveOverlay):
 * it maps current AI correction ids to the entries that govern them and lists orphaned entries.
 * Returns { state, auditRow, revision } or { replay, revision }.
 */
function prepare(doc, actor, body, { resolution, prior, now = new Date() } = {}) {
  const action = checkBody(body);
  const state = normalizeState(doc.teacherAnnotations);
  const replay = replayOf(prior || [...(state.recent || []), ...(state.legacyAudit || [])].find(a => a.requestId === body.requestId), actor, body);
  if (replay) return replay;
  const { canonical, sourceHash } = source(doc);
  if (body.revision !== state.revision || body.sourceHash !== sourceHash) throw fail(409,'ANNOTATION_REVISION_CONFLICT');
  const draftNumber = Math.max(1, Number(doc.draftNumber) || 1);
  // Entries of earlier drafts live on in the revision snapshot of that draft (submissionRevision.service).
  state.entries = state.entries.filter(e => e.draftNumber == null || e.draftNumber >= draftNumber);
  const at = now.toISOString();

  let entry;
  if (action === 'add') {
    if (state.entries.length >= MAX_ENTRIES) throw fail(409,'ANNOTATION_HISTORY_LIMIT');
    entry = { id: `teacher_${crypto.randomUUID()}`, kind: 'manual', status: null, edited: false, draftNumber, createdAt: at, createdBy: String(actor) };
    state.entries.push(entry);
  } else {
    entry = state.entries.find(e => e.id === body.id);
    if (!entry) {
      const governing = resolution.entryIdByAiId.get(body.id);
      if (governing) entry = state.entries.find(e => e.id === governing);
    }
    if (!entry) {
      const ai = resolution.aiById.get(body.id);
      if (!ai) throw fail(404,'ANNOTATION_NOT_FOUND');
      if (state.entries.length >= MAX_ENTRIES) throw fail(409,'ANNOTATION_HISTORY_LIMIT');
      entry = { id: `ann_${crypto.randomUUID()}`, kind: 'ai', targetId: String(ai.id), status: 'visible', edited: false,
        anchor: anchors.capture(ai, canonical, sourceHash), draftNumber, createdAt: at, createdBy: String(actor) };
      state.entries.push(entry);
    }
  }
  const before = copy({ ...entry, status: entry.status });
  const orphaned = resolution.orphanIds.has(entry.id);
  const rule = orphaned ? ORPHAN_TRANSITIONS[action] : TRANSITIONS[action];
  if (orphaned && !rule?.from.includes(entry.status)) throw fail(409,'ANNOTATION_ORPHANED');
  if (action !== 'add' && !rule.from.includes(entry.status)) throw fail(409,'ANNOTATION_STATE_CONFLICT');

  let changedFields = [];
  if (action === 'add' || action === 'edit') {
    const origin = entry.kind === 'manual' || (orphaned && entry.kind === 'ai') ? 'Teacher' : 'AI';
    const value = validateValue(body.value, canonical, sourceHash, entry.id, origin);
    const reference = entry.value || resolution.aiById.get(entry.targetId) || {};
    changedFields = action === 'edit' ? EDITABLE.filter(k => JSON.stringify(body.value[k]) !== JSON.stringify(reference[k])) : [];
    entry.value = value;
    entry.valueAnchor = anchors.capture(value, canonical, sourceHash);
    if (orphaned && entry.kind === 'ai') { entry.kind = 'manual'; delete entry.targetId; delete entry.edited; }
    if (entry.kind === 'manual') entry.anchor = entry.valueAnchor;
    else entry.edited = true;
    delete entry.legacy;
  }
  if (orphaned && action === 'restore') entry.status = restoredOrphanStatus(entry);
  else if (rule.to) entry.status = rule.to;
  entry.draftNumber = draftNumber;
  entry.updatedAt = at; entry.updatedBy = String(actor);

  // Everything that changes which corrections the student sees or what they count as asks for a grade check, restore from hidden too: it
  // moves the visible set exactly as the hide did, and a decision taken while hidden was about a different set. Only rewording does not.
  const scoringReviewRequired = action !== 'edit' || changedFields.some(key => !['message', 'suggestedText'].includes(key));
  state.revision += 1;
  state.scoringReviewRequired = Boolean(state.scoringReviewRequired || scoringReviewRequired);
  if (scoringReviewRequired) state.scoringReview = { decision: state.scoringReview?.decision ?? null, requiredDraftNumber: draftNumber };
  const auditRow = { submissionId: String(doc._id), classId: doc.class ? String(doc.class) : null, requestId: body.requestId,
    requestHash: requestHashOf(actor, body), action, actor: String(actor), entryId: entry.id, correctionId: body.id || null,
    previousRevision: body.revision, newRevision: state.revision, before: action === 'add' ? null : before, after: copy(entry),
    changedFields, visibilityChanged: before.status !== entry.status, scoringReviewRequired, draftNumber, createdAt: at };
  state.recent = [...(state.recent || []), auditRow].slice(-RECENT_AUDIT);
  const stored = { version: 2, revision: state.revision, scoringReviewRequired: state.scoringReviewRequired, ...(state.scoringReview ? { scoringReview: state.scoringReview } : {}),
    entries: state.entries, recent: state.recent };
  if (Buffer.byteLength(JSON.stringify(stored), 'utf8') > MAX_STATE_BYTES) throw fail(409,'ANNOTATION_HISTORY_LIMIT');
  return { state: stored, auditRow, revision: state.revision, legacyAudit: state.legacyAudit || [] };
}

// Bulk hide / restore (Phase A). Every change goes through prepare() above, one item at a time, so the lifecycle, orphan rules, anchors
// and the one-audit-row-per-change are the single-action ones. Bulk acts only on items whose status is the action's source state and that
// are not orphaned; anything else is left alone (so a repeat changes nothing). Bulk restore brings back hidden items only: removed
// (archived) ones are restored one at a time from the list.
const BULK_MAX = 500;
const BULK_FROM = Object.freeze({ hide: 'visible', restore: 'hidden' });
const BULK_KEYS = ['action', 'ids', 'category', 'all', 'revision', 'sourceHash', 'requestId'];
const bulkRowId = (requestId, index) => `${requestId}:${String(index).padStart(3, '0')}`;

/** Shape checks for a bulk request. `categories`: the legend's group keys. */
function checkBulkBody(body, categories) {
  if (JSON.stringify(body || {}).length > 64000) throw fail(413,'ANNOTATION_PAYLOAD_TOO_LARGE');
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !BULK_KEYS.includes(k))) throw fail(400,'ANNOTATION_INVALID_FIELDS');
  if (!BULK_FROM[body.action] || !/^[a-f0-9-]{36}$/i.test(body.requestId || '') || !Number.isInteger(body.revision) || typeof body.sourceHash !== 'string') throw fail(400,'ANNOTATION_INVALID_REQUEST');
  const scopes = ['ids', 'category', 'all'].filter(k => body[k] !== undefined);
  if (scopes.length !== 1) throw fail(400,'ANNOTATION_INVALID_REQUEST');
  if (body.ids !== undefined) {
    if (!Array.isArray(body.ids) || !body.ids.length || body.ids.some(id => typeof id !== 'string' || !id || id.length > 120)) throw fail(400,'ANNOTATION_INVALID_REQUEST');
    if (body.ids.length > BULK_MAX) throw fail(400,'ANNOTATION_BULK_TOO_MANY');
    if (new Set(body.ids).size !== body.ids.length) throw fail(400,'ANNOTATION_INVALID_REQUEST');
  }
  if (body.category !== undefined && (typeof body.category !== 'string' || !categories.includes(body.category))) throw fail(400,'ANNOTATION_INVALID_CATEGORY');
  if (body.all !== undefined && (body.all !== true || body.action !== 'restore')) throw fail(400,'ANNOTATION_INVALID_REQUEST');
}

/** An earlier bulk request with the same id (its rows, from the collection or the overlay): its result, or a conflict if the body differs. */
function bulkReplayOf(rows, actor, body) {
  if (!rows.length) return null;
  if (rows.some(row => row.requestHash !== requestHashOf(actor, body))) throw fail(409,'ANNOTATION_IDEMPOTENCY_CONFLICT');
  return { replay: true, revision: Math.max(...rows.map(r => r.newRevision)), changedIds: [...new Set(rows.map(r => r.correctionId))] };
}

/**
 * Applies a bulk hide or restore. `resolve(doc, state)` returns the current resolution and teacher rows for a state
 * (studentCorrectionView), so each item is judged on what the items before it did (one entry can govern several corrections).
 * Returns { state, auditRows, revision, changedIds, legacyAudit }, or throws before anything is written.
 */
function prepareBulk(doc, actor, body, { resolve, now = new Date() } = {}) {
  const from = BULK_FROM[body.action];
  let state = normalizeState(doc.teacherAnnotations);
  if (body.revision !== state.revision || body.sourceHash !== source(doc).sourceHash) throw fail(409,'ANNOTATION_REVISION_CONFLICT');
  const legacyAudit = state.legacyAudit || [];
  const first = resolve(doc, doc.teacherAnnotations ?? null);
  const rows = new Map(first.rows.map(row => [String(row.id), row]));
  const orphanEntryIds = new Set([...first.orphans, ...first.archivedOrphans].map(o => String(o.entryId)));
  let targets;
  if (body.ids) {
    // Every id must be a correction of this submission: an id from another submission (or a stale list) rejects the whole request.
    if (body.ids.some(id => !rows.has(id) && !orphanEntryIds.has(id))) throw fail(400,'ANNOTATION_UNKNOWN_IDS');
    targets = body.ids;
  } else {
    targets = first.rows.filter(row => row.moderationStatus === from && (body.all || String(row.category || '').toUpperCase() === body.category)).map(row => String(row.id));
    if (targets.length > BULK_MAX) throw fail(400,'ANNOTATION_BULK_TOO_MANY');
  }
  const hash = requestHashOf(actor, body);
  const auditRows = [], changedIds = [];
  let current = doc;
  for (const id of targets) {
    if (orphanEntryIds.has(id)) continue;   // orphans are never shown to students and have their own one-at-a-time rules
    const { resolution, rows: liveRows } = resolve(current, current.teacherAnnotations ?? null);
    const live = liveRows.find(row => String(row.id) === id);
    if (!live || live.moderationStatus !== from || resolution.orphanIds.has(live.entryId)) continue;
    const child = { action: body.action, id, revision: state.revision, sourceHash: body.sourceHash, requestId: crypto.randomUUID() };
    const result = prepare(current, actor, child, { resolution, now });
    Object.assign(result.auditRow, { requestId: bulkRowId(body.requestId, auditRows.length), requestHash: hash });
    auditRows.push(result.auditRow); changedIds.push(id);
    state = normalizeState(result.state);
    current = { ...current, teacherAnnotations: result.state };
  }
  return { state: current.teacherAnnotations, auditRows, revision: state.revision, changedIds, legacyAudit };
}

module.exports = { TRANSITIONS, ORPHAN_TRANSITIONS, RECENT_AUDIT, MAX_ENTRIES, BULK_MAX, normalizeState, source, validateValue, prepare, checkBody, replayOf, requestHashOf,
  checkBulkBody, bulkReplayOf, prepareBulk, bulkRowId };
