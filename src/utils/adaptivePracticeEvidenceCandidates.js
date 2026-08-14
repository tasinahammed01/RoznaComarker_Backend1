'use strict';

const ADAPTIVE_EVIDENCE_MIN_CHARS = 20;
const ADAPTIVE_EVIDENCE_TARGET_MAX_CHARS = 400;
const ADAPTIVE_EVIDENCE_PERSISTED_MAX_CHARS = 500;

function normalizeStructuralWhitespace(value) {
  return String(value || '').replace(/\s+/gu, ' ').trim();
}

function splitAtWordBoundaries(text, maximum = ADAPTIVE_EVIDENCE_TARGET_MAX_CHARS) {
  const words = normalizeStructuralWhitespace(text).split(' ').filter(Boolean);
  const chunks = [];
  let current = '';
  for (const word of words) {
    if (word.length > ADAPTIVE_EVIDENCE_PERSISTED_MAX_CHARS) {
      if (current) chunks.push(current);
      current = '';
      continue;
    }
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maximum) {
      current = next;
    } else {
      if (current) chunks.push(current);
      current = word;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function sentenceAndClauseSegments(transcript) {
  const paragraphs = String(transcript || '').replace(/\r\n?/gu, '\n').split(/\n[ \t]*\n+/gu);
  return paragraphs.flatMap((paragraph) => {
    const normalized = normalizeStructuralWhitespace(paragraph);
    if (!normalized) return [];
    return normalized.match(/[^.!?;]+(?:[.!?;]+(?=\s|$)|$)/gu)
      ?.map((segment) => segment.trim()).filter(Boolean) || [];
  });
}

function mergeShortSegments(segments) {
  const merged = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    if (segment.length < ADAPTIVE_EVIDENCE_MIN_CHARS && previous
      && previous.length + 1 + segment.length <= ADAPTIVE_EVIDENCE_TARGET_MAX_CHARS) {
      merged[merged.length - 1] = `${previous} ${segment}`;
    } else {
      merged.push(segment);
    }
  }
  if (merged.length > 1 && merged[0].length < ADAPTIVE_EVIDENCE_MIN_CHARS
    && merged[0].length + 1 + merged[1].length <= ADAPTIVE_EVIDENCE_TARGET_MAX_CHARS) {
    merged.splice(0, 2, `${merged[0]} ${merged[1]}`);
  }
  return merged;
}

function buildAdaptiveEvidenceCandidates(transcript) {
  const chunks = sentenceAndClauseSegments(transcript)
    .flatMap((segment) => splitAtWordBoundaries(segment));
  return Object.freeze(mergeShortSegments(chunks)
    .filter((text) => text.length > 0 && text.length <= ADAPTIVE_EVIDENCE_PERSISTED_MAX_CHARS)
    .map((text, index) => Object.freeze({ id: `e${index + 1}`, text })));
}

module.exports = {
  ADAPTIVE_EVIDENCE_MIN_CHARS,
  ADAPTIVE_EVIDENCE_TARGET_MAX_CHARS,
  ADAPTIVE_EVIDENCE_PERSISTED_MAX_CHARS,
  buildAdaptiveEvidenceCandidates
};
