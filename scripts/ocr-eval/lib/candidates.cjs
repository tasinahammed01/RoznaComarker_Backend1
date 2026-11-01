'use strict';
/**
 * Candidate designs produce plain transcription text (A) or a lean one-object-per-line JSON (D). This module turns
 * that into the production "wire" JSON (the Qwen physical-source contract) so the PRODUCTION validators decide
 * whether the page would be accepted, rejected as unreadable, or invalid. Nothing here calls a model.
 *
 *  - every non-empty line becomes STUDENT_ACTIVE_TEXT (long lines split into <= 2000-character segments)
 *  - a token containing "[?]" becomes an UNCERTAIN segment with an ACTIVE_TEXT_UNCERTAIN entry, so production's
 *    existing readability gate rejects the page exactly as it does today; readable words keep single spaces
 *  - lean "excluded" lines become non-active HEADER_OR_TEMPLATE segments (kept out of the transcript)
 */
const contract = require('../../../src/services/gptVisionExact/contract.js');

const LEAN_VERSION = 'lean-lines-v1';
const MAX_SEGMENT = 2000; // contract schema maxLength per segment text
const UNCERTAIN_TOKEN = /(\S*\[\?\]\S*)/;
const closed = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const LEAN_SCHEMA = closed({
  version: { type: 'string', enum: [LEAN_VERSION] },
  lines: { type: 'array', maxItems: 300, items: closed({ text: { type: 'string', maxLength: MAX_SEGMENT }, kind: { type: 'string', enum: ['student', 'excluded'] } }) },
});

/** Splits on code points so no surrogate pair is cut, keeping every piece within the schema limit. */
function pieces(text) {
  const out = [];
  let current = '';
  for (const ch of text) {
    if (current.length + ch.length > MAX_SEGMENT) { out.push(current); current = ''; }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

function lineSegments(line) {
  const parts = line.split(UNCERTAIN_TOKEN); // odd indexes are the [?] tokens
  const segments = [];
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      segments.push({ classification: 'UNCERTAIN', text: part.split('[?]').join('') || null, confidence: 0 });
      return;
    }
    let text = part;
    if (i > 0) text = text.replace(/^\s+/, '');
    if (i < parts.length - 1) text = text.replace(/\s+$/, '');
    if (!text) return;
    // Exactly one space separates readable words on either side of a removed [?] token.
    if (i > 0 && segments.some(s => s.classification === 'STUDENT_ACTIVE_TEXT')) text = ` ${text}`;
    for (const piece of pieces(text)) segments.push({ classification: 'STUDENT_ACTIVE_TEXT', text: piece, confidence: 1 });
  });
  return segments;
}

/** lines: [{ text, kind: 'student' | 'excluded' }] -> production wire JSON string. */
function linesToWire(lines) {
  const physicalLines = [], uncertainties = [];
  for (const { text, kind } of lines) {
    const clean = String(text ?? '').replace(/[\r\n\f\u0000]/g, ' ').trim();
    if (kind === 'excluded') {
      physicalLines.push({ segments: [{ classification: 'HEADER_OR_TEMPLATE', text: clean ? pieces(clean)[0] : null, confidence: 1 }] });
      continue;
    }
    if (!clean) continue;
    const segments = lineSegments(clean);
    if (!segments.length) continue;
    const lineIndex = physicalLines.length;
    segments.forEach((segment, segmentIndex) => {
      if (segment.classification === 'UNCERTAIN') uncertainties.push({ lineIndex, segmentIndex, kind: 'ACTIVE_TEXT_UNCERTAIN', reason: 'Marked unreadable by the reader ([?]).' });
    });
    physicalLines.push({ segments });
  }
  return JSON.stringify({ version: contract.QWEN_WIRE_VERSION, physicalLines, uncertainties });
}

function plainTextToWire(text) {
  return linesToWire(String(text).split(/\r?\n/).map(line => ({ text: line, kind: 'student' })));
}

/** Throws on anything but the lean shape; the caller reports it as invalid output. */
function leanToWire(content) {
  const value = JSON.parse(content);
  if (!value || value.version !== LEAN_VERSION || !Array.isArray(value.lines)
    || value.lines.some(l => !l || typeof l.text !== 'string' || !['student', 'excluded'].includes(l.kind))) {
    throw new Error('Not a lean-lines-v1 reply.');
  }
  return linesToWire(value.lines);
}

module.exports = { LEAN_VERSION, LEAN_SCHEMA, plainTextToWire, leanToWire, linesToWire };
