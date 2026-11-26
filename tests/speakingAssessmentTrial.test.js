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
      expect(out).toContain('refused: --coach-check and --coach-generate need --max-cost-usd');
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

describe('--coach-generate (Speaking Coach: the cost of one task wording), alone and with --coach-check under one shared cap', () => {
  const h = require('./helpers/speakingAssessmentFixtures');
  const env = { ...h.TEST_ENV, NODE_ENV: 'development', SPEAKING_TRIAL: trial.SWITCH, OPENROUTER_API_KEY: 'sk-or-placeholder-should-never-print' };
  const PROMPTS = ['Answer the task again and check each verb you use.', 'Answer again and use the new words in your answer.'];
  const TIPS = ['Speak a little more slowly.', 'Plan where each word fits first.'];
  const wording = { tasks: [{ taskId: 't1', prompt: PROMPTS[0], tip: TIPS[0] }, { taskId: 't2', prompt: PROMPTS[1], tip: TIPS[1] }] };
  const checkReply = { assessable: true, notAssessableReason: 'none', onTask: true, level: 'Good', improved: ['You checked your verbs more carefully.'],
    stillWeak: [], nextTip: 'Say each sentence a little more slowly.' };
  const usage = { usage: { prompt_tokens: 1500, completion_tokens: 500, cost: 0.002 } };
  const capture = async (argv, fetchImpl) => {
    const lines = [];
    const log = jest.spyOn(console, 'log').mockImplementation((...args) => lines.push(args.join(' ')));
    const err = jest.spyOn(console, 'error').mockImplementation((...args) => lines.push(args.join(' ')));
    try { await trial.main(argv, env, { fetchImpl }); } finally { log.mockRestore(); err.mockRestore(); }
    return lines.join('\n');
  };

  test.each([[['--coach-generate']], [['--coach-generate', '--max-cost-usd', '0']], [['--coach-generate', '--max-cost-usd', '5.01']]])(
    '%j: refused without a cap from more than 0 to 5 dollars, and nothing is called', async (argv) => {
      const fetchImpl = h.fakeOpenRouter(wording);
      const out = await capture(argv, fetchImpl);
      expect(out).toContain('refused: --coach-check and --coach-generate need --max-cost-usd');
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

  test('one call (default one transcript): the tasks worded, tokens and the reported cost; never the wording, the key or the prompt', async () => {
    const fetchImpl = h.fakeOpenRouter(wording, usage);
    const out = await capture(['--coach-generate', '--max-cost-usd', '0.1'], fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(out).toMatch(/task wording: model .*speaking-coach-tasks-v1/);
    expect(out).toMatch(/- generation \w[\w ]*: 2 tasks worded; tokens 1500 in \/ 500 out; cost \$0\.00200/);
    expect(out).toContain('average per task wording: $0.00200');
    for (const hidden of [...PROMPTS, ...TIPS, 'sk-or-placeholder', 'short speaking practice tasks', 'It have', 'by walk']) expect(out).not.toContain(hidden);
    // What the model read: the coach's real wording input (stored assessment data, never a whole answer).
    const sent = JSON.stringify(fetchImpl.bodies[0].messages);
    expect(sent).toContain('wordsNotToUse');
    expect(sent).not.toContain(require('./fixtures/audio/speakingBenchmark.cjs').TEXTS.WEAK);
  });

  test('a rejected reply and a provider error are one call each (no retry), with only the code printed', async () => {
    const bad = h.fakeOpenRouter({ tasks: [{ taskId: 't1', prompt: 'Raise your score on grammar.', tip: TIPS[0] }, wording.tasks[1]] });
    const out = await capture(['--coach-generate', '--max-cost-usd', '0.1'], bad);
    expect(bad).toHaveBeenCalledTimes(1);
    expect(out).toMatch(/FAILED AI_OUTPUT_VALIDATION_FAILED \(COACH_TEXT_FORBIDDEN_TERM\)/);
    expect(out).not.toContain('Raise your score');
    const down = h.fakeOpenRouter({ status: 500 });
    await capture(['--coach-generate', '--max-cost-usd', '0.1'], down);
    expect(down).toHaveBeenCalledTimes(1);
  });

  test('as in production: low reasoning, the larger limits, and a cut-off reply retried once with twice the limit; both calls are counted in the cap', async () => {
    // A fake provider: the first reply is cut off by its limit (finish reason length), the second one is complete.
    const bodies = [];
    const replies = [{ finish: 'length', content: '{"assessable":tr', cost: 0.003 }, { finish: 'stop', content: JSON.stringify(checkReply), cost: 0.0035 }];
    const fetchImpl = jest.fn(async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      const reply = replies.shift();
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ model: h.MODEL,
        choices: [{ message: { content: reply.content }, finish_reason: reply.finish }], usage: { prompt_tokens: 1500, completion_tokens: 900, cost: reply.cost } }) };
    });
    const out = await capture(['--coach-check', '--max-cost-usd', '0.006'], fetchImpl);
    expect(bodies.map(b => b.max_tokens)).toEqual([3000, 6000]);
    expect(bodies.every(b => b.reasoning?.effort === 'low')).toBe(true);
    expect(out).toMatch(/- \w[\w ]*: level Good, on task; tokens 1500 in \/ 900 out; cost \$0\.00650 \(retried after truncation at 3000\)/);
    expect(out).toContain('cost cap reached ($0.00650 of $0.00600); stopping');
    expect(out).not.toContain('assessable');
    const words = jest.fn(async (_url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, status: 200, headers: { get: () => null },
      text: async () => JSON.stringify({ model: h.MODEL, choices: [{ message: { content: JSON.stringify(wording) }, finish_reason: 'stop' }], usage }) }; });
    bodies.length = 0;
    await capture(['--coach-generate', '--max-cost-usd', '0.1'], words);
    expect(bodies[0]).toMatchObject({ max_tokens: 2500, reasoning: { effort: 'low' } });
  });

  test('a failure names the failing check (codes only): a key that cannot be sent, or a request that failed before any answer', async () => {
    const lines = [];
    const log = jest.spyOn(console, 'log').mockImplementation((...args) => lines.push(args.join(' ')));
    const fetchImpl = h.fakeOpenRouter(wording, usage);
    try { await trial.main(['--coach-generate', '--max-cost-usd', '0.1'], { ...env, OPENROUTER_API_KEY: 'sk-or-v1-place​holder' }, { fetchImpl }); } finally { log.mockRestore(); }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(lines.join('\n')).toMatch(/FAILED AI_PROVIDER_CREDENTIAL_INVALID \(credential non_printable_characters\)/);
    expect(lines.join('\n')).not.toContain('placeholder');
    const failing = jest.fn(async () => { throw Object.assign(new TypeError('fetch failed: hidden'), { cause: { code: 'ENOTFOUND' } }); });
    const out = await capture(['--coach-generate', '--max-cost-usd', '0.1'], failing);
    expect(out).toMatch(/FAILED AI_RESPONSE_INVALID \(stage TRANSPORT_FAILURE, TypeError, ENOTFOUND\)/);
    expect(out).not.toContain('hidden');
  });

  test('several transcripts: the wording stops once the reported cost reaches the cap', async () => {
    const fetchImpl = h.fakeOpenRouter(wording, usage);
    const out = await capture(['--coach-generate', '--max', '5', '--max-cost-usd', '0.003'], fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(out).toContain('cost cap reached ($0.00400 of $0.00300); stopping');
  });

  test('both modes in one run share one cap: the checks first, then the wording, stopping once the reported total reaches the cap', async () => {
    const both = h.fakeOpenRouter([checkReply, wording], usage);
    const out = await capture(['--coach-check', '--coach-generate', '--max-cost-usd', '0.003'], both);
    expect(both).toHaveBeenCalledTimes(2);
    expect(out).toMatch(/- \w[\w ]*: level Good, on task/);
    expect(out).toMatch(/- generation \w[\w ]*: 2 tasks worded/);
    expect(out).toContain('cost cap reached ($0.00400 of $0.00300); stopping');
    const capped = h.fakeOpenRouter([checkReply, wording], usage);
    const early = await capture(['--coach-check', '--coach-generate', '--max-cost-usd', '0.001'], capped);
    expect(capped).toHaveBeenCalledTimes(1);
    expect(early).toContain('cost cap reached ($0.00200 of $0.00100); stopping');
    expect(early).not.toMatch(/- generation/);
  });
});

test('the source never prints the environment, a key or the prompt', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  for (const line of source.split('\n').filter(l => /console\.(log|error)/.test(l))) {
    expect(line).not.toMatch(/API_KEY|env\[|process\.env|SYSTEM|messages|\.content/);
  }
});
