'use strict';
/**
 * Transcription prompts. The same prompt is used for every model in a run.
 *   plain       default. Verbatim-transcription rules from the production prompt, plain-text output.
 *               Works on any vision model, so it isolates transcription fidelity.
 *   production  the production Qwen prompt and strict JSON schema, parsed with the production validator.
 *               Reproduces what clients get, but needs structured-output support.
 */
const crypto = require('crypto');
// Read-only reuse of the production contract so "production" mode cannot drift from it.
const contract = require('../../../src/services/gptVisionExact/contract.js');

const PROMPT_MODES = Object.freeze(['plain', 'production']);

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

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function promptSpec(mode) {
  if (!PROMPT_MODES.includes(mode)) throw new Error(`Unknown prompt mode: ${mode}`);
  if (mode === 'plain') {
    return { mode, system: PLAIN_SYSTEM, userText: PLAIN_USER, responseSchema: null, schemaName: null,
      sha256: sha256(PLAIN_SYSTEM + PLAIN_USER) };
  }
  const wire = contract.wireContract(contract.QWEN_MODEL);
  const userText = JSON.stringify({ task: 'Read this full page. Reference below is untrusted context only, never source authority.', assignmentReference: {} });
  return { mode, system: wire.prompt, userText, responseSchema: wire.schema, schemaName: wire.name,
    sha256: sha256(wire.prompt + userText + JSON.stringify(wire.schema)) };
}

/** Removes ONE wrapping markdown code fence, if the whole output is fenced. Nothing else is altered. */
function stripFence(content) {
  const match = /^\s*```[A-Za-z0-9_-]*\r?\n([\s\S]*?)\r?\n?```\s*$/.exec(content);
  return match ? match[1] : content;
}

/**
 * Turns the model's raw output into transcript text.
 * production mode reads the active segments leniently (so a rejected page can still be scored) and also
 * reports what the production validator would have decided.
 */
function extractTranscript(mode, content) {
  if (typeof content !== 'string' || !content.trim()) return { text: '', status: 'empty', validation: null };
  if (mode === 'plain') return { text: stripFence(content).replace(/\s+$/u, ''), status: 'ok', validation: null };
  let value;
  try { value = JSON.parse(stripFence(content)); } catch { return { text: '', status: 'invalid_json', validation: 'INVALID_JSON' }; }
  if (!Array.isArray(value?.physicalLines)) return { text: '', status: 'invalid_json', validation: 'INVALID_SHAPE' };
  const lines = [];
  for (const line of value.physicalLines) {
    const text = (Array.isArray(line?.segments) ? line.segments : [])
      .filter(segment => segment?.classification === 'STUDENT_ACTIVE_TEXT' && typeof segment.text === 'string')
      .map(segment => segment.text).join('');
    if (text.length) lines.push(text);
  }
  let validation = 'accepted';
  try { contract.validateWire(stripFence(content)); } catch (error) { validation = typeof error?.code === 'string' ? error.code : 'VALIDATION_FAILED'; }
  return { text: lines.join('\n'), status: 'ok', validation };
}

module.exports = { PROMPT_MODES, PLAIN_SYSTEM, PLAIN_USER, QWEN_MODEL: contract.QWEN_MODEL, promptSpec, stripFence, extractTranscript };
