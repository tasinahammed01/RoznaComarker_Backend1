'use strict';

const { normalizeCorrectionWordIds, normalizedId } = require('./canonicalCorrectionResponse.service');
const { defaultLegend } = require('./writingCorrections.service');
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
function buildCanonicalCorrectionRenderModels(corrections, canonical, storedPages = []) {
  const pages = canonical?.pages || [];
  const pageByKey = new Map(pages.map((p) => [`${normalizedId(p.fileId)}:${Number(p.pageNumber || 1)}`, p]));
  const wordsByPage = new Map(pages.map((p) => [p, new Map((p.words || []).map((w) => [String(w.id), w]))]));
  const spansById = new Map((canonical?.wordSpans || []).map((s) => [String(s.wordId), s]));
  const scoped = (corrections || []).map((c) => !normalizedId(c.fileId) && pages.length === 1
    ? { ...c, fileId: pages[0].fileId } : c);
  return normalizeCorrectionWordIds(scoped, canonical, storedPages).map((correction) => {
    const page = pageByKey.get(`${normalizedId(correction.fileId)}:${Number(correction.page || 1)}`);
    const words = wordsByPage.get(page) || new Map();
    const semantic = semanticCodes.has(correction.symbol) || ['CON', 'ORG'].includes(correction.symbol)
      || (!knownCodes.has(correction.symbol) && ['CONTENT', 'ORGANIZATION'].includes(correction.category));
    const target = correction.visualTarget;
    const explicit = !semantic && target && target.wordIds.every((id) => validBox(words.get(id)?.bbox))
      && target.anchors.every((a) => validBox(words.get(a.wordId)?.bbox));
    const wordIds = [...new Set(explicit ? target.wordIds : correction.wordIds || [])]
      .filter((id) => validBox(words.get(id)?.bbox));
    const anchors = explicit ? target.anchors.map((a) => ({ ...a })) : [];
    const boxes = wordIds.length ? wordIds.map((id) => ({ ...words.get(id).bbox }))
      : explicit ? [] : (correction.bboxList || []).map(legacyBox).filter(Boolean);
    const source = explicit ? 'visualTarget' : wordIds.length ? 'wordIds' : boxes.length ? 'bboxList' : 'none';
    const textRanges = wordIds.flatMap((id) => {
      const span = spansById.get(id);
      return span ? [{ start: span.start, end: span.end }] : [];
    });
    // Historical bbox-only records can retain their persisted text offsets. Never use
    // an evidence range when an explicit target or canonical word mapping is available.
    if (source === 'bboxList' && Number.isInteger(correction.startChar) && Number.isInteger(correction.endChar)
      && correction.endChar > correction.startChar) textRanges.push({ start: correction.startChar, end: correction.endChar });
    const textAnchors = anchors.flatMap((a) => {
      const span = spansById.get(a.wordId);
      return span ? [{ ...a, at: a.side === 'before' ? span.start : span.end }] : [];
    });
    return { ...correction, renderTarget: { version: 1, source, wordIds, anchors, boxes, textRanges, textAnchors } };
  });
}

module.exports = { buildCanonicalCorrectionRenderModels };
