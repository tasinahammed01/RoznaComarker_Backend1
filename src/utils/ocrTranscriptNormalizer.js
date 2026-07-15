'use strict';

const CLOSING_PUNCTUATION = /^[,.!?:;\)\]\}]/u;
const OPENING_PUNCTUATION = /[\(\[\{]$/u;

function normalizeOcrTranscript(text) {
  if (typeof text !== 'string' || !text) return '';

  const lines = text
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line
      .replace(/[^\S\n]+/gu, ' ')
      .trim()
      .replace(/ +([,.!?:;\)\]\}])/gu, '$1')
      .replace(/([\(\[\{]) +/gu, '$1'));

  const normalizedLines = [];
  let pendingBlankLine = false;

  for (const line of lines) {
    if (!line) {
      if (normalizedLines.length) pendingBlankLine = true;
      continue;
    }
    if (pendingBlankLine) normalizedLines.push('');
    normalizedLines.push(line);
    pendingBlankLine = false;
  }

  return normalizedLines.join('\n').trim();
}

function getOcrWordSeparator(previousText, currentText, preferredSeparator = ' ') {
  if (!previousText) return '';
  if (CLOSING_PUNCTUATION.test(String(currentText || ''))) return '';
  if (OPENING_PUNCTUATION.test(String(previousText || ''))) return '';
  if (preferredSeparator === '\n\n') return '\n\n';
  return preferredSeparator === '\n' ? '\n' : ' ';
}

function buildNormalizedTranscriptFromWords(words, isNewLine) {
  const list = Array.isArray(words) ? words : [];
  const spans = [];
  const separators = [];
  let text = '';
  let previous = null;

  for (const word of list) {
    const wordText = typeof word?.text === 'string' ? word.text.trim() : '';
    if (!wordText) continue;

    const breakHint = previous && typeof isNewLine === 'function' ? isNewLine(previous, word) : false;
    const preferred = breakHint === '\n\n' ? '\n\n' : breakHint ? '\n' : ' ';
    const separatorBefore = getOcrWordSeparator(previous?.text, wordText, previous ? preferred : '');
    text += separatorBefore;
    const start = text.length;
    text += wordText;
    const end = text.length;

    spans.push({ word, start, end, separatorBefore });
    separators.push(separatorBefore);
    previous = word;
  }

  return { text: normalizeOcrTranscript(text), spans, separators };
}

function getNormalizedSubmissionTranscript(submission) {
  if (!submission || typeof submission !== 'object') return '';
  const candidates = [submission.transcriptText, submission.combinedOcrText, submission.ocrText];
  const selected = candidates.find((value) => typeof value === 'string' && value.trim());
  return normalizeOcrTranscript(selected || '');
}

function withNormalizedWordSeparators(words) {
  const list = Array.isArray(words) ? words : [];
  let previous = null;
  return list.map((word) => {
    const bbox = word?.bbox || {};
    const previousBbox = previous?.bbox || {};
    const top = Number.isFinite(Number(bbox.y)) ? Number(bbox.y) : Number(bbox.y0);
    const previousTop = Number.isFinite(Number(previousBbox.y)) ? Number(previousBbox.y) : Number(previousBbox.y0);
    const previousHeight = Number.isFinite(Number(previousBbox.h))
      ? Number(previousBbox.h)
      : Number(previousBbox.y1) - Number(previousBbox.y0);
    const newParagraph = previous && word?.paragraphIndex != null && previous?.paragraphIndex != null
      && Number(word.paragraphIndex) !== Number(previous.paragraphIndex);
    const newLine = previous && [top, previousTop, previousHeight].every(Number.isFinite)
      ? top > previousTop + previousHeight * 1.6
      : false;
    const separatorBefore = getOcrWordSeparator(previous?.text, word?.text, newParagraph ? '\n\n' : newLine ? '\n' : ' ');
    const result = { ...word, separatorBefore };
    previous = word;
    return result;
  });
}

module.exports = {
  normalizeOcrTranscript,
  getOcrWordSeparator,
  buildNormalizedTranscriptFromWords,
  getNormalizedSubmissionTranscript,
  withNormalizedWordSeparators
};
