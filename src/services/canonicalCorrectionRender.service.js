'use strict';

const { normalizeCorrectionWordIds, normalizedId } = require('./canonicalCorrectionResponse.service');
const { defaultLegend } = require('./writingCorrections.service');
const { CANONICAL_TRANSCRIPT_LAYOUT_VERSION } = require('../utils/ocrTranscriptNormalizer');
const logger = require('../utils/logger');
const legend = defaultLegend();
const knownCodes = new Set(legend.groups.flatMap((g) => g.symbols.map((s) => s.symbol)));
const semanticCodes = new Set(legend.groups.filter((g) => ['CONTENT', 'ORGANIZATION'].includes(g.key))
  .flatMap((g) => g.symbols.map((s) => s.symbol)));

function validBox(box) {
  return box && [box.x, box.y, box.w, box.h].every(Number.isFinite)
    && box.x >= 0 && box.y >= 0 && box.w > 0 && box.h > 0
    && box.x + box.w <= 100.5 && box.y + box.h <= 100.5;
}
function legacyBox(box) {
  if (validBox(box)) return { x: box.x, y: box.y, w: box.w, h: box.h };
  const converted = box && { x: box.x0, y: box.y0, w: box.x1 - box.x0, h: box.y1 - box.y0 };
  return validBox(converted) ? converted : null;
}

/** Response-only target authority. Evidence and persisted correction records are never changed. */
const normalizedText = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
function textMatches(expected, actual, allowSubset = false) {
  const a = normalizedText(expected), b = normalizedText(actual);
  if (!a || !b) return false;
  if (a === b || (allowSubset && b.length >= 2 && a.includes(b))) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const old = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)); diagonal = old;
    }
  }
  return row[b.length] <= 1;
}
function buildCanonicalCorrectionRenderModels(corrections, canonical, storedPages = [], options = {}) {
  const pages = canonical?.pages || [];
  const pageByKey = new Map(pages.map((p) => [`${normalizedId(p.fileId)}:${Number(p.pageNumber || 1)}`, p]));
  const wordsByPage = new Map(pages.map((p) => [p, new Map((p.words || []).map((w) =>
    [String(w.id), { ...w, bbox: legacyBox(w.bbox) }]))]));
  const spansById = new Map((canonical?.wordSpans || []).map((s) => [String(s.wordId), s]));
  const scoped = (corrections || []).map((c) => !normalizedId(c.fileId) && pages.length === 1
    ? { ...c, fileId: pages[0].fileId } : c);
  return normalizeCorrectionWordIds(scoped, canonical, storedPages, options).map((correction) => {
    if (correction.targetVerification?.state === 'rejected') {
      logger.warn({ event: 'correction_target_mismatch', submissionId: String(options.submission?._id || ''),
        symbol: correction.symbol, reason: correction.targetVerification.reason });
      return { ...correction, renderTarget: { version: 1, source: 'none', wordIds: [], anchors: [], boxes: [], textRanges: [], textAnchors: [] } };
    }
    const page = pageByKey.get(`${normalizedId(correction.fileId)}:${Number(correction.page || 1)}`);
    const words = wordsByPage.get(page) || new Map();
    const semantic = semanticCodes.has(correction.symbol) || ['CON', 'ORG'].includes(correction.symbol)
      || (!knownCodes.has(correction.symbol) && ['CONTENT', 'ORGANIZATION'].includes(correction.category));
    const target = correction.visualTarget;
    let explicit = !semantic && target && target.wordIds.every((id) => validBox(words.get(id)?.bbox))
      && target.anchors.every((a) => validBox(words.get(a.wordId)?.bbox));
    let wordIds = [...new Set(explicit ? target.wordIds : correction.wordIds || [])]
      .filter((id) => validBox(words.get(id)?.bbox));
    // Explanations are prose, never target evidence. Quoting a suggestion first
    // must not change the geometry of a verified canonical correction.
    const spelling = correction.symbol === 'SP';
    const expected = correction.originalText || correction.quotedText || '';
    const allowSubset = !correction.originalText && !spelling;
    const matchesExpected = actual => spelling ? normalizedText(expected) !== '' && normalizedText(expected) === normalizedText(actual)
      : textMatches(expected, actual, allowSubset);
    let mismatch = wordIds.length > 0 && ((spelling && wordIds.length !== 1)
      || !matchesExpected(wordIds.map(id => words.get(id).text).join(' ')));
    if (mismatch) {
      // Only exact offsets in the current canonical text can repair IDs. Proximity
      // and fuzzy matches never establish machine marker authority.
      const start = correction.startChar, end = correction.endChar;
      const quote = correction.quotedText || correction.originalText;
      const currentSpans = (canonical.wordSpans || []).filter(s => normalizedId(s.fileId) === normalizedId(correction.fileId)
        && Number(s.page || 1) === Number(correction.page || 1) && start < s.end && end > s.start);
      const matches = currentSpans.map(s => words.get(s.wordId)).filter(w => validBox(w?.bbox));
      if (Number.isInteger(start) && Number.isInteger(end) && canonical.text?.slice(start, end) === quote
          && matches.length && (!spelling || matches.length === 1) && matchesExpected(matches.map(w => w.text).join(' '))) {
        wordIds = matches.map(w => w.id); explicit = false; mismatch = false;
      } else {
        wordIds = []; explicit = false;
      }
    }
    const anchors = explicit && !mismatch ? target.anchors.map((a) => ({ ...a })) : [];
    const submission = options.submission || {};
    const ocrTime = new Date(submission.ocrUpdatedAt || 0).getTime();
    const correctionTime = new Date(correction.createdAt || submission.correctionUpdatedAt || 0).getTime();
    const legacyFresh = !mismatch && submission.correctionTranscriptLayoutVersion === CANONICAL_TRANSCRIPT_LAYOUT_VERSION
      && ocrTime > 0 && correctionTime >= ocrTime;
    const legacyCandidates = (correction.bboxList || []).map(legacyBox).filter(Boolean);
    const legacyVerified = legacyCandidates.length > 0 && legacyCandidates.every(box => {
      const inside = [...words.values()].filter(word => validBox(word.bbox)
        && word.bbox.x + word.bbox.w / 2 >= box.x && word.bbox.x + word.bbox.w / 2 <= box.x + box.w
        && word.bbox.y + word.bbox.h / 2 >= box.y && word.bbox.y + word.bbox.h / 2 <= box.y + box.h);
      return (!spelling || inside.length === 1) && matchesExpected(inside.map(word => word.text).join(' '));
    });
    const boxes = wordIds.length ? wordIds.map((id) => ({ ...words.get(id).bbox }))
      : explicit || !legacyFresh || !legacyVerified ? [] : legacyCandidates;
    const source = explicit ? 'visualTarget' : wordIds.length ? 'wordIds' : boxes.length ? 'bboxList' : 'none';
    if (source === 'none') logger.warn({ event: 'correction_target_mismatch',
      submissionId: String(options.submission?._id || ''), symbol: correction.symbol,
      reason: mismatch ? 'text_mismatch' : !legacyFresh && legacyCandidates.length ? 'stale_legacy_geometry' : 'unresolved_target' });
    const textRanges = wordIds.flatMap((id) => {
      const span = spansById.get(id);
      return span ? [{ start: span.start, end: span.end }] : [];
    });
    // Transcript evidence can remain valid when image geometry is unavailable.
    // Verify the actual page text before retaining offsets; this grants no box authority.
    const pageStart = Number(page?.startChar || 0);
    const localStart = correction.startChar - pageStart, localEnd = correction.endChar - pageStart;
    if (!explicit && !wordIds.length && !mismatch && Number.isInteger(correction.startChar) && Number.isInteger(correction.endChar)
      && localStart >= 0 && localEnd > localStart && localEnd <= String(page?.text || '').length
      && matchesExpected(page.text.slice(localStart, localEnd))) {
      textRanges.push({ start: correction.startChar, end: correction.endChar });
    }
    const textAnchors = anchors.flatMap((a) => {
      const span = spansById.get(a.wordId);
      return span ? [{ ...a, at: a.side === 'before' ? span.start : span.end }] : [];
    });
    const stored = storedPages.find(p => normalizedId(p.fileId) === normalizedId(correction.fileId) && Number(p.pageNumber || 1) === Number(correction.page || 1));
    return { ...correction, renderTarget: { version: 1, source, wordIds, anchors, boxes, textRanges, textAnchors,
      ...(stored?.coordinateSpace ? { coordinateSpace: stored.coordinateSpace } : {}) } };
  });
}

module.exports = { buildCanonicalCorrectionRenderModels };
