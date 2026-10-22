'use strict';
const path = require('path');
const cp = require('child_process');
const fs = require('fs');
const { configuration, assertIsolation, home, root } = require('../scripts/local-shadow/config.cjs');
test('localhost config pins database, storage and mode without reading .env', () => {
  const env = configuration(); expect(() => assertIsolation(env)).not.toThrow();
  expect(new URL(env.MONGO_URI).hostname).toBe('127.0.0.1');
  expect(new URL(env.MONGO_URI).pathname).toBe('/rozna_shadow_local');
  expect(env.ASSESSMENT_RECOVERY_ENABLED).toBe('false');
  expect(path.resolve(root, env.UPLOAD_BASE_PATH)).toBe(path.join(home, 'uploads'));
  expect(env.OPENROUTER_API_KEY).toBeUndefined();
});
test.each(['MONGO_URI','HOST','PORT','UPLOAD_BASE_PATH','NODE_ENV','CORRECTION_PIPELINE_MODE','OCR_SOURCE_MODE','ASSESSMENT_RECOVERY_ENABLED'])('rejects changed isolation field %s', key => {
  const env = configuration(); env[key] = 'foreign'; expect(() => assertIsolation(env)).toThrow('ISOLATION_REJECTED');
});
test('launcher sanitizes inherited credentials and suppresses dotenv fallback', () => {
  const code = `require('./scripts/local-shadow/config.cjs').applyEnvironment();require('dotenv').config();console.log(JSON.stringify({key:process.env.OPENROUTER_API_KEY,db:process.env.MONGO_URI,mode:process.env.NODE_ENV}))`;
  const result = cp.spawnSync(process.execPath, ['-e', code], { cwd: root, encoding: 'utf8', env: { ...process.env, OPENROUTER_API_KEY: 'must-not-inherit', MONGO_URI: 'mongodb://remote.invalid/production' } });
  expect(result.status).toBe(0); const env = JSON.parse(result.stdout); expect(env.key).toBeUndefined();
  expect(env.db).toContain('127.0.0.1:27028/rozna_shadow_local'); expect(env.mode).toBe('staging');
});
test('local transport guard rejects HTTPS, fetch and raw external sockets before dispatch', () => {
  const result = cp.spawnSync(process.execPath, ['-e', `const g=require('./scripts/local-shadow/network.cjs');g.install();for(const f of [()=>require('https').get('https://example.invalid'),()=>fetch('https://example.invalid'),()=>require('net').connect({host:'203.0.113.1',port:443})]){try{f();process.exit(2)}catch(e){if(e.code!=='LOCAL_SHADOW_EXTERNAL_NETWORK_DENIED')throw e}}console.log(g.counts.blocked)`], { cwd: root, encoding: 'utf8' });
  expect(result.status).toBe(0); expect(result.stdout.trim()).toBe('3');
});
test('production frontend settings remain separate from local replacement', () => {
  const workspace = JSON.parse(fs.readFileSync(path.resolve(root, '../RoznaComarker/angular.json')));
  const build = workspace.projects['rozna-comarker-fe'].architect.build;
  expect(build.defaultConfiguration).toBe('production');
  expect(build.configurations.production.fileReplacements[0].with).toBe('src/environments/environment.prod.ts');
  expect(build.configurations['local-shadow'].fileReplacements[0].with).toBe('src/environments/environment.local-shadow.ts');
});
