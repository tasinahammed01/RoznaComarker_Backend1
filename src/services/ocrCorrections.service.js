const writingCorrectionsService = require('./writingCorrections.service');
const logger = require('../utils/logger');
const {
  normalizeOcrTranscript,
  buildNormalizedTranscriptFromWords
} = require('../utils/ocrTranscriptNormalizer');

function overlap(aStart, aEnd, bStart, bEnd) {
  const s = Math.max(aStart, bStart);
  const e = Math.min(aEnd, bEnd);
  return e > s;
}

function normalizeOcrWordsFromStored(ocrDataWords) {
  const list = Array.isArray(ocrDataWords) ? ocrDataWords : [];

  const perPageCounters = new Map();

  return list
    .map((w) => {
      const text = typeof w?.text === 'string' ? w.text.trim() : '';
      if (!text) return null;

      const pageNum = typeof w?.page === 'number' ? w.page : Number(w?.page);
      const page = Number.isFinite(pageNum) ? pageNum : 1;

      const bbox = w?.bbox && typeof w.bbox === 'object' ? w.bbox : null;
      const x0 = bbox ? Number(bbox.x0) : NaN;
      const y0 = bbox ? Number(bbox.y0) : NaN;
      const x1 = bbox ? Number(bbox.x1) : NaN;
      const y1 = bbox ? Number(bbox.y1) : NaN;

      if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) return null;

      const next = (perPageCounters.get(page) || 0) + 1;
      perPageCounters.set(page, next);

      const id = `word_${page}_${next}`;

      return {
        id,
        page,
        paragraphIndex: Number.isFinite(Number(w?.paragraphIndex)) ? Number(w.paragraphIndex) : undefined,
        text,
        bbox: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
      };
    })
    .filter(Boolean);
}

function buildTranscriptAndSpans(ocrWords) {
  const list = Array.isArray(ocrWords) ? ocrWords : [];
  const built = buildNormalizedTranscriptFromWords(list, (previous, current) => {
    if (previous?.paragraphIndex != null && current?.paragraphIndex != null
      && Number(previous.paragraphIndex) !== Number(current.paragraphIndex)) return '\n\n';
    const pb = previous?.bbox;
    const cb = current?.bbox;
    return Boolean(pb && cb && cb.y > (pb.y + pb.h + pb.h * 0.6));
  });
  return {
    text: built.text,
    spans: built.spans.map(({ word, start, end, separatorBefore }) => ({
      wordId: word.id,
      page: word.page,
      start,
      end,
      bbox: word.bbox,
      separatorBefore
    }))
  };
}

function groupWordsIntoPages(ocrWords, spans) {
  const pages = new Map();
  const separators = new Map((Array.isArray(spans) ? spans : []).map((span) => [span.wordId, span.separatorBefore || '']));
  for (const w of Array.isArray(ocrWords) ? ocrWords : []) {
    if (!w) continue;
    if (!pages.has(w.page)) pages.set(w.page, []);
    pages.get(w.page).push({
      id: w.id,
      text: w.text,
      bbox: w.bbox,
      separatorBefore: separators.get(w.id) || ''
    });
  }

  return Array.from(pages.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([pageNumber, words]) => ({
      pageNumber,
      width: null,
      height: null,
      words,
      lines: []
    }));
}

async function buildOcrCorrections({ text, language, ocrWords }) {
  const safeText = normalizeOcrTranscript(text);

  const { text: transcriptText, spans } = buildTranscriptAndSpans(ocrWords);
  const baseText = safeText || transcriptText;
  // Bounding boxes are safe only when their generated transcript is exactly
  // the text being analyzed. Manual transcript edits still get text feedback,
  // but are not attached to an unrelated OCR word box.
  const alignedSpans = baseText === transcriptText ? spans : [];

  let issues = [];
  try {
    const writing = await writingCorrectionsService.check({ text: baseText, language });
    issues = Array.isArray(writing && writing.issues) ? writing.issues : [];
  } catch (err) {
    logger.error({
      message: 'Writing corrections failed (LanguageTool)',
      error: err && err.message ? err.message : err
    });
    issues = [];
  }

  const corrections = issues.map((issue, idx) => {
    const start = typeof issue.start === 'number' ? issue.start : Number(issue.start);
    const end = typeof issue.end === 'number' ? issue.end : Number(issue.end);

    const overlapping = alignedSpans.filter((s) => Number.isFinite(start) && Number.isFinite(end) && overlap(start, end, s.start, s.end));

    const wordIds = overlapping.map((s) => s.wordId);
    const bboxList = overlapping
      .map((s) => s.bbox)
      .filter((b) => b && [b.x, b.y, b.w, b.h].every((n) => typeof n === 'number' && Number.isFinite(n)));

    const page = overlapping.length ? overlapping[0].page : 1;

    return {
      id: `lt_${idx + 1}`,
      page,
      wordIds,
      bboxList,
      groupKey: issue.groupKey,
      groupLabel: issue.groupLabel,
      category: issue.groupLabel || issue.groupKey || 'Quick Check',
      symbol: issue.symbol || 'CK',
      color: issue.color || '#FF0000',
      message: issue.message || issue.description || 'Check this',
      suggestedText: issue.suggestion || '',
      startChar: Number.isFinite(start) ? start : undefined,
      endChar: Number.isFinite(end) ? end : undefined,
      editable: false
    };
  });

  const ocrPages = groupWordsIntoPages(ocrWords, spans);

  return {
    ocr: ocrPages,
    corrections,
    fullText: baseText
  };
}

module.exports = {
  normalizeOcrWordsFromStored,
  buildOcrCorrections
};
