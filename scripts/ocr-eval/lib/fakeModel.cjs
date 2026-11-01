'use strict';
/**
 * Deterministic fake models for dry runs: no network, no API key, no spend. They derive their "transcription"
 * from the ground truth with controlled behaviour, so the harness, metrics and reports can be exercised
 * end to end. All numbers they produce are SYNTHETIC.
 *
 *   fake/perfect      returns the ground truth, student mistakes preserved
 *   fake/noisy        random character errors and dropped words
 *   fake/autocorrect  quietly fixes student mistakes (uses the mistakes list when present)
 *   fake/reasoning    noisy, and reports reasoning tokens (exercises the "reasoning was not off" flag)
 *   fake/needs-reasoning  rejects reasoning "none" and "minimal" with HTTP 400 (like a model whose reasoning cannot
 *                         be switched off); accepts low/medium/high/omit and then reports reasoning tokens
 *   fake/always-fails     every call fails with HTTP 503 (exercises --max-failures)
 * Any other model id in a dry run behaves like a generic noisy reader (clearly labelled simulated).
 */
const crypto = require('crypto');
const { tokenize, coreForm, isUncertainToken } = require('./metrics.cjs');
const { QWEN_WIRE_VERSION } = require('../../../src/services/gptVisionExact/contract.js');
const { LEAN_VERSION } = require('./candidates.cjs');

const FAKE_PREFIX = 'fake/';
const FAKE_MODELS = Object.freeze(['fake/perfect', 'fake/noisy', 'fake/autocorrect', 'fake/reasoning', 'fake/needs-reasoning', 'fake/always-fails']);
const isFakeModel = model => typeof model === 'string' && model.startsWith(FAKE_PREFIX);

const PRICES = Object.freeze({ // USD per million tokens, input/output (synthetic)
  'fake/perfect': [0, 0], 'fake/noisy': [0.3, 1.2], 'fake/autocorrect': [0.6, 2.4], 'fake/reasoning': [0.5, 2.0],
  'fake/needs-reasoning': [0.5, 2.0], generic: [0.3, 1.2],
});
const NOISE = Object.freeze({ 'fake/perfect': 0, 'fake/noisy': 0.06, 'fake/autocorrect': 0, 'fake/reasoning': 0.05, 'fake/needs-reasoning': 0.05 });
const REASONING_REJECTED = Object.freeze(['none', 'minimal']);
const VARIANT_NOISE_FACTOR = Object.freeze({ original: 1, preprocessed: 0.8, 'client-export': 1.05 });
const BUILTIN_CORRECTIONS = Object.freeze({ powerfull: 'powerful', recieve: 'receive', wich: 'which', definately: 'definitely', becuase: 'because', teh: 'the', i: 'I' });

function random(seedText) {
  let a = crypto.createHash('sha256').update(seedText).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function faithfulLines(groundTruth) {
  return groundTruth.replace(/\r\n?/g, '\n').split('\n').map(line => tokenize(line).map(token => {
    if (!isUncertainToken(token)) return token;
    return token.split('[?]').join('') || 'unclear';
  })).filter(tokens => tokens.length);
}

function corruptWord(word, rand) {
  const letters = [...word].map((c, i) => (/\p{L}/u.test(c) ? i : -1)).filter(i => i >= 0);
  if (!letters.length) return word;
  const at = letters[Math.floor(rand() * letters.length)], chars = [...word];
  chars[at] = String.fromCharCode(97 + Math.floor(rand() * 26));
  return chars.join('');
}

function applyCorrections(tokens, entries) {
  const ordered = [...entries].sort((a, b) => b.studentTokens.length - a.studentTokens.length);
  const cores = tokens.map(coreForm);
  const out = [];
  for (let i = 0; i < tokens.length;) {
    const entry = ordered.find(e => e.studentTokens.every((t, k) => cores[i + k] === t));
    if (!entry) { out.push(tokens[i]); i++; continue; }
    const last = i + entry.studentTokens.length - 1;
    const lead = tokens[i].match(/^[^\p{L}\p{N}]*/u)[0], trail = tokens[last].match(/[^\p{L}\p{N}]*$/u)[0];
    out.push(`${lead}${entry.correctTokens.join(' ')}${trail}`);
    i = last + 1;
  }
  return out;
}

function simulate({ model, item, variant, promptMode, image, reasoningMode = 'none' }) {
  if (isFakeModel(model) && !FAKE_MODELS.includes(model)) {
    return { ok: false, errorCode: 'UNKNOWN_FAKE_MODEL', errorDetail: `Unknown fake model ${model}. Available: ${FAKE_MODELS.join(', ')}`, latencyMs: 0 };
  }
  if (model === 'fake/always-fails') {
    return { ok: false, errorCode: 'HTTP_503', httpStatus: 503, errorDetail: 'Simulated upstream failure (HTTP 503).', latencyMs: 300 };
  }
  if (model === 'fake/needs-reasoning' && REASONING_REJECTED.includes(reasoningMode)) {
    return { ok: false, errorCode: 'PARAMETER_REJECTED', httpStatus: 400, rejectedParam: 'reasoning.effort', latencyMs: 200,
      errorDetail: `Simulated: reasoning.effort "${reasoningMode}" is not supported by this model. Supported values: low, medium, high.` };
  }
  const rand = random(`${model}|${item.name}|${variant}|${promptMode}`);
  const generic = !isFakeModel(model);
  const baseNoise = generic ? 0.07 + (random(model)() - 0.5) * 0.06 : NOISE[model];
  const noise = baseNoise * (VARIANT_NOISE_FACTOR[variant] ?? 1);
  const autocorrect = model === 'fake/autocorrect';
  const entries = item.mistakes?.entries ?? [];

  const lines = faithfulLines(item.groundTruth).map(tokens => {
    let out = tokens;
    if (autocorrect) {
      out = entries.length ? applyCorrections(out, entries)
        : out.map(token => { const core = coreForm(token); const fixed = BUILTIN_CORRECTIONS[core]; return fixed ? token.replace(core, fixed) : token; });
    }
    return out.filter(() => rand() >= noise / 4).map(token => (rand() < noise ? corruptWord(token, rand) : token)).join(' ');
  }).filter(Boolean);
  let outLines = lines;
  // In the [?] modes the noisy reader sometimes marks a word unreadable (exercises the readability gate).
  if (model === 'fake/noisy' && ['plain-first', 'lean-json'].includes(promptMode) && outLines.length && rand() < 0.12) {
    const words = outLines[0].split(' ');
    words[Math.floor(rand() * words.length)] = '[?]';
    outLines = [words.join(' '), ...outLines.slice(1)];
  }
  const text = outLines.join('\n');

  let content = text;
  if (promptMode === 'lean-json') {
    content = JSON.stringify({ version: LEAN_VERSION, lines: outLines.map(line => ({ text: line, kind: 'student' })) });
  } else if (promptMode === 'production' || promptMode === 'production-trim') {
    const physicalLines = lines.map(line => ({ segments: [{ classification: 'STUDENT_ACTIVE_TEXT', text: line, confidence: 0.9 }] }));
    const uncertainties = [];
    if (model === 'fake/noisy' && rand() < 0.12 && physicalLines.length) {
      physicalLines[0].segments.push({ classification: 'UNCERTAIN', text: null, confidence: 0.2 });
      uncertainties.push({ lineIndex: 0, segmentIndex: 1, kind: 'ACTIVE_TEXT_UNCERTAIN', reason: 'simulated unreadable region' });
    }
    content = JSON.stringify({ version: QWEN_WIRE_VERSION, physicalLines, uncertainties });
  }

  const promptTokens = Math.round(1500 + (image?.width ?? 1000) * (image?.height ?? 1000) / 750);
  const completionTokens = Math.ceil(content.length / 3.2);
  const [inRate, outRate] = PRICES[model] ?? PRICES.generic;
  const reasoningTokens = ['fake/reasoning', 'fake/needs-reasoning'].includes(model) ? completionTokens * 2 : 0;
  return {
    ok: true, content, finishReason: 'stop', httpStatus: 200, reasoningText: false, simulated: true,
    usage: { promptTokens, completionTokens: completionTokens + reasoningTokens, totalTokens: promptTokens + completionTokens + reasoningTokens,
      costUsd: ((promptTokens * inRate) + ((completionTokens + reasoningTokens) * outRate)) / 1e6, reasoningTokens },
    provider: `FakeProvider${rand() < 0.5 ? 'A' : 'B'}`,
    returnedModel: model,
    latencyMs: Math.round(1200 + completionTokens * 9 + rand() * 500),
  };
}

module.exports = { FAKE_PREFIX, FAKE_MODELS, isFakeModel, simulate };
