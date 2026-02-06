const { fetchCompat, buildTimeoutSignal } = require('./httpClient.service');

const logger = require('../utils/logger');

function normalizeBaseUrl(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/\/+$/, '');
}

function toLanguageToolCheckUrl(rawBase) {
  const base = normalizeBaseUrl(rawBase);
  if (!base) return '';

  // Accept either:
  // - https://api.languagetool.org
  // - https://api.languagetool.org/v2/check
  // - http://localhost:8081/v2/check
  // - (misconfigured) https://api.languagetool.org/check
  // and normalize to a valid /v2/check URL.
  if (base.endsWith('/v2/check')) return base;

  if (base.endsWith('/check')) {
    // Replace legacy or misconfigured /check with /v2/check
    return `${base.slice(0, -'/check'.length)}/v2/check`;
  }

  return `${base}/v2/check`;
}

function getLanguageToolBaseUrl() {
  const base = normalizeBaseUrl(process.env.LANGUAGETOOL_URL);
  if (!base) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('LANGUAGETOOL_URL is not configured');
    }

    const fallback = 'https://api.languagetool.org';
    logger.warn({
      message: 'LANGUAGETOOL_URL is not configured. Falling back to public LanguageTool API for development.',
      fallback
    });
    return fallback;
  }
  return base;
}

async function checkTextWithLanguageTool({ text, language }) {
  const safeText = typeof text === 'string' ? text : '';
  const lang = typeof language === 'string' && language.trim()
    ? language.trim()
    : (process.env.LANGUAGETOOL_DEFAULT_LANGUAGE || 'en-US');

  const timeoutMs = Number(process.env.LANGUAGETOOL_TIMEOUT_MS) || 15000;
  const { signal, cancel } = buildTimeoutSignal(timeoutMs);

  try {
    const baseUrl = getLanguageToolBaseUrl();
    const url = toLanguageToolCheckUrl(baseUrl);
    if (!url) {
      throw new Error('LANGUAGETOOL_URL is not configured');
    }

    const body = new URLSearchParams();
    body.set('text', safeText);
    body.set('language', lang);

    const resp = await fetchCompat(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body,
      signal
    });

    if (!resp.ok) {
      const msg = await resp.text().catch(() => '');
      const err = new Error(msg || `LanguageTool request failed (${resp.status})`);
      err.statusCode = 502;
      throw err;
    }

    const json = await resp.json();
    return json;
  } catch (err) {
    logger.error({
      message: 'LanguageTool error',
      error: err && err.message ? err.message : err
    });
    throw err;
  } finally {
    cancel();
  }
}

module.exports = {
  checkTextWithLanguageTool
};
