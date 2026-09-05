'use strict';

const { canonicalOcrWordId } = require('../utils/ocrWordIdentity');

function normalizedId(value) {
  return String(value?._id || value?.id || value || '').trim();
}

function scopeCanonicalPages(pages, requestedFileId) {
  const list = Array.isArray(pages) ? pages : [];
  const requested = normalizedId(requestedFileId);
  if (!requested) return list;
  return list.filter((page) => normalizedId(page?.fileId) === requested);
}

function scopeCanonicalCorrections(corrections, requestedFileId) {
  const list = Array.isArray(corrections) ? corrections : [];
  const requested = normalizedId(requestedFileId);
  if (!requested) return list;
  return list.filter((correction) => normalizedId(correction?.fileId) === requested);
}

function normalizeCorrectionWordIds(corrections, canonicalTranscript, storedPages) {
  const pages = Array.isArray(canonicalTranscript?.pages) ? canonicalTranscript.pages : [];
  const spans = Array.isArray(canonicalTranscript?.wordSpans) ? canonicalTranscript.wordSpans : [];
  const aliases = new Map();
  for (const page of Array.isArray(storedPages) ? storedPages : []) {
    const fileId = normalizedId(page?.fileId); const pageNumber = Number(page?.pageNumber || 1);
    (Array.isArray(page?.words) ? page.words : []).forEach((word, wordIndex) => {
      const canonical = canonicalOcrWordId({ fileId, pageNumber, storedWordId: word?.id, wordIndex });
      aliases.set(`${fileId}:${pageNumber}:${String(word?.id ?? wordIndex + 1)}`, canonical);
      aliases.set(`${fileId}:${pageNumber}:${canonical}`, canonical);
    });
  }
  return (Array.isArray(corrections) ? corrections : []).map((correction) => {
    const fileId = normalizedId(correction?.fileId); const pageNumber = Number(correction?.pageNumber ?? correction?.page ?? 1);
    const page = pages.find((item) => normalizedId(item?.fileId) === fileId && Number(item?.pageNumber || 1) === pageNumber);
    if (!page) return { ...correction, wordIds: [] };
    const validIds = new Set((page.words || []).map((word) => String(word.id)));
    let wordIds = (Array.isArray(correction?.wordIds) ? correction.wordIds : []).map((value) => {
      const raw = String(value || '').trim();
      return validIds.has(raw) ? raw : aliases.get(`${fileId}:${pageNumber}:${raw}`);
    }).filter((value) => value && validIds.has(value));
    if (!wordIds.length) {
      const start = Number(correction?.startChar); const end = Number(correction?.endChar);
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) wordIds = spans.filter((span) =>
        normalizedId(span?.fileId) === fileId && Number(span?.page || 1) === pageNumber
        && start < Number(span.end) && end > Number(span.start)).map((span) => String(span.wordId));
    }
    if (!wordIds.length) {
      const quote = String(correction?.quotedText || '').trim(); const pageText = String(page.text || '');
      if (quote) {
        const first = pageText.indexOf(quote); const second = first < 0 ? -1 : pageText.indexOf(quote, first + 1);
        if (first >= 0 && second < 0) {
          const start = Number(page.startChar || 0) + first; const end = start + quote.length;
          wordIds = spans.filter((span) => normalizedId(span?.fileId) === fileId && Number(span?.page || 1) === pageNumber
            && start < Number(span.end) && end > Number(span.start)).map((span) => String(span.wordId));
        }
      }
    }
    return { ...correction, fileId, page: pageNumber, wordIds: [...new Set(wordIds)] };
  });
}

module.exports = { normalizedId, scopeCanonicalPages, scopeCanonicalCorrections, normalizeCorrectionWordIds };
