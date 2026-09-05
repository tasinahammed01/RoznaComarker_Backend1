'use strict';

const CANONICAL_WORD_ID = /^word_.+_[1-9]\d*_.+$/u;

function canonicalOcrWordId({ fileId, pageNumber, storedWordId, wordIndex }) {
  const existing = String(storedWordId ?? '').trim();
  if (existing && CANONICAL_WORD_ID.test(existing)) return existing;
  const file = String(fileId || 'legacy').trim() || 'legacy';
  const page = Number.isFinite(Number(pageNumber)) && Number(pageNumber) > 0 ? Number(pageNumber) : 1;
  const suffix = existing || String(Number.isFinite(Number(wordIndex)) ? Number(wordIndex) + 1 : 1);
  return `word_${file}_${page}_${suffix}`;
}

module.exports = { canonicalOcrWordId };
