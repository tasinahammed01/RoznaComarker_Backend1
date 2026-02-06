async function fetchCompat(url, options) {
  if (typeof fetch === 'function') {
    return fetch(url, options);
  }

  // Lazy-load to avoid hard dependency if running on Node 18+.
  const undici = require('undici');
  return undici.fetch(url, options);
}

function buildTimeoutSignal(timeoutMs) {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return { signal: undefined, cancel: () => {} };

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(id)
  };
}

module.exports = {
  fetchCompat,
  buildTimeoutSignal
};
