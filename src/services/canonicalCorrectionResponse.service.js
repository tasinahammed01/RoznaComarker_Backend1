'use strict';

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

module.exports = { normalizedId, scopeCanonicalPages, scopeCanonicalCorrections };
