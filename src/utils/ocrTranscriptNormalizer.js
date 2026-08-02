'use strict';

// Increment whenever canonical reading-order or separator rules change. This is
// intentionally independent from the correction prompt/schema version.
const CANONICAL_TRANSCRIPT_LAYOUT_VERSION = 'ocr-layout-v5-native-text';

const CLOSING_PUNCTUATION = /^[,.!?:;%\)\]\}’”]/u;
const OPENING_PUNCTUATION = /[\(\[\{“]$/u;
const JOINING_PUNCTUATION = /^['’]/u;
const PREVIOUS_JOINING_PUNCTUATION = /['’\/-]$/u;

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function normalizeOcrTranscript(text) {
  if (typeof text !== 'string' || !text) return '';
  return text
    .replace(/\r\n?/gu, '\n')
    .replace(/[^\S\n]+/gu, ' ')
    .split('\n')
    .map((line) => line.trim()
      .replace(/ +([,.!?:;%\)\]\}’”])/gu, '$1')
      .replace(/([\(\[\{“]) +/gu, '$1'))
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function getOcrWordSeparator(previousText, currentText, preferredSeparator = ' ') {
  if (!previousText) return '';
  const previous = String(previousText || '');
  const current = String(currentText || '');
  if (CLOSING_PUNCTUATION.test(current) || JOINING_PUNCTUATION.test(current)) return '';
  if (OPENING_PUNCTUATION.test(previous) || PREVIOUS_JOINING_PUNCTUATION.test(previous)) return '';
  if (preferredSeparator === '\n\n') return '\n\n';
  return preferredSeparator === '\n' ? '\n' : ' ';
}

function bboxOf(word) {
  const box = word?.bbox;
  if (!box || typeof box !== 'object') return null;
  const x0 = Number.isFinite(Number(box.x0)) ? Number(box.x0) : Number(box.x);
  const y0 = Number.isFinite(Number(box.y0)) ? Number(box.y0) : Number(box.y);
  const x1 = Number.isFinite(Number(box.x1)) ? Number(box.x1) : x0 + Number(box.w);
  const y1 = Number.isFinite(Number(box.y1)) ? Number(box.y1) : y0 + Number(box.h);
  if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) return null;
  return { x0, y0, x1, y1, width: x1 - x0, height: y1 - y0, centerY: (y0 + y1) / 2 };
}

function sanitizeOcrMarginArtifacts(words) {
  const candidates = (Array.isArray(words) ? words : []).map((word, inputIndex) => ({ word, inputIndex, box: bboxOf(word),
    text: typeof word?.text === 'string' ? word.text.trim() : '' })).filter((item) => item.text);
  const geometric = candidates.filter((item) => item.box);
  if (geometric.length < 4) return candidates.map((item) => item.word);

  const suspicious = (item) => item.text.length <= 2 && /^[#DB0O|Il1]+$/u.test(item.text);
  const body = geometric.filter((item) => !suspicious(item) && item.text.length >= 2 && item.box.x0 < 88);
  if (body.length < 3) return candidates.map((item) => item.word);
  const heights = body.map((item) => item.box.height);
  const medianHeight = median(heights) || 2;
  const sortedRights = body.map((item) => item.box.x1).sort((a, b) => a - b);
  const mainRight = sortedRights[Math.min(sortedRights.length - 1, Math.floor(sortedRights.length * 0.9))];
  const edgeGlyphs = geometric.filter((item) => suspicious(item)
    && (item.box.x0 >= 88 || item.box.x0 > mainRight + Math.max(2.5, medianHeight * 0.8)));

  const clustered = new Set();
  for (const item of edgeGlyphs) {
    const peers = edgeGlyphs.filter((other) => other !== item
      && Math.abs(((other.box.x0 + other.box.x1) / 2) - ((item.box.x0 + item.box.x1) / 2)) <= Math.max(4, medianHeight * 1.5)
      && Math.abs(other.box.centerY - item.box.centerY) >= medianHeight * 0.8);
    if (peers.length) clustered.add(item.inputIndex);
  }

  // Single letters are legitimate in prose, initials, and grades. Remove them
  // only as part of a detached vertical edge cluster. A lone hash-like mark is
  // removed only when it is extremely far outside the established text column.
  return candidates.filter((item) => {
    if (!item.box || !suspicious(item)) return true;
    if (clustered.has(item.inputIndex)) return false;
    return !(item.text === '#' && item.box.x0 >= 94 && item.box.x0 > mainRight + Math.max(4, medianHeight * 1.5));
  }).map((item) => item.word);
}

function clusterVisualLines(words) {
  const candidates = words.map((word, inputIndex) => ({ word, inputIndex, box: bboxOf(word) }));
  const geometryCount = candidates.filter((item) => item.box).length;
  if (!candidates.length || geometryCount !== candidates.length) {
    return candidates.map((item, index) => ({ words: [item], inputIndex: index, geometry: false }));
  }

  const byVerticalPosition = [...candidates].sort((a, b) => a.box.centerY - b.box.centerY
    || a.box.x0 - b.box.x0 || a.inputIndex - b.inputIndex);
  const lines = [];
  for (const candidate of byVerticalPosition) {
    let bestLine = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const line of lines) {
      const representativeHeight = median(line.words.map((item) => item.box.height));
      const representativeCenterY = median(line.words.map((item) => item.box.centerY));
      const memberOverlapRatio = Math.max(...line.words.map((item) => {
        const overlap = Math.max(0, Math.min(item.box.y1, candidate.box.y1) - Math.max(item.box.y0, candidate.box.y0));
        return overlap / Math.min(item.box.height, candidate.box.height);
      }));
      const centerDistance = Math.abs(representativeCenterY - candidate.box.centerY);
      if (memberOverlapRatio >= 0.45 || centerDistance <= Math.max(representativeHeight, candidate.box.height) * 0.45) {
        if (centerDistance < bestDistance) { bestLine = line; bestDistance = centerDistance; }
      }
    }
    if (!bestLine) {
      lines.push({ words: [candidate], y0: candidate.box.y0, y1: candidate.box.y1,
        height: candidate.box.height, centerY: candidate.box.centerY, inputIndex: candidate.inputIndex, geometry: true });
      continue;
    }
    bestLine.words.push(candidate);
    bestLine.y0 = Math.min(bestLine.y0, candidate.box.y0);
    bestLine.y1 = Math.max(bestLine.y1, candidate.box.y1);
    bestLine.height = median(bestLine.words.map((item) => item.box.height));
    bestLine.centerY = median(bestLine.words.map((item) => item.box.centerY));
    bestLine.inputIndex = Math.min(bestLine.inputIndex, candidate.inputIndex);
  }

  return lines
    .sort((a, b) => a.y0 - b.y0 || a.inputIndex - b.inputIndex)
    .map((line) => ({ ...line, words: line.words.sort((a, b) => a.box.x0 - b.box.x0 || a.inputIndex - b.inputIndex) }));
}

function lineParagraphBoundary(previousLine, currentLine, context) {
  if (!previousLine?.geometry || !currentLine?.geometry) return false;
  const previousWords = previousLine.words;
  const currentWords = currentLine.words;
  const previousLast = previousWords[previousWords.length - 1]?.word;
  const currentFirst = currentWords[0]?.word;
  const gap = Math.max(0, currentLine.y0 - previousLine.y1);
  const previousLeft = Math.min(...previousWords.map((item) => item.box.x0));
  const currentLeft = Math.min(...currentWords.map((item) => item.box.x0));
  const paragraphMetadataChanged = previousLast?.paragraphIndex != null && currentFirst?.paragraphIndex != null
    && Number(previousLast.paragraphIndex) !== Number(currentFirst.paragraphIndex);
  const largeVerticalGap = gap > Math.max(context.medianHeight * 0.9, context.medianLineGap * 1.8);
  const indentationChanged = Math.abs(currentLeft - previousLeft) > Math.max(context.medianHeight * 1.25, 1.5);
  const shortLineBlock = (previousWords.length <= 2 || currentWords.length <= 2) && largeVerticalGap;
  const signals = Number(paragraphMetadataChanged) + Number(largeVerticalGap) + Number(indentationChanged) + Number(shortLineBlock);

  // OCR paragraph ids alone are only segmentation hints. Require corroborating
  // geometry, and keep normal-gap orphan fragments attached to the prose.
  return signals >= 2;
}

function orderWordsAndSeparators(words) {
  const sanitized = sanitizeOcrMarginArtifacts(words);
  const typicalHeight = median(sanitized.map((word) => bboxOf(word)?.height).filter(Number.isFinite));
  const cleaned = sanitized
    .map((word, index) => ({ ...word, text: typeof word?.text === 'string' ? word.text.trim() : '', __inputIndex: index }))
    .map((word) => ({ ...word, ocrLayoutSuspicious: word.ocrLayoutSuspicious === true
      || Boolean(typicalHeight && bboxOf(word)?.height > typicalHeight * 1.6) }))
    .filter((word) => word.text);
  const lines = clusterVisualLines(cleaned);
  const medianHeight = median(lines.filter((line) => line.geometry).map((line) => line.height)) || 1;
  const positiveGaps = [];
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index - 1].geometry && lines[index].geometry) {
      const gap = lines[index].y0 - lines[index - 1].y1;
      if (gap >= 0) positiveGaps.push(gap);
    }
  }
  const ordinaryGaps = positiveGaps.filter((gap) => gap <= medianHeight * 1.5);
  const medianLineGap = median(ordinaryGaps.length ? ordinaryGaps : positiveGaps) || medianHeight * 0.35;
  const ordered = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const paragraphBreak = lineIndex > 0 && lineParagraphBoundary(lines[lineIndex - 1], line, { medianHeight, medianLineGap });
    for (let wordIndex = 0; wordIndex < line.words.length; wordIndex += 1) {
      const item = line.words[wordIndex];
      ordered.push({ ...item.word, __lineIndex: lineIndex,
        __preferredSeparator: ordered.length ? (wordIndex === 0 && paragraphBreak ? '\n\n' : ' ') : '' });
    }
  }
  return ordered;
}

function assembleWords(orderedWords) {
  let text = '';
  let previous = null;
  const spans = [];
  for (const word of orderedWords) {
    const separatorBefore = getOcrWordSeparator(previous?.text, word.text, previous ? word.__preferredSeparator : '');
    text += separatorBefore;
    const start = text.length;
    text += word.text;
    const end = text.length;
    const cleanWord = { ...word };
    delete cleanWord.__inputIndex;
    delete cleanWord.__lineIndex;
    delete cleanWord.__preferredSeparator;
    spans.push({ word: cleanWord, wordId: cleanWord.id, start, end, separatorBefore,
      fileId: cleanWord.fileId, page: cleanWord.page, bbox: cleanWord.bbox });
    previous = cleanWord;
  }
  return { text, spans, separators: spans.map((span) => span.separatorBefore), words: spans.map((span) => span.word) };
}

function buildNormalizedTranscriptFromWords(words, isNewLine) {
  const ordered = (Array.isArray(words) ? words : []).map((word, index, list) => {
    const hint = index && typeof isNewLine === 'function' ? isNewLine(list[index - 1], word) : false;
    return { ...word, __preferredSeparator: hint === '\n\n' ? '\n\n' : hint ? '\n' : index ? ' ' : '' };
  }).filter((word) => typeof word.text === 'string' && word.text.trim()).map((word) => ({ ...word, text: word.text.trim() }));
  return assembleWords(ordered);
}

function paragraphsFromSpans(text, spans) {
  if (!text) return [];
  const paragraphs = [];
  let startChar = 0;
  for (let index = text.indexOf('\n\n'); index >= 0; index = text.indexOf('\n\n', index + 2)) {
    const endChar = index;
    paragraphs.push({ startChar, endChar, text: text.slice(startChar, endChar),
      wordIds: spans.filter((span) => span.start >= startChar && span.end <= endChar && span.wordId).map((span) => String(span.wordId)) });
    startChar = index + 2;
  }
  paragraphs.push({ startChar, endChar: text.length, text: text.slice(startChar),
    wordIds: spans.filter((span) => span.start >= startChar && span.end <= text.length && span.wordId).map((span) => String(span.wordId)) });
  return paragraphs.filter((paragraph) => paragraph.text);
}

function buildCanonicalPageFromWords(words) {
  const built = assembleWords(orderWordsAndSeparators(words));
  return { ...built, paragraphs: paragraphsFromSpans(built.text, built.spans), version: CANONICAL_TRANSCRIPT_LAYOUT_VERSION };
}

function alignWordsToAuthoritativeText(authoritativeText, words) {
  const text = normalizeLegacyDisplayText(authoritativeText || '');
  const sourceWords = (Array.isArray(words) ? words : []).filter((word) => typeof word?.text === 'string' && word.text.trim());
  const lower = text.toLocaleLowerCase();
  const spans = [];
  let cursor = 0;
  let mapped = 0;
  for (const word of sourceWords) {
    const token = word.text.trim();
    const index = lower.indexOf(token.toLocaleLowerCase(), cursor);
    if (index < 0) continue;
    const separatorBefore = spans.length ? text.slice(spans[spans.length - 1].end, index) : text.slice(0, index);
    const cleanWord = { ...word, text: text.slice(index, index + token.length) };
    spans.push({ word: cleanWord, wordId: cleanWord.id, start: index, end: index + token.length,
      separatorBefore, fileId: cleanWord.fileId, page: cleanWord.page, bbox: cleanWord.bbox });
    cursor = index + token.length;
    mapped += 1;
  }
  return { text, spans, words: spans.map((span) => span.word), separators: spans.map((span) => span.separatorBefore),
    mapping: { totalWords: sourceWords.length, mappedWords: mapped,
      alignmentRatio: sourceWords.length ? mapped / sourceWords.length : (text ? 0 : 1) } };
}

function assessCanonicalTranscriptQuality(canonical) {
  const pages = Array.isArray(canonical?.pages) ? canonical.pages : [];
  const diagnostics = pages.map((page) => ({ fileId: page.fileId, pageNumber: page.pageNumber,
    alignmentRatio: Number(page.mapping?.alignmentRatio ?? 1), mappedWords: Number(page.mapping?.mappedWords || 0),
    totalWords: Number(page.mapping?.totalWords || 0) }));
  const unreliable = diagnostics.find((item) => item.totalWords >= 8 && item.alignmentRatio < 0.6);
  return { reliable: !unreliable && Boolean(String(canonical?.text || '').trim()),
    code: unreliable ? 'OCR_READING_ORDER_UNRELIABLE' : (!String(canonical?.text || '').trim() ? 'OCR_TEXT_EMPTY' : null),
    diagnostics };
}

function normalizeLegacyDisplayText(value) {
  const lines = normalizeOcrTranscript(value).split('\n');
  const paragraphs = [];
  let current = [];
  const flush = () => { if (current.length) paragraphs.push(current.join(' ').replace(/\s+/gu, ' ').trim()); current = []; };
  for (const line of lines) {
    if (!line) flush(); else current.push(line);
  }
  flush();
  return paragraphs.filter(Boolean).join('\n\n');
}

function getNormalizedSubmissionTranscript(submission) {
  return buildCanonicalSubmissionTranscript(submission).text;
}

function buildCanonicalSubmissionTranscript(submission) {
  const empty = { text: '', pages: [], paragraphs: [], wordSpans: [], separators: [], source: 'none',
    isComplete: false, version: CANONICAL_TRANSCRIPT_LAYOUT_VERSION };
  if (!submission || typeof submission !== 'object') return empty;
  const explicitOrder = Array.isArray(submission.fileOrder) ? submission.fileOrder
    .map((entry) => ({ id: String(entry?.fileId?._id || entry?.fileId || ''), order: Number(entry?.order) }))
    .filter((entry) => entry.id && Number.isFinite(entry.order)).sort((a, b) => a.order - b.order) : [];
  // Legacy records fall back deterministically to the persisted Submission.files array order.
  const expected = (explicitOrder.length ? explicitOrder.map((entry) => entry.id)
    : (Array.isArray(submission.files) && submission.files.length ? submission.files : (submission.file ? [submission.file] : [])))
    .map((item) => String(item?._id || item));
  const order = new Map(expected.map((id, index) => [id, index]));
  const seen = new Set();
  const pages = (Array.isArray(submission.ocrPages) ? submission.ocrPages : [])
    .map((page, originalIndex) => ({ page, originalIndex, fileId: String(page?.fileId?._id || page?.fileId || ''),
      fileOrder: Number.isFinite(Number(page?.fileOrder)) ? Number(page.fileOrder) : null,
      pageNumber: Number(page?.pageNumber || 1), pageIndex: Number.isFinite(Number(page?.pageIndex)) ? Number(page.pageIndex) : null }))
    .filter(({ page, fileId, pageNumber }) => page && fileId && Number.isFinite(pageNumber))
    .sort((a, b) => (order.get(a.fileId) ?? a.fileOrder ?? Number.MAX_SAFE_INTEGER)
      - (order.get(b.fileId) ?? b.fileOrder ?? Number.MAX_SAFE_INTEGER)
      || (a.pageIndex ?? a.pageNumber - 1) - (b.pageIndex ?? b.pageNumber - 1)
      || a.pageNumber - b.pageNumber || a.originalIndex - b.originalIndex)
    .filter(({ fileId, pageNumber }) => { const key = `${fileId}:${pageNumber}`; if (seen.has(key)) return false; seen.add(key); return true; });
  const completed = new Set(pages.filter(({ page }) => normalizeOcrTranscript(page.text || '') || buildCanonicalPageFromWords(page.words || []).text)
    .map(({ fileId }) => fileId));
  const isComplete = expected.length > 0 && expected.every((id) => completed.has(id));
  let text = '';
  let lastWordText = '';
  const manifest = [];
  const wordSpans = [];
  for (const entry of pages) {
    const identifiedWords = (Array.isArray(entry.page.words) ? entry.page.words : []).map((word, index) => ({
      ...word,
      id: `word_${entry.fileId}_${entry.pageNumber}_${typeof word?.id === 'string' && word.id ? word.id : index + 1}`,
      fileId: entry.fileId,
      page: entry.pageNumber
    }));
    const structured = buildCanonicalPageFromWords(identifiedWords);
    const authoritativeText = normalizeLegacyDisplayText(entry.page.rawText || '');
    const authoritative = authoritativeText ? alignWordsToAuthoritativeText(authoritativeText, identifiedWords) : null;
    const selected = authoritative || structured;
    const pageText = selected.text || normalizeLegacyDisplayText(entry.page.text || '');
    if (!pageText) continue;
    const pageSeparator = text ? getOcrWordSeparator(lastWordText || text.slice(-1), pageText, ' ') : '';
    text += pageSeparator;
    const startChar = text.length;
    text += pageText;
    const pageSpans = selected.spans.map((span, index) => ({ ...span,
      start: span.start + startChar, end: span.end + startChar,
      separatorBefore: index === 0 ? pageSeparator : span.separatorBefore,
      fileId: entry.fileId, page: entry.pageNumber }));
    wordSpans.push(...pageSpans);
    manifest.push({ fileId: entry.fileId,
      fileOrder: order.get(entry.fileId) ?? entry.fileOrder ?? Number.MAX_SAFE_INTEGER,
      pageNumber: entry.pageNumber, pageIndex: entry.pageIndex ?? entry.pageNumber - 1, text: pageText,
      source: authoritative ? 'visionFullText' : 'wordReconstruction', mapping: selected.mapping || null,
      startChar, endChar: text.length, words: pageSpans.map((span) => ({ ...span.word, fileId: entry.fileId,
      page: entry.pageNumber, separatorBefore: span.separatorBefore })), paragraphs: paragraphsFromSpans(pageText, selected.spans).map((paragraph) => ({
        ...paragraph, startChar: paragraph.startChar + startChar, endChar: paragraph.endChar + startChar })) });
    lastWordText = selected.spans[selected.spans.length - 1]?.word?.text || pageText;
  }
  if (text) return { text, pages: manifest, paragraphs: paragraphsFromSpans(text, wordSpans), wordSpans,
    separators: wordSpans.map((span) => span.separatorBefore), source: 'ocrPages', isComplete,
    version: CANONICAL_TRANSCRIPT_LAYOUT_VERSION };
  const fallbacks = [['combinedOcrText', submission.combinedOcrText], ['transcriptText', submission.transcriptText], ['ocrText', submission.ocrText]];
  for (const [source, value] of fallbacks) {
    const fallbackText = normalizeLegacyDisplayText(value || '');
    if (fallbackText) return { ...empty, text: fallbackText, paragraphs: paragraphsFromSpans(fallbackText, []), source,
      isComplete: expected.length <= 1 };
  }
  return empty;
}

function withNormalizedWordSeparators(words) {
  return buildCanonicalPageFromWords(words).spans.map((span) => ({ ...span.word, separatorBefore: span.separatorBefore }));
}

module.exports = {
  CANONICAL_TRANSCRIPT_LAYOUT_VERSION,
  normalizeOcrTranscript,
  getOcrWordSeparator,
  buildNormalizedTranscriptFromWords,
  buildCanonicalPageFromWords,
  alignWordsToAuthoritativeText,
  assessCanonicalTranscriptQuality,
  sanitizeOcrMarginArtifacts,
  normalizeLegacyDisplayText,
  buildCanonicalSubmissionTranscript,
  getNormalizedSubmissionTranscript,
  withNormalizedWordSeparators
};
