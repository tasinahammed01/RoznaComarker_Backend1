'use strict';
const net = require('net');
const tls = require('tls');
const { AsyncLocalStorage } = require('async_hooks');
const context = new AsyncLocalStorage();
const permitted = host => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(host).toLowerCase());
const HOSTS = Object.freeze({ google: ['vision.googleapis.com', 'oauth2.googleapis.com'], shadow: ['openrouter.ai'] });
const counts = { blocked: 0, providerRequests: 0, verifierRequests: 0 };
let policy = { realOne: false };
function reject() { counts.blocked++; throw Object.assign(Error('LOCAL_SHADOW_EXTERNAL_NETWORK_DENIED'), { code: 'LOCAL_SHADOW_EXTERNAL_NETWORK_DENIED' }); }
function allowed(host, port = 443, current = context.getStore()) {
  return permitted(host) || Boolean((policy.realOne||policy.astraVerified) && current && Number(port) === 443 && HOSTS[current.provider]?.includes(host));
}
function scope(provider, phase, run) { return context.run({ provider, phase }, run); }
function request(url, method = 'GET') {
  if (permitted(url.hostname)) return;
  const current = context.getStore();
  if (url.protocol !== 'https:' || !allowed(url.hostname, url.port || 443) || url.username || url.password || method !== 'POST') return reject();
  const phase = current.phase;
  if(policy.astraVerified) {
    if((url.hostname==='openrouter.ai'&&url.pathname==='/api/v1/chat/completions'&&current.provider==='shadow')
      ||(url.hostname==='vision.googleapis.com'&&url.pathname==='/v1/images:annotate'&&current.provider==='google')
      ||(url.hostname==='oauth2.googleapis.com'&&url.pathname==='/token'&&current.provider==='google')){counts.providerRequests++;return;}
    return reject();
  }
  if (url.hostname === 'openrouter.ai' && url.pathname === '/api/v1/chat/completions' && current.provider === 'shadow') {
    policy.ledger.reserve('shadow-http', policy.imageHash); counts.providerRequests++;
  } else if (url.hostname === 'vision.googleapis.com' && url.pathname === '/v1/images:annotate' && ['orientation', 'document'].includes(phase)) {
    policy.ledger.reserve('google-' + phase + '-http', policy.imageHash); counts.providerRequests++;
  } else if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token' && current.provider === 'google') {
    policy.ledger.auth(policy.imageHash); counts.providerRequests++;
  } else return reject();
}
function install(options = {}) {
  policy = { realOne: options.realOne === true, astraVerified:options.astraVerified===true, ledger: options.ledger, imageHash: options.imageHash };
  if (policy.realOne && (!policy.ledger || !/^[a-f0-9]{64}$/.test(policy.imageHash))) throw Error('EXPLICIT_REAL_ONE_BUDGET_REQUIRED');
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    let a = args[0]; if (Array.isArray(a)) a = a[0];
    const host = a && typeof a === 'object' ? a.host || 'localhost' : typeof args[1] === 'string' ? args[1] : 'localhost';
    const port = a && typeof a === 'object' ? a.port : a;
    const current = context.getStore();
    if ((a && typeof a === 'object' && a.path) || typeof a === 'string') return reject();
    if (!permitted(host) && !(current?.tlsHost && allowed(current.tlsHost, port))) return reject();
    return original.apply(this, args);
  };
  const originalTls = tls.connect;
  tls.connect = function (...args) {
    const a = args[0]; const current = context.getStore();
    if (!a || typeof a !== 'object') return reject();
    const host = a.servername || a.host;
    if (!permitted(host) && (!allowed(host, a.port || 443) || a.rejectUnauthorized === false || (a.host && a.host !== host))) return reject();
    return context.run({ ...current, tlsHost: host }, () => originalTls.apply(this, args));
  };
  for (const name of ['http', 'https']) {
    const mod = require(name);
    for (const method of ['get', 'request']) {
      const fn = mod[method];
      mod[method] = function (...args) {
        const a = args[0]; let url, opts;
        try {
          if (typeof a === 'string' || a instanceof URL) { url = new URL(a); opts = args[1] || {}; }
          else { opts = a; url = new URL(`${opts.protocol || name + ':'}//${opts.hostname || opts.host || 'localhost'}${opts.port ? ':' + opts.port : ''}${opts.path || '/'}`); }
        } catch { return reject(); }
        request(url, String(opts.method || 'GET').toUpperCase());
        return fn.apply(this, args);
      };
    }
  }
  const fetch = global.fetch;
  global.fetch = (input, opts = {}) => {
    const url = new URL(input.url || input); request(url, String(opts.method || input.method || 'GET').toUpperCase());
    return fetch(input, { ...opts, ...(!permitted(url.hostname) ? { redirect: 'error' } : {}) });
  };
}
module.exports = { permitted, allowed, scope, install, counts, HOSTS, disable: () => { policy.realOne = false;policy.astraVerified=false; } };
