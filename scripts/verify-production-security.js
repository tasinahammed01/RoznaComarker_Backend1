'use strict';

const net = require('net');

const DEFAULTS = Object.freeze({
  frontend: 'https://comarkers.roznahub.com',
  api: 'https://comarkerback.roznahub.com',
  trustedOrigin: 'https://comarkers.roznahub.com',
  untrustedOrigin: 'https://evil.example'
});

function usage() {
  console.log(`Non-destructive RoznaComarker production edge verification

Usage:
  node scripts/verify-production-security.js --dry-run
  node scripts/verify-production-security.js --live [options]

Options:
  --frontend <https-url>       Frontend origin (default: ${DEFAULTS.frontend})
  --api <https-url>            API origin (default: ${DEFAULTS.api})
  --server-ip <ip-or-host>     Also verify that TCP port 5000 is unreachable externally
  --backend-port <port>        Port checked with --server-ip (default: 5000)
  --timeout-ms <milliseconds>  Per-check timeout (default: 10000)

Run --server-ip only from an external trusted machine, never from the VPS itself.`);
}

function parseArgs(argv) {
  const result = { ...DEFAULTS, port: 5000, timeoutMs: 10000, live: false, dryRun: false };
  const valueOptions = new Map([
    ['--frontend', 'frontend'], ['--api', 'api'], ['--server-ip', 'serverIp'],
    ['--backend-port', 'port'], ['--timeout-ms', 'timeoutMs']
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--live') { result.live = true; continue; }
    if (arg === '--dry-run') { result.dryRun = true; continue; }
    const property = valueOptions.get(arg);
    if (!property || !argv[index + 1]) throw new Error(`Unknown or incomplete option: ${arg}`);
    result[property] = argv[index + 1]; index += 1;
  }
  result.port = Number(result.port); result.timeoutMs = Number(result.timeoutMs);
  if (!Number.isInteger(result.port) || result.port < 1 || result.port > 65535) throw new Error('Invalid backend port');
  if (!Number.isInteger(result.timeoutMs) || result.timeoutMs < 1000 || result.timeoutMs > 60000) throw new Error('Invalid timeout');
  for (const property of ['frontend', 'api']) {
    const url = new URL(result[property]);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/') {
      throw new Error(`${property} must be an HTTPS origin without credentials or a path`);
    }
    result[property] = url.origin;
  }
  // Exactly one execution mode is required: dry-run is always offline, while
  // live mode is the only path that performs network checks.
  const config = result;
  if (config.live === config.dryRun) throw new Error('Choose exactly one of --live or --dry-run');
  return result;
}

async function request(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { redirect: 'manual', ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function tcpReachable(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (reachable) => { socket.destroy(); resolve(reachable); };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  if (config.help) { usage(); return; }
  if (config.dryRun) {
    console.log('PASS configuration parsed; no network requests were made');
    return;
  }

  const checks = [];
  const check = async (name, action) => {
    try { await action(); checks.push({ name, passed: true }); console.log(`PASS ${name}`); }
    catch (error) { checks.push({ name, passed: false }); console.error(`FAIL ${name}: ${error.message}`); }
  };
  const requireValue = (condition, message) => { if (!condition) throw new Error(message); };

  await check('frontend HTTPS and security headers', async () => {
    const response = await request(config.frontend, { method: 'HEAD' }, config.timeoutMs);
    requireValue(response.ok, `HTTP ${response.status}`);
    for (const name of ['strict-transport-security', 'content-security-policy-report-only', 'x-content-type-options', 'referrer-policy']) {
      requireValue(response.headers.has(name), `missing ${name}`);
    }
    requireValue(!response.headers.has('content-security-policy'), 'enforced CSP present before telemetry approval');
  });

  for (const origin of [config.frontend, config.api]) {
    await check(`HTTP redirects to HTTPS for ${new URL(origin).hostname}`, async () => {
      const url = new URL(origin); url.protocol = 'http:';
      const response = await request(url, { method: 'HEAD' }, config.timeoutMs);
      requireValue([301, 302, 307, 308].includes(response.status), `HTTP ${response.status}`);
      requireValue(String(response.headers.get('location') || '').startsWith('https://'), 'redirect is not HTTPS');
    });
  }

  await check('health endpoint is available and contains no obvious secrets', async () => {
    const response = await request(`${config.api}/api/health`, {}, config.timeoutMs);
    requireValue(response.ok, `HTTP ${response.status}`);
    const text = await response.text();
    const value = JSON.parse(text);
    requireValue(value.success === true && value.status === 'OK', 'unexpected health response');
    requireValue(!/(mongodb(?:\+srv)?:\/\/|sk_(?:test|live)_|whsec_|private[_-]?key|authorization)/iu.test(text), 'sensitive marker in health response');
  });

  await check('trusted CORS origin is allowed', async () => {
    const response = await request(`${config.api}/api/health`, { headers: { Origin: config.trustedOrigin } }, config.timeoutMs);
    requireValue(response.headers.get('access-control-allow-origin') === config.trustedOrigin, 'trusted origin not returned exactly');
  });
  await check('untrusted CORS origin is not allowed', async () => {
    const response = await request(`${config.api}/api/health`, { headers: { Origin: config.untrustedOrigin } }, config.timeoutMs);
    requireValue(response.headers.get('access-control-allow-origin') !== config.untrustedOrigin, 'untrusted origin was allowed');
  });

  if (config.serverIp) {
    await check(`backend port ${config.port} is not externally reachable`, async () => {
      requireValue(!(await tcpReachable(config.serverIp, config.port, config.timeoutMs)), 'port accepted an external TCP connection');
    });
  }

  if (checks.some((item) => !item.passed)) process.exitCode = 1;
}

main().catch((error) => { console.error(`ERROR ${error.message}`); usage(); process.exitCode = 1; });
