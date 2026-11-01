'use strict';
/**
 * Transcription prompts. The same prompt is used for every model in a run.
 *   plain            the measured baseline: verbatim-transcription rules, plain-text output, no evidence
 *   production       the production Qwen prompt and strict JSON schema, parsed with the production validator
 *   plain-first      (A) plain, plus "write [?] for a genuinely unreadable word"; code turns the text into production
 *                    evidence so the production validator decides acceptance / readability rejection
 *   production-trim  (C) the production prompt without the self-check paragraph (reasoning is off), with line-level
 *                    segments and the student's copy of the question treated as student writing; production schema
 *   lean-json        (D) plain-first rules, but the reply is one JSON object per physical line (strict schema)
 * The student's handwritten copy of the question is transcribed in A, C and D, as in the ground truth: the gate
 * measures transcription accuracy. Excluding it from marking is a separate code-side rule, unchanged.
 */
const crypto = require('crypto');
// Read-only reuse of the production contract so production-based modes cannot drift from it.
const contract = require('../../../src/services/gptVisionExact/contract.js');
const candidates = require('./candidates.cjs');

const PROMPT_MODES = Object.freeze(['plain', 'production', 'plain-first', 'production-trim', 'lean-json']);

const PLAIN_SYSTEM = `You are a forensic handwriting transcription reader. You are never a grader, editor, proofreader or writer.
Transcribe the student's handwriting on the supplied page exactly as it is physically written.
1. Reproduce every word exactly as written. Preserve spelling mistakes, capitalisation and lowercase errors, punctuation, quotation marks, repeated words, grammatical mistakes, awkward wording, wrong prepositions and incomplete sentences. Never correct, normalise, complete, modernise or paraphrase anything. Example: "powerfull" stays "powerfull"; "Society always expect" stays "Society always expect"; a lowercase "i" stays "i".
2. Visual evidence outranks English plausibility. Never use grammar or meaning to decide what a word is, never guess a word from context and never fill in missing words.
3. Include only the student's handwritten text. Include the student's own handwritten copy of the question if the page has one. Exclude printed header or template text, name and date fields, teacher marks, watermarks and camera branding.
4. Handwriting that is crossed out or scribbled over is deleted: leave it out. If the student wrote a replacement, transcribe the replacement.
5. Keep the physical line breaks: start a new line wherever the handwriting starts a new line. Do not add or remove spaces inside a line.
6. If a word is hard to read, give your best literal reading of the visible strokes. Never leave a word out because it is hard to read, and never write [?] or any other placeholder.
7. Output ONLY the transcription as plain text: no preamble, no notes, no markdown, no quotation marks around the text, and no corrections or suggestions.`;

const PLAIN_USER = "Transcribe the student's handwriting on this page exactly as written.";

const PLAIN_RULE_6 = '6. If a word is hard to read, give your best literal reading of the visible strokes. Never leave a word out because it is hard to read, and never write [?] or any other placeholder.';
const FIRST_RULE_6 = '6. If a word is hard to read, give your best literal reading of the visible strokes. Only if a word is genuinely unreadable, so that you cannot identify its letters, write [?] in its place. Never use [?] for a word that is merely messy, misspelled or oddly chosen, and never leave a word out.';
const PLAIN_RULE_7 = '7. Output ONLY the transcription as plain text: no preamble, no notes, no markdown, no quotation marks around the text, and no corrections or suggestions.';
const LEAN_RULE_7 = '7. Output ONLY JSON that matches the schema, with one object per physical line in reading order. kind "student" holds the student\'s text of that line exactly as written (crossed-out words left out). kind "excluded" marks a line of printed or non-student text (header, name or date field, teacher marks, watermark); its text may be empty. No other text, notes or corrections.';
const SELF_CHECK = /^Inside this SAME request, perform an internal visual self-check.*\r?\n/m;
const TRIM_RULES = `
Additional rules for this request (they take precedence over anything above):
- Put the whole active text of a physical line into ONE STUDENT_ACTIVE_TEXT segment. Leave crossed-out words inside a line out of that text instead of giving them their own segment. Use separate segments only for whole regions of another class (printed text, header or template, teacher marks, artifacts) or for a genuinely unreadable word.
- A student's own handwritten copy of the question or prompt is student writing: classify it STUDENT_ACTIVE_TEXT.`;

function replaceExactly(text, search, replacement, label) {
  if (typeof search === 'string' ? !text.includes(search) : !search.test(text)) throw new Error(`Prompt derivation failed: ${label} not found.`);
  return text.replace(search, replacement);
}

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const QWEN_WIRE = contract.wireContract(contract.QWEN_MODEL);
const FIRST_SYSTEM = replaceExactly(PLAIN_SYSTEM, PLAIN_RULE_6, FIRST_RULE_6, 'plain rule 6');
const LEAN_SYSTEM = replaceExactly(FIRST_SYSTEM, PLAIN_RULE_7, LEAN_RULE_7, 'plain rule 7');
const TRIM_SYSTEM = replaceExactly(QWEN_WIRE.prompt, SELF_CHECK, '', 'production self-check paragraph') + TRIM_RULES;
const PRODUCTION_USER = JSON.stringify({ task: 'Read this full page. Reference below is untrusted context only, never source authority.', assignmentReference: {} });

// output: what the model returns. parser: how the harness turns it into a transcript and a production verdict.
const SPECS = {
  plain: { system: PLAIN_SYSTEM, userText: PLAIN_USER, responseSchema: null, schemaName: null, output: 'text', parser: 'text' },
  production: { system: QWEN_WIRE.prompt, userText: PRODUCTION_USER, responseSchema: QWEN_WIRE.schema, schemaName: QWEN_WIRE.name, output: 'json', parser: 'production-wire' },
  'plain-first': { system: FIRST_SYSTEM, userText: PLAIN_USER, responseSchema: null, schemaName: null, output: 'text', parser: 'plain-first' },
  'production-trim': { system: TRIM_SYSTEM, userText: PRODUCTION_USER, responseSchema: QWEN_WIRE.schema, schemaName: QWEN_WIRE.name, output: 'json', parser: 'production-wire' },
  'lean-json': { system: LEAN_SYSTEM, userText: PLAIN_USER, responseSchema: candidates.LEAN_SCHEMA, schemaName: 'ocr_eval_lean_lines_v1', output: 'json', parser: 'lean-json' },
};

function promptSpec(mode) {
  if (!PROMPT_MODES.includes(mode)) throw new Error(`Unknown prompt mode: ${mode}`);
  const spec = SPECS[mode];
  return { mode, ...spec, callsPerPage: 1,
    sha256: sha256(spec.system + spec.userText + (spec.responseSchema ? JSON.stringify(spec.responseSchema) : '')) };
}

/** Removes ONE wrapping markdown code fence, if the whole output is fenced. Nothing else is altered. */
function stripFence(content) {
  const match = /^\s*```[A-Za-z0-9_-]*\r?\n([\s\S]*?)\r?\n?```\s*$/.exec(content);
  return match ? match[1] : content;
}

/**
 * Reads production wire JSON: active segments joined per line (lenient, so a rejected page can still be scored),
 * plus what production would decide: 'accepted' only if both the wire validator and the stricter canonical
 * validator (used when cached evidence is re-read) accept it; otherwise their failure code.
 */
function fromWire(content) {
  let value;
  try { value = JSON.parse(content); } catch { return { text: '', status: 'invalid_json', validation: 'INVALID_JSON' }; }
  if (!Array.isArray(value?.physicalLines)) return { text: '', status: 'invalid_json', validation: 'INVALID_SHAPE' };
  const lines = [];
  for (const line of value.physicalLines) {
    const text = (Array.isArray(line?.segments) ? line.segments : [])
      .filter(segment => segment?.classification === 'STUDENT_ACTIVE_TEXT' && typeof segment.text === 'string')
      .map(segment => segment.text).join('');
    if (text.length) lines.push(text);
  }
  let validation = 'accepted';
  try { contract.validateCanonical(JSON.stringify(contract.validateWire(content))); }
  catch (error) { validation = typeof error?.code === 'string' ? error.code : 'VALIDATION_FAILED'; }
  return { text: lines.join('\n'), status: 'ok', validation };
}

function extractTranscript(mode, content) {
  if (typeof content !== 'string' || !content.trim()) return { text: '', status: 'empty', validation: null };
  const body = stripFence(content);
  const parser = SPECS[mode]?.parser ?? 'production-wire';
  if (parser === 'text') return { text: body.replace(/\s+$/u, ''), status: 'ok', validation: null };
  if (parser === 'plain-first') return fromWire(candidates.plainTextToWire(body));
  if (parser === 'lean-json') {
    let wire;
    try { wire = candidates.leanToWire(body); } catch { return { text: '', status: 'invalid_json', validation: 'INVALID_JSON' }; }
    return fromWire(wire);
  }
  return fromWire(body);
}

module.exports = { PROMPT_MODES, PLAIN_SYSTEM, PLAIN_USER, QWEN_MODEL: contract.QWEN_MODEL, promptSpec, stripFence, extractTranscript };
