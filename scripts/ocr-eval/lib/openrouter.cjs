'use strict';
/**
 * Minimal OpenRouter client for the evaluation harness.
 *  - exactly one attempt per call (no retries, so spending is never hidden)
 *  - the API key is passed in by the caller, used only in the Authorization header, and never logged
 *  - every message that leaves this module goes through redact()
 */
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const MAX_OUTPUT_TOKENS = 16000; // same as the production OCR profile
const DEFAULT_TIMEOUT_MS = 180000;
const SORT_VALUES = Object.freeze(['latency', 'throughput', 'price', 'default']);
// 'omit' sends no reasoning parameter at all (the model's own default applies).
const REASONING_MODES = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'omit']);
// '0' sends temperature 0; 'omit' sends none, so the provider default applies (what production does today).
const TEMPERATURE_MODES = Object.freeze(['0', 'omit']);

function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 6) out = out.split(secret).join('[REDACTED]');
  return out.replace(/sk-or-[A-Za-z0-9_-]{6,}/g, '[REDACTED]').replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]');
}

/** All console output of the harness goes through this logger. `secrets` is read at write time. */
function createLogger({ secrets = [], stdout = process.stdout, stderr = process.stderr } = {}) {
  const write = (stream, message) => stream.write(`${redact(message, secrets)}\n`);
  return { info: m => write(stdout, m), warn: m => write(stderr, `WARNING: ${m}`), error: m => write(stderr, `ERROR: ${m}`) };
}

/** What a catalog entry says the model can do. Unknown (no entry) is reported as null, never guessed. */
function capabilitiesFromCatalog(entry) {
  if (!entry) return { found: false, vision: null, temperature: null, reasoning: null, structuredOutputs: null, pricing: null, contextLength: null };
  const params = Array.isArray(entry.supported_parameters) ? entry.supported_parameters : [];
  const perMillion = value => { const n = Number(value) * 1e6; return Number.isFinite(n) ? n : null; };
  return {
    found: true,
    vision: Array.isArray(entry.architecture?.input_modalities) ? entry.architecture.input_modalities.includes('image') : null,
    temperature: params.includes('temperature'),
    reasoning: params.includes('reasoning'),
    structuredOutputs: params.includes('structured_outputs') || params.includes('response_format'),
    pricing: entry.pricing ? { inputPerMillion: perMillion(entry.pricing.prompt), outputPerMillion: perMillion(entry.pricing.completion) } : null,
    contextLength: Number.isFinite(entry.context_length) ? entry.context_length : null,
  };
}

/** Free, unauthenticated catalog request. Never sends the API key. */
async function fetchCatalog({ fetchImpl, timeoutMs = 30000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${OPENROUTER_BASE}/models`, { method: 'GET', headers: { Accept: 'application/json' }, signal: controller.signal, redirect: 'error' });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = JSON.parse(text)?.data;
    if (!Array.isArray(data)) throw new Error('unexpected catalog shape');
    return new Map(data.filter(entry => typeof entry?.id === 'string').map(entry => [entry.id, entry]));
  } catch (error) {
    throw new Error(`Could not read the OpenRouter model catalog (${error?.name === 'AbortError' ? 'timeout' : error?.message || 'error'}).`);
  } finally { clearTimeout(timer); }
}

/**
 * What the reasoning parameter will be for one model: the requested mode, the parameter object actually sent
 * (null = none) and a human-readable record of it for the reports. A mode the catalog says the model cannot
 * take is left out, and the record says why.
 */
function reasoningPlan(mode = 'none', capabilities = null) {
  if (!REASONING_MODES.includes(mode)) throw new RangeError(`Unknown reasoning mode: ${mode}`);
  if (mode === 'omit') return { mode, param: null, sent: 'omitted (not requested)' };
  if (capabilities?.reasoning === false) return { mode, param: null, sent: 'omitted (catalog: no reasoning control)' };
  const param = { effort: mode };
  return { mode, param, sent: JSON.stringify(param) };
}

/**
 * Same body for every model, apart from parameters a model's catalog entry says it cannot take (and the
 * per-model reasoning mode). `capabilities` null = unknown, so everything is sent (and require_parameters makes
 * unsupported routes fail loudly). Returns the body, which parameters were sent, and the reasoning record.
 */
function buildRequest({ model, prompt, image, capabilities = null, options = {} }) {
  const sendTemperature = capabilities?.temperature !== false && options.temperature !== 'omit';
  const reasoning = reasoningPlan(options.reasoningMode ?? 'none', capabilities);
  const sendReasoning = Boolean(reasoning.param);
  const body = {
    model,
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: [
        { type: 'text', text: prompt.userText },
        { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.bytes.toString('base64')}` } },
      ] },
    ],
    max_tokens: MAX_OUTPUT_TOKENS,
    provider: { require_parameters: true, allow_fallbacks: false },
  };
  if (sendTemperature) body.temperature = 0;
  if (sendReasoning) body.reasoning = reasoning.param;
  if (options.provider) body.provider.only = [options.provider];
  if (options.sort && options.sort !== 'default') body.provider.sort = options.sort;
  if (prompt.responseSchema) {
    body.response_format = { type: 'json_schema', json_schema: { name: prompt.schemaName, strict: true, schema: prompt.responseSchema } };
  }
  return { body, sent: { temperature: sendTemperature, reasoning: sendReasoning }, reasoningSent: reasoning.sent };
}

function classifyHttpError(status, message) {
  if (status === 401 || status === 403) return 'AUTH_ERROR';
  if (status === 402) return 'PAYMENT_REQUIRED';
  if (status === 429) return 'RATE_LIMITED';
  if ((status === 400 || status === 404 || status === 422)
    && /support|parameter|endpoint|response_format|structured|schema|reasoning|effort|temperature|max_tokens|unrecognized/i.test(message)) return 'PARAMETER_REJECTED';
  return `HTTP_${status}`;
}

// ---- provider error details ------------------------------------------------------------------------------------------

const MAX_DETAIL_CHARS = 400;
const NAMED_PARAMETERS = [
  ['reasoning.effort', /reasoning[._ ]effort|\beffort\b/i], ['reasoning', /\breasoning\b/i], ['temperature', /\btemperature\b/i],
  ['max_tokens', /max_(?:completion_)?tokens/i], ['response_format', /response_format|structured[_ ]outputs?|json_schema/i], ['top_p', /\btop_p\b/i],
];

/** API error text only: no key, no long encoded blobs, one line, bounded. */
function cleanDetail(text, secrets = []) {
  return redact(String(text ?? ''), secrets).replace(/[A-Za-z0-9+/]{60,}={0,2}/g, '[...]').replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL_CHARS);
}

/**
 * OpenRouter often wraps the provider's own error: { message: "Provider returned error", metadata: { raw, provider_name } }.
 * The useful text (and the parameter name) is inside metadata.raw, so read that first.
 */
function parseProviderError(apiError, status, secrets = []) {
  const outer = apiError && typeof apiError === 'object' ? apiError : {};
  const raw = outer.metadata?.raw;
  let inner = null, rawText = null;
  if (typeof raw === 'string' && raw.length <= 12000) {
    try {
      const parsed = JSON.parse(raw);
      inner = parsed?.error && typeof parsed.error === 'object' ? parsed.error : (parsed && typeof parsed === 'object' ? parsed : null);
    } catch { rawText = raw; }
  } else if (raw && typeof raw === 'object') {
    inner = raw.error && typeof raw.error === 'object' ? raw.error : raw;
  }
  const text = [inner?.message, rawText, outer.message].find(value => typeof value === 'string' && value.trim()) || '';
  const named = [inner?.param, outer.param, outer.metadata?.param].find(value => typeof value === 'string' && value.trim());
  const inferred = [400, 404, 422].includes(status) ? NAMED_PARAMETERS.find(([, pattern]) => pattern.test(text))?.[0] : null;
  return {
    message: cleanDetail(text, secrets),
    rejectedParam: named ? cleanDetail(named, secrets).slice(0, 80) : (inferred ?? null),
    providerName: typeof outer.metadata?.provider_name === 'string' ? cleanDetail(outer.metadata.provider_name, secrets).slice(0, 80) : null,
  };
}

const finiteOrNull = value => (Number.isFinite(value) ? value : null);

function readUsage(usage) {
  return {
    promptTokens: finiteOrNull(usage?.prompt_tokens), completionTokens: finiteOrNull(usage?.completion_tokens),
    totalTokens: finiteOrNull(usage?.total_tokens),
    costUsd: Number.isFinite(usage?.cost) && usage.cost >= 0 ? usage.cost : null,
    reasoningTokens: finiteOrNull(usage?.completion_tokens_details?.reasoning_tokens),
  };
}

/** One request. Never throws: failures come back as { ok: false, errorCode, errorDetail }. */
async function callOpenRouter({ body, apiKey, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS, now = () => performance.now(), secrets = [] }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = now();
  const failure = (errorCode, errorDetail, extra = {}) =>
    ({ ok: false, errorCode, errorDetail: cleanDetail(errorDetail, [apiKey, ...secrets]), latencyMs: Math.round(now() - started), ...extra });
  try {
    const response = await fetchImpl(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'X-Title': 'RoznaComarker OCR evaluation' },
      body: JSON.stringify(body), signal: controller.signal, redirect: 'error',
    });
    const text = await response.text();
    const latencyMs = Math.round(now() - started);
    let payload;
    try { payload = JSON.parse(text); } catch {
      return failure(response.ok ? 'BAD_RESPONSE' : classifyHttpError(response.status, ''), 'The response was not JSON.', { httpStatus: response.status });
    }
    const apiError = payload?.error && typeof payload.error === 'object' ? payload.error : null;
    const usage = readUsage(payload?.usage);
    const provider = typeof payload?.provider === 'string' && payload.provider.trim() ? payload.provider.trim().slice(0, 80) : null;
    if (!response.ok || apiError) {
      const status = response.ok ? Number(apiError?.code) || 500 : response.status;
      const details = parseProviderError(apiError, status, [apiKey, ...secrets]);
      return { ...failure(classifyHttpError(status, details.message), details.message || `HTTP ${status}`,
        { httpStatus: status, rejectedParam: details.rejectedParam, providerName: details.providerName }), usage, provider, latencyMs };
    }
    const choice = payload?.choices?.[0];
    const rawContent = choice?.message?.content;
    const content = typeof rawContent === 'string' ? rawContent
      : Array.isArray(rawContent) ? rawContent.map(part => (typeof part?.text === 'string' ? part.text : '')).join('') : '';
    const reasoningText = (typeof choice?.message?.reasoning === 'string' && choice.message.reasoning.trim().length > 0)
      || (Array.isArray(choice?.message?.reasoning_details) && choice.message.reasoning_details.length > 0);
    const base = {
      usage, provider, latencyMs, httpStatus: response.status, reasoningText,
      returnedModel: typeof payload?.model === 'string' ? payload.model.slice(0, 120) : null,
      finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
    };
    if (!content.trim()) return { ...base, ok: false, errorCode: 'EMPTY_RESPONSE', errorDetail: 'The model returned no text.' };
    return { ...base, ok: true, content };
  } catch (error) {
    if (error?.name === 'AbortError') return failure('TIMEOUT', `No response within ${Math.round(timeoutMs / 1000)} s.`);
    return failure('NETWORK_ERROR', error?.message || 'Network error.');
  } finally { clearTimeout(timer); }
}

function estimateCost(usage, pricing) {
  if (!pricing || !Number.isFinite(pricing.inputPerMillion) || !Number.isFinite(pricing.outputPerMillion)) return null;
  if (!Number.isFinite(usage?.promptTokens) || !Number.isFinite(usage?.completionTokens)) return null;
  return (usage.promptTokens * pricing.inputPerMillion + usage.completionTokens * pricing.outputPerMillion) / 1e6;
}

module.exports = { OPENROUTER_BASE, MAX_OUTPUT_TOKENS, DEFAULT_TIMEOUT_MS, SORT_VALUES, REASONING_MODES, TEMPERATURE_MODES, redact, createLogger, capabilitiesFromCatalog,
  fetchCatalog, reasoningPlan, buildRequest, classifyHttpError, cleanDetail, parseProviderError, callOpenRouter, estimateCost };
