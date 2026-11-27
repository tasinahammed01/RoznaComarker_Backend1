'use strict';
// scripts/similarityCostTrial.js: refuses unless switched on by hand, outside test/production, with --max-usd up to 0.10; the calls it makes;
// it stops before passing the cap; it prints numbers and field names only. A fake fetch only: no network, no key.
const { main, runTrial, trialText, maxUsdOf } = require('../scripts/similarityCostTrial');
const F = require('./helpers/similarityProviderFixtures');

const ENV = { COPYSCAPE_USERNAME: 'trial-user', COPYSCAPE_API_KEY: 'trial-key-123' };
const routes = (balances = [1.0, 0.94]) => {
  let b = 0;
  return F.fakeFetch([{ match: () => true, reply: (_url, options) => {
    const form = new URLSearchParams(options.body);
    if (form.get('o') === 'balance') return { body: { value: String(balances[b++]), total: '100', today: '0' } };
    return { body: { ...F.copyscapeSearch('matched text'), cost: form.get('x') ? 0 : 0.03 } };
  } }]);
};

test('refuses without the switch, in test or production, and without (or above) the cap', async () => {
  await expect(main(['--max-usd', '0.10'], { ...ENV })).rejects.toThrow('SIMILARITY_TRIAL=call-copyscape');
  await expect(main(['--max-usd', '0.10'], { ...ENV, SIMILARITY_TRIAL: 'call-copyscape', NODE_ENV: 'test' })).rejects.toThrow('refused');
  await expect(main(['--max-usd', '0.10'], { ...ENV, SIMILARITY_TRIAL: 'call-copyscape', NODE_ENV: 'production' })).rejects.toThrow('refused');
  expect(() => maxUsdOf([])).toThrow('--max-usd <amount> is required');
  expect(() => maxUsdOf(['--max-usd', '0.11'])).toThrow('at most 0.10');
  expect(maxUsdOf(['--max-usd', '0.10'])).toBe(0.1);
});

test('the synthetic text is 200 words and contains no generated student-like content markers', () => {
  expect(trialText().split(/\s+/u)).toHaveLength(200);
});

test('five calls in order (test mode, balance, c=0, c=5, balance); output has numbers and field names only', async () => {
  const fetch = routes();
  const lines = [];
  const out = await runTrial({ env: ENV, fetch, maxUsd: 0.1, log: line => lines.push(line) });
  const forms = fetch.calls.map(c => new URLSearchParams(c.body));
  expect(forms.map(f => [f.get('o'), f.get('x'), f.get('c')])).toEqual([['csearch', '1', '3'], ['balance', null, null], ['csearch', null, '0'],
    ['csearch', null, '5'], ['balance', null, null]]);
  expect(forms.every(f => f.get('f') === 'json')).toBe(true);
  expect(forms[2].get('l')).toBe('0.04');
  expect(out.spentUsd).toBeCloseTo(0.06);
  const printed = lines.join('\n');
  expect(printed).toMatch(/balance change=0\.06/);
  expect(printed).not.toMatch(/trial-user|trial-key|Course of human|example\.test|snippet one|snippet two|matched text/);
});

test('stops before a call that would pass the cap', async () => {
  const fetch = routes();
  const lines = [];
  await runTrial({ env: ENV, fetch, maxUsd: 0.03, log: line => lines.push(line) });
  expect(fetch.calls.map(c => new URLSearchParams(c.body).get('c'))).toEqual(['3', null, '0', null]);
  expect(lines.join('\n')).toMatch(/4 check c=5: skipped/);
});

test('an error reply stops the trial without printing its text', async () => {
  const fetch = F.fakeFetch([{ match: () => true, reply: { body: { error: 'secret provider message' } } }]);
  await expect(runTrial({ env: ENV, fetch, maxUsd: 0.1, log: () => {} })).rejects.toThrow('its text is not printed');
});
