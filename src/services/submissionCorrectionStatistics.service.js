const crypto = require('crypto');

const logger = require('../utils/logger');
const { buildOcrCorrections, normalizeOcrWordsFromStored } = require('./ocrCorrections.service');
const { getNormalizedSubmissionTranscript } = require('../utils/ocrTranscriptNormalizer');

const EMPTY_STATISTICS = Object.freeze({
  content: 0,
  grammar: 0,
  organization: 0,
  vocabulary: 0,
  mechanics: 0,
  total: 0
});

function correctionCategory(correction) {
  const raw = String(correction?.groupKey || correction?.groupLabel || correction?.category || correction?.group || '')
    .trim()
    .toLowerCase();
  if (!raw) return null;
  if (raw.includes('grammar')) return 'grammar';
  if (raw.includes('spelling') || raw.includes('typography') || raw.includes('mechanic')) return 'mechanics';
  if (raw.includes('style') || raw.includes('organization') || raw.includes('structure')) return 'organization';
  if (raw.includes('vocab') || raw.includes('word choice')) return 'vocabulary';
  if (raw.includes('content')) return 'content';
  // Preserve the existing backend mapping: recognized LanguageTool groups not
  // covered above are content issues.
  if (correction?.groupKey || correction?.groupLabel) return 'content';
  return null;
}

function stableString(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(stableString).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${key}:${stableString(value[key])}`).join(',')}}`;
  }
  return '';
}

function correctionKey(correction, context = {}) {
  const id = String(correction?._id || correction?.id || '').trim();
  const fileId = String(correction?.fileId || context.fileId || '').trim();
  const page = Number(correction?.page ?? correction?.pageNumber ?? context.pageNumber ?? 1) || 1;
  if (id && !/^lt_\d+$/i.test(id)) return `id:${id}`;
  if (id) return `page-id:${fileId}:${page}:${id}`;

  const fingerprint = [
    fileId,
    page,
    correction?.symbol || correction?.code || '',
    correction?.groupKey || correction?.groupLabel || correction?.category || correction?.group || '',
    correction?.wrongText || correction?.text || correction?.message || correction?.comment || '',
    correction?.startChar ?? correction?.start ?? '',
    correction?.endChar ?? correction?.end ?? '',
    stableString(correction?.bboxList || correction?.bbox || correction?.coordinates || '')
  ].join('|');
  return `fp:${crypto.createHash('sha256').update(fingerprint).digest('hex')}`;
}

function countSubmissionCorrections(entries) {
  const statistics = { ...EMPTY_STATISTICS };
  const seen = new Set();
  let beforeDedupe = 0;

  for (const entry of Array.isArray(entries) ? entries : []) {
    const correction = entry?.correction || entry;
    if (!correction || typeof correction !== 'object' || correction.deleted === true || correction.isDeleted === true) continue;
    const category = correctionCategory(correction);
    if (!category) continue;
    beforeDedupe += 1;
    const key = correctionKey(correction, entry?.context || {});
    if (seen.has(key)) continue;
    seen.add(key);
    statistics[category] += 1;
  }

  statistics.total = statistics.content + statistics.grammar + statistics.organization + statistics.vocabulary + statistics.mechanics;
  return { statistics, beforeDedupe, afterDedupe: seen.size };
}

async function buildSubmissionCorrectionStatistics(submission, options = {}) {
  if (!submission || typeof submission !== 'object') return { ...EMPTY_STATISTICS };
  const buildCorrections = options.buildCorrections || buildOcrCorrections;
  const entries = [];
  const add = (list, context = {}) => {
    for (const correction of Array.isArray(list) ? list : []) entries.push({ correction, context });
  };

  add(submission.corrections);
  add(submission.ocrCorrections);
  add(submission.annotations);

  const pages = Array.isArray(submission.ocrPages) ? submission.ocrPages.filter(Boolean) : [];
  await Promise.all(pages.map(async (page) => {
    const context = { fileId: page.fileId, pageNumber: page.pageNumber };
    const storedCorrections = page.corrections || page.ocrCorrections || page.annotations;
    if (Array.isArray(storedCorrections)) {
      add(storedCorrections, context);
      return;
    }
    try {
      const words = normalizeOcrWordsFromStored(page.words);
      const built = await buildCorrections({ text: page.text || '', language: 'en-US', ocrWords: words });
      add(built?.corrections, context);
    } catch (error) {
      logger.warn({ message: 'Correction statistics skipped an OCR page', submissionId: String(submission._id || ''), fileId: String(page.fileId || ''), pageNumber: page.pageNumber, error: error?.message || error });
    }
  }));

  if (!pages.length) {
    const words = normalizeOcrWordsFromStored(submission.ocrData?.words);
    try {
      const built = await buildCorrections({
        text: getNormalizedSubmissionTranscript(submission),
        language: 'en-US',
        ocrWords: words
      });
      add(built?.corrections, { fileId: submission.file, pageNumber: 1 });
    } catch (error) {
      logger.warn({ message: 'Correction statistics skipped legacy OCR text', submissionId: String(submission._id || ''), error: error?.message || error });
    }
  }

  const result = countSubmissionCorrections(entries);
  if (process.env.NODE_ENV !== 'production') {
    logger.debug({
      message: 'Submission correction statistics built',
      submissionId: String(submission._id || ''),
      correctionsBeforeDedupe: result.beforeDedupe,
      correctionsAfterDedupe: result.afterDedupe,
      correctionStatistics: result.statistics,
      pagesIncluded: pages.length || 1
    });
  }
  return result.statistics;
}

module.exports = {
  EMPTY_STATISTICS,
  correctionCategory,
  countSubmissionCorrections,
  buildSubmissionCorrectionStatistics
};
