'use strict';
// Server-side validation for "teacher uploads students' handwritten work". Pure functions: the client is never trusted, and
// every name, email, key and mode is normalised or rejected here before it reaches the database, an email or a log.

const MAX_STUDENTS_PER_REQUEST = 100;
const MAX_NAME_LENGTH = 120;
const MAX_EMAIL_LENGTH = 254;
const MODES = Object.freeze(['new', 'replace', 'add_pages']);

// Local part and domain without whitespace, angle brackets, quotes, commas, semicolons or line breaks (no header injection),
// a dot in the domain and a 2+ letter top-level part.
const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
// Control and format characters (line breaks, NUL, zero-width and bidi controls) are removed from names.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

function normalizeName(raw) {
  if (typeof raw !== 'string') return { error: 'Enter the student\'s name.' };
  const value = raw.normalize('NFC').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
  if (!value) return { error: 'Enter the student\'s name.' };
  if (value.length > MAX_NAME_LENGTH) return { error: `Use a name of ${MAX_NAME_LENGTH} characters or fewer.` };
  if (/[<>]/.test(value)) return { error: 'Names cannot contain < or >.' };
  return { value };
}

function normalizeEmail(raw) {
  if (typeof raw !== 'string') return { error: 'Enter the student\'s email address.' };
  const trimmed = raw.trim();
  if (!trimmed) return { error: 'Enter the student\'s email address.' };
  if (/[\r\n]/.test(trimmed)) return { error: 'Enter a valid email address.' };
  const value = trimmed.toLowerCase();
  if (value.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(value)) return { error: 'Enter a valid email address.' };
  return { value };
}

/**
 * Validates a list of { name, email } rows. Returns every row with its normalised values or its errors, flagging a repeated
 * email (case-insensitive) on every occurrence after the first. Throws on a malformed request (not an array, too many rows).
 */
function validateStudents(list) {
  if (!Array.isArray(list) || !list.length) throw inputError('Add at least one student.');
  if (list.length > MAX_STUDENTS_PER_REQUEST) throw inputError(`Add up to ${MAX_STUDENTS_PER_REQUEST} students at a time.`);
  const seen = new Map();
  return list.map((row, index) => {
    const name = normalizeName(row && row.name), email = normalizeEmail(row && row.email);
    const errors = {};
    if (name.error) errors.name = name.error;
    if (email.error) errors.email = email.error;
    else if (seen.has(email.value)) errors.email = `This email is already in row ${seen.get(email.value) + 1}.`;
    else seen.set(email.value, index);
    return { index, name: name.value, email: email.value, ...(Object.keys(errors).length ? { errors } : {}) };
  });
}

function requestKey(raw) {
  const value = String(raw || '');
  if (!/^[\w-]{32,128}$/.test(value)) throw inputError('The upload reference is invalid. Please try again.');
  return value;
}
function batchId(raw) {
  const value = String(raw || '');
  if (!/^[\w-]{8,64}$/.test(value)) throw inputError('The batch reference is invalid. Please try again.');
  return value;
}
function mode(raw) {
  const value = raw == null || raw === '' ? 'new' : String(raw);
  if (!MODES.includes(value)) throw inputError('Choose whether to replace the pages or add them.');
  return value;
}

function inputError(message, code = 'TEACHER_UPLOAD_INVALID') {
  return Object.assign(new Error(message), { statusCode: 400, code });
}

module.exports = { MAX_STUDENTS_PER_REQUEST, MODES, normalizeName, normalizeEmail, validateStudents, requestKey, batchId, mode, inputError };
