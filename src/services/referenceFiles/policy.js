'use strict';
// AI knowledge and reference files: the feature switch, the limits and the teacher-facing failure messages.
// Reference files are teacher-only background material for marking. Nothing here, and nothing derived from these files, may reach a student or guest.

/** REFERENCE_FILES_ENABLED=true turns the feature on (routes, UI and use in marking). Anything else, or unset, leaves it off. */
const referenceFilesEnabled = (env = process.env) => String(env.REFERENCE_FILES_ENABLED || '').trim().toLowerCase() === 'true';

const LIMITS = Object.freeze({
  maxFileBytes: 10 * 1024 * 1024,      // 10 MB per file
  maxFilesPerScope: 5,                 // per class and per assignment (stage 2 enforces it)
  zipMaxEntries: 2000,                 // DOCX/PPTX are zip archives
  zipMaxUncompressedBytes: 100 * 1024 * 1024,
  zipMaxRatio: 100,                    // 100:1 compression ratio
  zipRatioMinBytes: 1024 * 1024,       // the per-part ratio applies to parts over 1 MB once unpacked; small parts compress well legitimately
  extractionTimeoutMs: 20000,          // 20 s for one file, once it starts
  extractionQueueTimeoutMs: 120000,    // waiting for the single extraction worker
  extractionMemoryMb: 256,
  maxStoredTextChars: 200000,          // cached extracted text; marking uses a much smaller, fixed budget
  minReadableLetters: 20,
  maxAttempts: 3,
  leaseMs: 60000
});

const EXTRACTION_VERSION = 'reference-text-v1';

// Teacher-facing messages. Codes are stable for the UI and tests; messages never include paths, internal errors or file contents.
const MESSAGES = Object.freeze({
  REFERENCE_FILE_EMPTY: 'This file is empty.',
  REFERENCE_FILE_TOO_LARGE: 'Each file must be 10 MB or smaller.',
  REFERENCE_FILE_TYPE: 'Please use PDF, Word (.doc or .docx) or PowerPoint (.pptx).',
  REFERENCE_FILE_OLD_POWERPOINT: 'Old PowerPoint files (.ppt) are not supported. Please save as .pptx.',
  REFERENCE_FILE_MISMATCH: "This file's content does not match its type. Please upload the original PDF, Word or PowerPoint file.",
  REFERENCE_FILE_MACRO: 'Files with macros are not accepted. Please save it as a normal .docx or .pptx file without macros.',
  REFERENCE_FILE_PASSWORD: 'This file is password protected. Please upload an unlocked copy.',
  REFERENCE_FILE_CORRUPT: 'This file could not be read. It may be damaged.',
  REFERENCE_FILE_ARCHIVE_LIMIT: 'This file is too complex to read safely (too many parts, or too large once unpacked).',
  REFERENCE_FILE_NO_TEXT_PDF: 'No readable text found (scanned PDF).',
  REFERENCE_FILE_NO_TEXT: 'No readable text found in this file.',
  REFERENCE_FILE_TIMEOUT: 'This file took too long to read. Please try a smaller file.',
  REFERENCE_FILE_TOO_COMPLEX: 'This file is too complex to read. Please try a smaller file.',
  REFERENCE_FILE_BUSY: 'Files are being read for other teachers right now. This file will be tried again shortly.',
  REFERENCE_FILE_EXTRACTION_FAILED: 'This file could not be read. Please try again or upload another copy.'
});
// Failures worth another attempt; every other code is final for that file.
const RETRYABLE = new Set(['REFERENCE_FILE_BUSY', 'REFERENCE_FILE_EXTRACTION_FAILED']);

class ReferenceFileError extends Error {
  constructor(code) {
    super(MESSAGES[code] || MESSAGES.REFERENCE_FILE_EXTRACTION_FAILED);
    this.name = 'ReferenceFileError';
    this.code = MESSAGES[code] ? code : 'REFERENCE_FILE_EXTRACTION_FAILED';
    this.safeMessage = this.message;
    this.retryable = RETRYABLE.has(this.code);
  }
}

const KINDS = Object.freeze({ '.pdf': 'pdf', '.docx': 'docx', '.doc': 'doc', '.pptx': 'pptx' });

// Invisible and direction-changing characters: they can hide text from a teacher reviewing a name or from a reader of the extracted text.
const INVISIBLE = /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]/gu;
// Control characters except tab and newline.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;

/** The extension of an uploaded name, lower case, with its dot ('' when none). */
function extensionOf(name) {
  const base = String(name || '').split(/[\\/]/u).pop() || '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

/**
 * The name shown to the teacher: the last path segment only, without control or invisible characters, at most 120 characters, keeping the
 * extension. It is display text only: the stored file always gets a random server-side name, so no part of this ever becomes a path.
 */
function safeDisplayName(name, kind) {
  const ext = extensionOf(name);
  let base = String(name || '').split(/[\\/]/u).pop() || '';
  base = base.normalize('NFC').replace(INVISIBLE, '').replace(CONTROL, '').replace(/\s+/gu, ' ').trim();
  let stem = ext && base.toLowerCase().endsWith(ext) ? base.slice(0, -ext.length).trim() : base;
  stem = stem.replace(/^[.\s]+/u, '');
  const suffix = ext || (kind ? `.${kind}` : '');
  const room = 120 - suffix.length;
  if (Array.from(stem).length > room) stem = Array.from(stem).slice(0, room).join('').trim();
  return `${stem || 'Reference file'}${suffix}`;
}

module.exports = { referenceFilesEnabled, LIMITS, EXTRACTION_VERSION, MESSAGES, ReferenceFileError, KINDS, INVISIBLE, CONTROL, extensionOf, safeDisplayName };
