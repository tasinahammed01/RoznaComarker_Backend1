'use strict';

const DEFAULT_TIMEOUT_MS = 10_000;
const TOKEN_EXPIRY_SKEW_MS = 60_000;
const { PAYPAL_BASE_URLS, getPaypalConfig } = require('../../config/paypal');

function redact(value) {
  return String(value || '')
    .replace(/\bBearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/\bBasic\s+\S+/giu, 'Basic [redacted]')
    .replace(/\baccess_token\b\s*[:=]\s*["']?[^\s,"']+/giu, 'access_token=[redacted]')
    .replace(/\bclient_secret\b\s*[:=]\s*["']?[^\s,"']+/giu, 'client_secret=[redacted]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/gu, '[redacted]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 300);
}

class PayPalApiError extends Error {
  constructor(message, { status, issue, debugId } = {}) {
    super(redact(message) || 'PayPal API request failed');
    this.name = 'PayPalApiError';
    this.code = 'PAYPAL_API_ERROR';
    this.statusCode = 502;
    this.providerStatus = Number.isInteger(status) ? status : null;
    this.providerIssue = issue ? redact(issue) : null;
    this.debugId = debugId ? redact(debugId) : null;
  }
}

async function responsePayload(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { message: text }; }
}

function normalizedError(response, payload) {
  const detail = Array.isArray(payload?.details) ? payload.details[0] : null;
  return new PayPalApiError(
    detail?.description || payload?.message || `PayPal API request failed with status ${response.status}`,
    {
      status: response.status,
      issue: detail?.issue || payload?.name,
      debugId: payload?.debug_id || response.headers?.get?.('paypal-debug-id')
    }
  );
}

class PayPalClient {
  constructor({
    environment,
    clientId,
    clientSecret,
    liveEnabled,
    environmentVariables = process.env,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    now = () => Date.now(),
    logger = console
  } = {}) {
    const configuration = getPaypalConfig({ ...environmentVariables,
      ...(environment ? { PAYPAL_ENV: environment } : {}) });
    this.environment = configuration.environment;
    this.baseUrl = PAYPAL_BASE_URLS[this.environment];
    if (!this.baseUrl) throw Object.assign(new Error('PAYPAL_ENV must be sandbox or live'), { code: 'PAYPAL_ENV_INVALID' });
    const resolvedClientId = clientId === undefined ? configuration.clientId : clientId;
    const resolvedClientSecret = clientSecret === undefined ? configuration.clientSecret : clientSecret;
    if (!String(resolvedClientId || '').trim() || !String(resolvedClientSecret || '').trim()) {
      const missing = !String(resolvedClientId || '').trim() ? configuration.variables.clientId : configuration.variables.clientSecret;
      throw Object.assign(new Error(`PayPal credentials are not configured: missing ${missing}`), { code: 'PAYPAL_CREDENTIALS_NOT_CONFIGURED' });
    }
    if (typeof fetchImpl !== 'function') throw new Error('A Fetch implementation is required');
    this.clientId = String(resolvedClientId).trim();
    this.clientSecret = String(resolvedClientSecret).trim();
    this.liveEnabled = this.environment !== 'live' || (liveEnabled === undefined ? configuration.liveEnabled : liveEnabled === true);
    this.fetch = fetchImpl;
    this.timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
    this.now = now;
    this.logger = logger;
    this.token = null;
  }

  assertMutationAllowed() {
    if (this.environment === 'live' && !this.liveEnabled) {
      throw Object.assign(new Error('Live PayPal operations are disabled until PAYPAL_LIVE_ENABLED=true'),
        { code: 'PAYPAL_LIVE_NOT_ENABLED', statusCode: 503 });
    }
  }

  async fetchWithTimeout(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new PayPalApiError('PayPal API request timed out');
      }
      throw new PayPalApiError(error?.message || 'PayPal API request failed');
    } finally {
      clearTimeout(timer);
    }
  }

  async getAccessToken() {
    if (this.token && this.token.expiresAt - TOKEN_EXPIRY_SKEW_MS > this.now()) return this.token.value;
    const authorization = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const response = await this.fetchWithTimeout(`${this.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${authorization}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: 'grant_type=client_credentials'
    });
    const payload = await responsePayload(response);
    if (!response.ok || !payload?.access_token) throw normalizedError(response, payload);
    const expiresInMs = Math.max(Number(payload.expires_in || 0), 1) * 1000;
    this.token = { value: payload.access_token, expiresAt: this.now() + expiresInMs };
    this.logger.info?.(`[PAYPAL] OAuth token acquired environment=${this.environment}`);
    return this.token.value;
  }

  async request(path, { method = 'GET', body, headers = {} } = {}) {
    const token = await this.getAccessToken();
    const response = await this.fetchWithTimeout(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const payload = await responsePayload(response);
    if (!response.ok) throw normalizedError(response, payload);
    return payload;
  }

  listProducts({ page = 1, pageSize = 20 } = {}) {
    return this.request(`/v1/catalogs/products?page_size=${pageSize}&page=${page}&total_required=true`);
  }
  getProduct(productId) { return this.request(`/v1/catalogs/products/${encodeURIComponent(productId)}`); }
  createProduct(payload, requestId) {
    this.assertMutationAllowed();
    return this.request('/v1/catalogs/products', { method: 'POST', body: payload,
      headers: requestId ? { 'PayPal-Request-Id': requestId } : {} });
  }
  listPlans(productId, { page = 1, pageSize = 20 } = {}) {
    return this.request(`/v1/billing/plans?product_id=${encodeURIComponent(productId)}&page_size=${pageSize}&page=${page}&total_required=true`);
  }
  getPlan(planId) { return this.request(`/v1/billing/plans/${encodeURIComponent(planId)}`); }
  createPlan(payload, requestId) {
    this.assertMutationAllowed();
    return this.request('/v1/billing/plans', { method: 'POST', body: payload,
      headers: requestId ? { 'PayPal-Request-Id': requestId } : {} });
  }
  createSubscription(payload, requestId) {
    this.assertMutationAllowed();
    return this.request('/v1/billing/subscriptions', { method: 'POST', body: payload,
      headers: requestId ? { 'PayPal-Request-Id': requestId } : {} });
  }
  getSubscription(subscriptionId) {
    return this.request(`/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`);
  }
  cancelSubscription(subscriptionId, reason, requestId) {
    this.assertMutationAllowed();
    return this.request(`/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
      method: 'POST', body: { reason }, headers: requestId ? { 'PayPal-Request-Id': requestId } : {}
    });
  }
  reviseSubscription(subscriptionId, payload, requestId) {
    this.assertMutationAllowed();
    return this.request(`/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}/revise`, {
      method: 'POST', body: payload, headers: requestId ? { 'PayPal-Request-Id': requestId } : {}
    });
  }
  createOrder(payload, requestId) {
    this.assertMutationAllowed();
    return this.request('/v2/checkout/orders', { method: 'POST', body: payload,
      headers: { ...(requestId ? { 'PayPal-Request-Id': requestId } : {}), Prefer: 'return=representation' } });
  }
  getOrder(orderId) { return this.request(`/v2/checkout/orders/${encodeURIComponent(orderId)}`); }
  captureOrder(orderId, requestId) {
    this.assertMutationAllowed();
    return this.request(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { method: 'POST', body: {},
      headers: { ...(requestId ? { 'PayPal-Request-Id': requestId } : {}), Prefer: 'return=representation' } });
  }
  getCapture(captureId) { return this.request(`/v2/payments/captures/${encodeURIComponent(captureId)}`); }
  verifyWebhookSignature(payload) {
    return this.request('/v1/notifications/verify-webhook-signature', { method: 'POST', body: payload });
  }
  listWebhooks() { return this.request('/v1/notifications/webhooks'); }
  createWebhook(payload, requestId) {
    this.assertMutationAllowed();
    return this.request('/v1/notifications/webhooks', { method: 'POST', body: payload,
      headers: requestId ? { 'PayPal-Request-Id': requestId } : {} });
  }
}

module.exports = { PayPalClient, PayPalApiError, PAYPAL_BASE_URLS, redact, normalizedError };
