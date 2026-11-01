'use strict';
const crypto = require('crypto');
const { ocrEvidenceHash } = require('./correctionEvidenceIdentity.service');
const { legendIndex } = require('./correctionCanonical.service');
const { buildCanonicalSubmissionTranscript } = require('../utils/ocrTranscriptNormalizer');
const fail = (statusCode, code) => Object.assign(new Error(code), { statusCode, code });
const copy = value => value == null ? null : JSON.parse(JSON.stringify(value));
const stateOf = doc => doc.teacherAnnotations || { revision: 0, entries: [], audit: [] };
function source(doc) {
  if (!require('../utils/sourceFidelity').eligible(doc)) throw fail(409, 'ANNOTATION_SOURCE_UNAVAILABLE');
  const canonical = buildCanonicalSubmissionTranscript(doc);
  if (!canonical.isComplete || !canonical.text) throw fail(409, 'ANNOTATION_SOURCE_UNAVAILABLE');
  return { canonical, sourceHash: ocrEvidenceHash(canonical, doc) };
}
function effective(corrections, canonical, doc, includeHidden = false) {
  const hash = ocrEvidenceHash(canonical, doc);
  const entries = (stateOf(doc).entries || []).filter(e => e.sourceHash === hash);
  const byId = new Map((corrections || []).map(c => [String(c.id || c._id), copy(c)]));
  for (const e of entries) {
    // Retain the reviewed snapshot across regenerated AI persistence.
    if (includeHidden || e.status === 'visible') byId.set(e.id, { ...copy(e.value), moderationStatus: e.status });
    else byId.delete(e.id);
  }
  return [...byId.values()].map(c => ({ ...c, moderationStatus: c.moderationStatus || 'visible' }));
}
function boundary(text, at) {
  return !(at > 0 && at < text.length && /[\uD800-\uDBFF]/.test(text[at-1]) && /[\uDC00-\uDFFF]/.test(text[at]))
    && !(text[at-1] === '\r' && text[at] === '\n');
}
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
function prepare(doc, actor, body) {
  if (JSON.stringify(body || {}).length > 16000) throw fail(413,'ANNOTATION_PAYLOAD_TOO_LARGE');
  if (!body || typeof body !== 'object' || Object.keys(body).some(k => !['action','id','revision','sourceHash','requestId','value'].includes(k))) throw fail(400,'ANNOTATION_INVALID_FIELDS');
  if (!['add','edit','hide','restore','reject'].includes(body.action) || !/^[a-f0-9-]{36}$/i.test(body.requestId || '') || !Number.isInteger(body.revision)) throw fail(400,'ANNOTATION_INVALID_REQUEST');
  const state = copy(stateOf(doc));
  const requestHash = crypto.createHash('sha256').update(JSON.stringify({ actor:String(actor), ...body })).digest('hex');
  const prior = state.audit.find(a => a.requestId === body.requestId);
  if (prior) {
    if (prior.requestHash !== requestHash) throw fail(409,'ANNOTATION_IDEMPOTENCY_CONFLICT');
    return { replay:true, revision:prior.newRevision };
  }
  const { canonical, sourceHash } = source(doc);
  if (body.revision !== state.revision || body.sourceHash !== sourceHash) throw fail(409,'ANNOTATION_REVISION_CONFLICT');
  if (state.audit.length >= 250) throw fail(409,'ANNOTATION_HISTORY_LIMIT');
  const rows = effective(doc.writingCorrections,canonical,doc,true);
  const id = body.action === 'add' ? `teacher_${crypto.randomUUID()}` : body.id;
  const current = rows.find(c => String(c.id || c._id) === id);
  if (body.action !== 'add' && !current) throw fail(404,'ANNOTATION_NOT_FOUND');
  let entry = state.entries.find(e => e.id === id && e.sourceHash === sourceHash);
  const before = entry ? copy(entry) : current ? { id, sourceHash, status:'visible', value:copy(current) } : null;
  if (!entry) {
    if (state.entries.length >= 200) throw fail(409,'ANNOTATION_HISTORY_LIMIT');
    entry = { id, sourceHash, status:'visible', value:copy(current), original:copy(current) }; state.entries.push(entry);
  }
  if (body.action === 'add' || body.action === 'edit') entry.value = {
    ...validateValue(body.value,canonical,sourceHash,id,body.action === 'add' ? 'Teacher' : current.source),
    createdAt:new Date().toISOString(), ...(doc.ocrJobId ? {ocrRunId:String(doc.ocrJobId)} : {})
  };
  else if (body.value !== undefined) throw fail(400,'ANNOTATION_INVALID_FIELDS');
  if (body.action === 'hide' || body.action === 'reject') {
    if (entry.status !== 'visible') throw fail(409,'ANNOTATION_STATE_CONFLICT');
    entry.status = body.action === 'hide' ? 'hidden' : 'rejected';
  } else if (body.action === 'restore') {
    if (entry.status === 'visible') throw fail(409,'ANNOTATION_STATE_CONFLICT');
    entry.status = 'visible';
  }
  const changedFields = body.action === 'edit' ? Object.keys(body.value).filter(key => body.value[key] !== before.value[key]) : [];
  const scoringReviewRequired = ['add','reject'].includes(body.action)
    || (body.action === 'edit' && changedFields.some(key => !['message','suggestedText'].includes(key)))
    || (body.action === 'restore' && before?.status === 'rejected');
  state.revision += 1;
  state.scoringReviewRequired = Boolean(state.scoringReviewRequired || scoringReviewRequired);
  state.audit.push({ requestId:body.requestId, requestHash, action:body.action, actor:String(actor), submissionId:String(doc._id),
    correctionId:id, timestamp:new Date().toISOString(), previousRevision:body.revision, newRevision:state.revision,
    before, after:copy(entry), changedFields, visibilityChanged:before?.status !== entry.status, scoringReviewRequired });
  if (Buffer.byteLength(JSON.stringify(state),'utf8') > 2 * 1024 * 1024) throw fail(409,'ANNOTATION_HISTORY_LIMIT');
  return { state, revision:state.revision, sourceHash };
}
module.exports = { stateOf, source, effective, prepare, validateValue };
