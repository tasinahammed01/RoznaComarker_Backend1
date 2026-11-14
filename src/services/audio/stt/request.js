'use strict';
// One provider HTTP call with a hard deadline that also covers reading the body, a caller cancel, and the error mapping. It never logs or
// returns the provider's own error text.
const { SttError, fromHttpStatus } = require('./errors');

const TIMEOUT = Symbol('audio-stt-timeout');

async function requestJson({ provider, url, init, fetchImpl, timeoutMs, signal }) {
  const client = fetchImpl || globalThis.fetch;
  if (typeof client !== 'function') throw new SttError('AUDIO_STT_NETWORK', { provider });
  if (signal?.aborted) throw new SttError('AUDIO_STT_CANCELLED', { provider });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(TIMEOUT), timeoutMs);
  const onCancel = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', onCancel, { once: true });
  const failure = (error) => {
    if (error instanceof SttError) return error;
    if (signal?.aborted) return new SttError('AUDIO_STT_CANCELLED', { provider });
    if (controller.signal.aborted && controller.signal.reason === TIMEOUT) return new SttError('AUDIO_STT_TIMEOUT', { provider });
    return new SttError('AUDIO_STT_NETWORK', { provider });
  };
  try {
    let response;
    try { response = await client(url, { ...init, signal: controller.signal }); } catch (error) { throw failure(error); }
    if (!response || !response.ok) throw fromHttpStatus(Number(response?.status) || 0, provider);
    let body;
    try { body = await response.text(); } catch (error) { throw failure(error); }
    let json;
    try { json = JSON.parse(body); } catch { throw new SttError('AUDIO_STT_BAD_RESPONSE', { provider }); }
    if (!json || typeof json !== 'object') throw new SttError('AUDIO_STT_BAD_RESPONSE', { provider });
    return { json, headers: response.headers };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCancel);
  }
}

const header = (headers, name) => { try { return headers?.get?.(name) || null; } catch { return null; } };

module.exports = { requestJson, header };
