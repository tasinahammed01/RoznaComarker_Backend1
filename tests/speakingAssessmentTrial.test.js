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

describe('with the switch and an injected fake provider (stage 7b output)', () => {
  const h = require('./helpers/speakingAssessmentFixtures');
  const env = { ...h.TEST_ENV, NODE_ENV: 'development', SPEAKING_TRIAL: trial.SWITCH, OPENROUTER_API_KEY: 'sk-or-placeholder-should-never-print' };
  const capture = async (argv, reply) => {
    const lines = [];
    const log = jest.spyOn(console, 'log').mockImplementation((...args) => lines.push(args.join(' ')));
    const err = jest.spyOn(console, 'error').mockImplementation((...args) => lines.push(args.join(' ')));
    try { await trial.main(argv, env, { fetchImpl: h.fakeOpenRouter(reply) }); } finally { log.mockRestore(); err.mockRestore(); }
    return lines.join('\n');
  };

  test('a rejected reply prints the validation sub-code', async () => {
    const out = await capture(['--case', 'medium', '--max', '1'], h.output({ summary: 'You used 47 different linking words, which is excellent work overall.' }));
    expect(out).toMatch(/- medium: FAILED AI_OUTPUT_VALIDATION_FAILED \(SPEAKING_OUTPUT_NUMBER\)/);
  });

  test('--show-feedback prints the feedback, each criterion comment and the fluency figures sent; never the key or the prompt', async () => {
    const out = await capture(['--case', 'weak', '--show-feedback'], h.output({ level: 'Developing' }));
    expect(out).toMatch(/- weak: score 50/);
    expect(out).toContain('summary: A clear answer about your town');
    expect(out).toContain('Task and content (Developing): The answer explains the main ideas clearly');
    expect(out).toContain('strength: You stayed on the topic');
    expect(out).toContain('improvement: Try linking your ideas');
    expect(out).toMatch(/fluency sent: \d+(\.\d+)? words per minute, [\d.]+ fillers per 100 words, \d+ pauses over 1 s, \d+ repetitions/);
    expect(out).not.toContain('sk-or-placeholder');
    expect(out).not.toContain('You are the speaking assessor');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test.each(['very long', 'varied long answer'])('the recording length sent for %s is never shorter than its speech', async (name) => {
    const out = await capture(['--case', name, '--show-feedback'], h.output({ level: 'Good' }));
    const sent = [...out.matchAll(/words in ([\d.]+) s of speech; recording (\d+) s/g)];
    expect(sent.length).toBeGreaterThan(0);
    for (const [, speech, recording] of sent) {
      expect(Number(recording)).toBeGreaterThanOrEqual(Number(speech));
      expect(Number(recording)).toBeLessThanOrEqual(420);
    }
  });

  test('without --show-feedback no feedback text is printed', async () => {
    const out = await capture(['--case', 'weak'], h.output({ level: 'Developing' }));
    expect(out).not.toContain('summary:');
    expect(out).not.toContain('fluency sent');
  });
});

test('the source never prints the environment, a key or the prompt', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  for (const line of source.split('\n').filter(l => /console\.(log|error)/.test(l))) {
    expect(line).not.toMatch(/API_KEY|env\[|process\.env|SYSTEM|messages|\.content/);
  }
});
