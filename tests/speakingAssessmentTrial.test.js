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

describe('--coach-check (Speaking Coach: the cost of one practice check), with an injected fake provider', () => {
  const h = require('./helpers/speakingAssessmentFixtures');
  const env = { ...h.TEST_ENV, NODE_ENV: 'development', SPEAKING_TRIAL: trial.SWITCH, OPENROUTER_API_KEY: 'sk-or-placeholder-should-never-print' };
  const reply = { assessable: true, notAssessableReason: 'none', onTask: true, level: 'Good', improved: ['You checked your verbs more carefully.'],
    stillWeak: ['Link your ideas with because.'], nextTip: 'Say each sentence a little more slowly.' };
  const capture = async (argv, fetchImpl) => {
    const lines = [];
    const log = jest.spyOn(console, 'log').mockImplementation((...args) => lines.push(args.join(' ')));
    const err = jest.spyOn(console, 'error').mockImplementation((...args) => lines.push(args.join(' ')));
    try { await trial.main(argv, env, { fetchImpl }); } finally { log.mockRestore(); err.mockRestore(); }
    return lines.join('\n');
  };

  test.each([[['--coach-check']], [['--coach-check', '--max-cost-usd', '0']], [['--coach-check', '--max-cost-usd', '6']], [['--coach-check', '--max-cost-usd', 'x']]])(
    '%j: refused without a cap from more than 0 to 5 dollars, and nothing is called', async (argv) => {
      const fetchImpl = h.fakeOpenRouter(reply);
      const out = await capture(argv, fetchImpl);
      expect(out).toContain('refused: --coach-check needs --max-cost-usd');
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

  test('one call per synthetic transcript (default one), tokens and the reported cost; stops once the reported cost reaches the cap', async () => {
    const fetchImpl = h.fakeOpenRouter(reply, { usage: { prompt_tokens: 1400, completion_tokens: 300, cost: 0.002 } });
    const one = await capture(['--coach-check', '--max-cost-usd', '0.5'], fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(one).toMatch(/practice check: .*speaking-coach-check-v1/);
    expect(one).toMatch(/- \w[\w ]*: level Good, on task; tokens 1400 in \/ 300 out; cost \$0\.00200/);
    expect(one).toContain('average per practice check: $0.00200');
    const capped = h.fakeOpenRouter(reply, { usage: { prompt_tokens: 1400, completion_tokens: 300, cost: 0.002 } });
    const out = await capture(['--coach-check', '--max', '5', '--max-cost-usd', '0.003'], capped);
    expect(capped).toHaveBeenCalledTimes(2);
    expect(out).toContain('cost cap reached ($0.00400 of $0.00300); stopping');
    expect(out).not.toContain('sk-or-placeholder');
    expect(out).not.toContain('kind speaking coach');
  });

  test('a rejected reply is one call (no retry) and prints the check that rejected it', async () => {
    const fetchImpl = h.fakeOpenRouter({ ...reply, improved: ['Your score went up.'] });
    const out = await capture(['--coach-check', '--max-cost-usd', '0.5'], fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(out).toMatch(/FAILED AI_OUTPUT_VALIDATION_FAILED \(COACH_TEXT_FORBIDDEN_TERM\)/);
  });

  test('a provider error is one call too: the trial never retries (no hidden extra cost)', async () => {
    const fetchImpl = h.fakeOpenRouter({ status: 500 });
    const out = await capture(['--coach-check', '--max-cost-usd', '0.5'], fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(out).toMatch(/FAILED /);
  });
});

test('the source never prints the environment, a key or the prompt', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  for (const line of source.split('\n').filter(l => /console\.(log|error)/.test(l))) {
    expect(line).not.toMatch(/API_KEY|env\[|process\.env|SYSTEM|messages|\.content/);
  }
});
