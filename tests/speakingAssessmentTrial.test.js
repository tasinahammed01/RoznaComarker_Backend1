'use strict';
// scripts/speakingAssessmentTrial.js is opt-in only: it never runs in tests or in the app, never calls out without the explicit switch, and
// never prints a key. (It is never run against the real model here.)
process.env.NODE_ENV = 'test';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const realNetwork = jest.fn(() => { throw new Error('REAL_NETWORK_CALL_BLOCKED'); });
const originalFetch = globalThis.fetch;
beforeAll(() => { globalThis.fetch = jest.fn(async () => realNetwork()); });
afterAll(() => { globalThis.fetch = originalFetch; });
afterEach(() => { expect(realNetwork).not.toHaveBeenCalled(); process.exitCode = 0; });

const SCRIPT = path.join(__dirname, '..', 'scripts', 'speakingAssessmentTrial.js');
const trial = require('../scripts/speakingAssessmentTrial');

test('requiring the script runs nothing', () => {
  expect(typeof trial.main).toBe('function');
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

test.each([
  [{}, 'without the switch'],
  [{ SPEAKING_TRIAL: 'yes' }, 'with a different value'],
  [{ SPEAKING_TRIAL: trial.SWITCH, NODE_ENV: 'test' }, 'in tests'],
  [{ SPEAKING_TRIAL: trial.SWITCH, NODE_ENV: 'production' }, 'in production']
])('main refuses %p (%s) and calls nothing', async (env) => {
  const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
  await trial.main([], env);
  expect(process.exitCode).toBe(1);
  expect(errors.mock.calls.join(' ')).toContain('refused');
  expect(globalThis.fetch).not.toHaveBeenCalled();
  errors.mockRestore();
});

test('run directly without the switch: exits 1, prints no key', () => {
  const run = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', timeout: 60000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, OPENROUTER_API_KEY: 'sk-or-placeholder-should-never-print' } });
  expect(run.status).toBe(1);
  expect(run.stderr).toContain('refused');
  expect(run.stdout + run.stderr).not.toContain('sk-or-placeholder-should-never-print');
});

test('the source never prints the environment, a key or the prompt', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  for (const line of source.split('\n').filter(l => /console\.(log|error)/.test(l))) {
    expect(line).not.toMatch(/API_KEY|env\[|process\.env|SYSTEM|messages|\.content/);
  }
});
