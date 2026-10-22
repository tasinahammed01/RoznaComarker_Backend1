'use strict';
const gateway = require('../aiGateway.service');
const { MODEL, VERSION, PROMPT, schema, validate, failure } = require('./contract');
let capabilityCache;
async function inspectCapabilities(fetchImpl = global.fetch, signal) {
  if (capabilityCache && capabilityCache.expires > Date.now()) return capabilityCache.value;
  const response = await fetchImpl('https://openrouter.ai/api/v1/models', {
    signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]) });
  if (!response.ok) throw failure('OCR_SOURCE_CAPABILITY_UNAVAILABLE');
  const body = await response.json();
  const model = body.data?.find(m => m.id === MODEL);
  const value = Boolean(model?.architecture?.input_modalities?.includes('image')
    && model?.supported_parameters?.includes('structured_outputs'));
  if (!value) throw failure('OCR_SOURCE_CAPABILITY_UNVERIFIED');
  capabilityCache = { value, expires: Date.now() + 3600000 };
  return value;
}
async function read({ bytes, mimeType, deadlineAt, signal, generate = gateway.generate,
  inspect = inspectCapabilities, fetchImpl = global.fetch }) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 20 * 1024 * 1024
    || !['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) throw failure('OCR_SOURCE_IMAGE_LIMIT');
  if (signal?.aborted || Date.now() >= deadlineAt) throw failure('OCR_SOURCE_CANCELLED');
  if (await inspect(fetchImpl, signal) !== true) throw failure('OCR_SOURCE_CAPABILITY_UNVERIFIED');
  if (signal?.aborted || Date.now() >= deadlineAt) throw failure('OCR_SOURCE_CANCELLED');
  // Use the existing gateway, never a second authenticated provider implementation.
  // Omit optional detail/reasoning parameters until their exact model contract is verified.
  const result = await generate({ feature: 'hybrid_source_shadow',
    messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: [
      { type: 'text', text: `Return the ${VERSION} source contract for this page.` },
      { type: 'image_url', image_url: { url: `data:${mimeType};base64,${bytes.toString('base64')}` } }
    ] }], responseFormat: 'json', responseSchema: schema, schemaName: 'source_reader_v1', validate,
    maxOutputTokens: 12000, temperature: 0, deadlineAt,
    config: { chain: [{ provider: 'openrouter', model: MODEL, fallbackIndex: 0 }],
      totalBudgetMs: 40000, attemptTimeoutMs: 20000, primaryRetries: 1, fallbackRetries: 0, retryDelayMs: 250 },
    // Cancellation combines the job/page budget with the gateway's attempt budget.
    fetchImpl: async (url, options) => {
      const response = await fetchImpl(url, { ...options,
        signal: AbortSignal.any([options.signal, ...(signal ? [signal] : [])]) });
      return { ok: response.ok, status: response.status, headers: response.headers, text: async () => {
        // A provider can echo private image/request data in a 400 response. Strip
        // error bodies before the shared gateway's diagnostic logging sees them.
        const generic = JSON.stringify({ error: { code: response.status || 500, message: 'Source reader request failed.' } });
        if (!response.ok) return generic;
        const body = await response.text();
        try { if (JSON.parse(body)?.error) return generic; } catch { return ''; }
        return body;
      } };
    } });
  return { reader: result.value, attempts: (result.attempts || []).map(a => ({
    attemptNumber: a.attemptNumber, status: a.status, durationMs: a.durationMs,
    code: a.code, model: MODEL })), durationMs: result.durationMs };
}
module.exports = { read, inspectCapabilities };
