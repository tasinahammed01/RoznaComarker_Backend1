'use strict';
// Text-span anchors for teacher annotation entries (Task 6A). An anchor records WHERE in the canonical transcript a teacher decision
// applies, independent of AI correction ids, so the decision survives an AI regenerate (new ids) and an OCR re-run (new offsets).
//
// Algorithm (pure, deterministic):
//   capture: { fileId, page, startChar, endChar, quotedText, before, after, sourceHash } where before/after are up to CONTEXT_CHARS
//            characters of the same page immediately around the span.
//   locate:  1. same evidence hash and the slice still equals the quote -> the stored span (fast path);
//            2. otherwise search the same file/page of the new transcript for every occurrence of the exact quote whose start and end
//               fall on canonical word boundaries;
//            3. none -> orphan TEXT_NOT_FOUND (or PAGE_NOT_FOUND); exactly one -> that span;
//            4. several -> score each by shared context (common suffix of `before` + common prefix of `after`); the best wins only if it
//               beats the runner-up and has at least MIN_CONTEXT shared characters, otherwise orphan AMBIGUOUS with every candidate.
//   match:   a located span matches an AI correction on the same file/page when they overlap with IoU >= IOU_THRESHOLD or one contains
//            the other.
const CONTEXT_CHARS = 32;
const MIN_CONTEXT = 4;
const IOU_THRESHOLD = 0.5;

const pageOf = (canonical, fileId, page) => (canonical?.pages || [])
  .find(p => String(p.fileId) === String(fileId) && Number(p.pageNumber || 1) === Number(page || 1));

/** The anchor of a span of the canonical transcript (the span must already be validated). */
function capture({ fileId, page, startChar, endChar }, canonical, sourceHash) {
  const p = pageOf(canonical, fileId, page);
  const from = p ? p.startChar : 0, to = p ? p.endChar : canonical.text.length;
  return { fileId: String(fileId), page: Number(page || 1), startChar, endChar, quotedText: canonical.text.slice(startChar, endChar),
    before: canonical.text.slice(Math.max(from, startChar - CONTEXT_CHARS), startChar),
    after: canonical.text.slice(endChar, Math.min(to, endChar + CONTEXT_CHARS)), sourceHash };
}

// Word start/end offsets per page, computed once per transcript object (a resolution locates hundreds of anchors in one transcript).
const boundaryCache = new WeakMap();
function boundaries(canonical, fileId, page) {
  let byPage = boundaryCache.get(canonical);
  if (!byPage) { byPage = new Map(); boundaryCache.set(canonical, byPage); }
  const key = `${fileId}:${Number(page)}`;
  if (!byPage.has(key)) {
    const words = (canonical.wordSpans || []).filter(w => String(w.fileId) === String(fileId) && Number(w.page) === Number(page));
    byPage.set(key, { starts: new Set(words.map(w => w.start)), ends: new Set(words.map(w => w.end)) });
  }
  return byPage.get(key);
}

function commonSuffix(a, b) { let n = 0; while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++; return n; }
function commonPrefix(a, b) { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n; }

/**
 * Where an anchor lies in a (possibly different) canonical transcript.
 * Returns { span } or { orphan: 'PAGE_NOT_FOUND' | 'TEXT_NOT_FOUND' | 'AMBIGUOUS', candidates: [span] }.
 */
function locate(anchor, canonical, currentHash) {
  if (!anchor || typeof anchor.quotedText !== 'string' || !anchor.quotedText) return { orphan: 'TEXT_NOT_FOUND', candidates: [] };
  const span = { fileId: anchor.fileId, page: anchor.page, startChar: anchor.startChar, endChar: anchor.endChar };
  if (anchor.sourceHash && anchor.sourceHash === currentHash && canonical.text.slice(anchor.startChar, anchor.endChar) === anchor.quotedText) return { span };
  const p = pageOf(canonical, anchor.fileId, anchor.page);
  if (!p) return { orphan: 'PAGE_NOT_FOUND', candidates: [] };
  const { starts, ends } = boundaries(canonical, anchor.fileId, anchor.page);
  const candidates = [];
  for (let at = canonical.text.indexOf(anchor.quotedText, p.startChar); at >= 0 && at + anchor.quotedText.length <= p.endChar;
    at = canonical.text.indexOf(anchor.quotedText, at + 1)) {
    const end = at + anchor.quotedText.length;
    if (starts.has(at) && ends.has(end)) candidates.push({ fileId: anchor.fileId, page: anchor.page, startChar: at, endChar: end });
  }
  if (!candidates.length) return { orphan: 'TEXT_NOT_FOUND', candidates };
  if (candidates.length === 1) return { span: candidates[0] };
  const scored = candidates.map(c => ({ c, score:
    commonSuffix(anchor.before || '', canonical.text.slice(Math.max(p.startChar, c.startChar - CONTEXT_CHARS), c.startChar))
    + commonPrefix(anchor.after || '', canonical.text.slice(c.endChar, Math.min(p.endChar, c.endChar + CONTEXT_CHARS))) }))
    .sort((a, b) => b.score - a.score || a.c.startChar - b.c.startChar);
  if (scored[0].score >= MIN_CONTEXT && scored[0].score > scored[1].score) return { span: scored[0].c };
  return { orphan: 'AMBIGUOUS', candidates };
}

/** Overlap of two spans: { overlap, iou, contains }. Spans on different files/pages never overlap. */
function overlap(a, b) {
  if (String(a.fileId) !== String(b.fileId) || Number(a.page || 1) !== Number(b.page || 1)) return { overlap: 0, iou: 0, contains: false };
  const inter = Math.max(0, Math.min(a.endChar, b.endChar) - Math.max(a.startChar, b.startChar));
  const lenA = a.endChar - a.startChar, lenB = b.endChar - b.startChar;
  return { overlap: inter, iou: inter ? inter / (lenA + lenB - inter) : 0, contains: inter > 0 && (inter === lenA || inter === lenB) };
}

const matches = (span, correction) => { const o = overlap(span, correction); return o.overlap > 0 && (o.iou >= IOU_THRESHOLD || o.contains); };

/** Canonical word ids covered by a span (the only geometry a teacher-placed span may use). */
const wordIdsFor = (canonical, span) => (canonical.wordSpans || []).filter(w => String(w.fileId) === String(span.fileId)
  && Number(w.page) === Number(span.page) && span.startChar < w.end && span.endChar > w.start).map(w => w.wordId);

module.exports = { CONTEXT_CHARS, MIN_CONTEXT, IOU_THRESHOLD, capture, locate, overlap, matches, wordIdsFor };
