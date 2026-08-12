'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('Phase 5 production infrastructure contracts', () => {
  test('PM2 remains a single non-clustered process bound to loopback', () => {
    const ecosystem = require('../ecosystem.config');
    const app = ecosystem.apps[0];
    expect(app.exec_mode).toBe('fork');
    expect(app.instances).toBe(1);
    expect(app.env).toEqual(expect.objectContaining({
      NODE_ENV: 'production', HOST: '127.0.0.1', PORT: 5000
    }));
    expect(JSON.stringify(app)).not.toMatch(/(?:secret|password|private.?key|mongodb\+srv)/i);
  });

  test('Nginx template preserves edge, upload, SSE, and trust-proxy assumptions', () => {
    const nginx = read('deploy/nginx/rozna-comarker.conf.example');
    expect(nginx).toContain('proxy_pass http://127.0.0.1:5000');
    expect(nginx).toContain('client_max_body_size 52m');
    expect(nginx).toMatch(/location = \/api\/notifications\/stream[\s\S]*proxy_buffering off;/);
    expect(nginx).toMatch(/location = \/api\/notifications\/stream[\s\S]*proxy_cache off;/);
    expect(nginx).toContain('proxy_set_header X-Forwarded-For $remote_addr');
    expect(nginx).toContain('Content-Security-Policy-Report-Only');
    expect(nginx).not.toMatch(/add_header Content-Security-Policy\s+"/);
  });

  test('external verifier is opt-in and package verification stays offline', () => {
    const verifier = read('scripts/verify-production-security.js');
    const packageJson = require('../package.json');
    expect(verifier).toContain("config.live === config.dryRun");
    expect(packageJson.scripts['verify:production-security']).toContain('--dry-run');
  });
});
