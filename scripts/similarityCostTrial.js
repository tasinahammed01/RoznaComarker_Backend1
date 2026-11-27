'use strict';
// OPT-IN Copyscape cost trial, for a person to run by hand with their OWN key. It never runs in tests or in the app:
//   - it does nothing unless run directly AND SIMILARITY_TRIAL=call-copyscape is set;
//   - it refuses when NODE_ENV is test or production, and without --max-usd (at most 0.10);
//   - it uses no database, sends only the synthetic text below (no student writing), and prints counts, field names and dollar amounts
//     only (never the text, a snippet, a URL, the username or the key).
//   SIMILARITY_TRIAL=call-copyscape node scripts/similarityCostTrial.js --max-usd 0.10
// Steps: (1) free test mode x=1, to see the reply's fields; (2) balance; (3) a 200-word check without full comparisons (c=0);
// (4) the same text with c=5, to see whether full comparisons cost more; (5) balance again. It stops before any call whose estimate
// would take the reported spend past --max-usd. Uses COPYSCAPE_USERNAME and COPYSCAPE_API_KEY (environment, or backend/.env when run).
// Copyleaks has no trial here: it needs the public webhook (docs/similarity-deployment.md, "Copyleaks sandbox check").
const SWITCH = 'call-copyscape';
const HARD_CAP_USD = 0.10;
const ENDPOINT = 'https://www.copyscape.com/api/';

// Synthetic: a public-domain passage (so the internet search has something to find) and made-up sentences, 200 words in all.
const PUBLIC_DOMAIN = 'When in the Course of human events, it becomes necessary for one people to dissolve the political bands which have connected them '
  + 'with another, and to assume among the powers of the earth, the separate and equal station to which the Laws of Nature and of Nature\'s God entitle '
  + 'them, a decent respect to the opinions of mankind requires that they should declare the causes which impel them to the separation.';
const FILLER = 'The blue kettle sang while seven quiet lanterns drifted over the harbour and a patient heron counted the ripples near the old stone pier.';
function trialText(words = 200) {
  const out = PUBLIC_DOMAIN.split(/\s+/u);
  const filler = FILLER.split(/\s+/u);
  for (let i = 0; out.length < words; i++) out.push(filler[i % filler.length]);
  return out.slice(0, words).join(' ');
}

const cents = words => 3 + Math.ceil(Math.max(0, words - 200) / 100);
const fieldNames = value => (value && typeof value === 'object' ? Object.keys(value).sort() : []);

async function call(fetch, params) {
  const response = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, f: 'json' }).toString() });
  const body = JSON.parse(await response.text());
  if (body && typeof body.error === 'string') throw new Error('Copyscape answered with an error (its text is not printed)');
  return body;
}

/** Runs the trial. log(line) receives numbers and field names only. Returns { spentUsd, steps }. */
async function runTrial({ env, fetch, maxUsd, log = console.log }) {
  const u = String(env.COPYSCAPE_USERNAME || '').trim();
  const k = String(env.COPYSCAPE_API_KEY || '').trim();
  if (!u || !k) throw new Error('COPYSCAPE_USERNAME and COPYSCAPE_API_KEY are required');
  const text = trialText(200);
  const words = text.split(/\s+/u).length;
  let spent = 0;
  const steps = [];
  const afford = usd => spent + usd <= maxUsd + 1e-9;
  const search = async (label, extra) => {
    const estimate = extra.x ? 0 : cents(words) / 100;
    if (!afford(estimate)) { log(`${label}: skipped (estimate ${estimate.toFixed(2)} would pass --max-usd ${maxUsd.toFixed(2)})`); return; }
    const body = await call(fetch, { u, k, o: 'csearch', e: 'UTF-8', t: text, l: (estimate + 0.01).toFixed(2), ...extra });
    const cost = Number(body.cost) || 0;
    spent += cost;
    const results = Array.isArray(body.result) ? body.result : [];
    const compared = results.filter(r => typeof r.textmatched === 'string').length;
    steps.push({ label, querywords: Number(body.querywords) || 0, cost, count: Number(body.count) || 0, compared });
    log(`${label}: querywords=${Number(body.querywords) || 0} cost=${cost.toFixed(2)} results=${results.length} compared=${compared}`);
    if (results[0]) log(`${label}: result fields ${fieldNames(results[0]).join(',')}`);
    log(`${label}: reply fields ${fieldNames(body).join(',')}`);
  };
  const balance = async label => {
    const body = await call(fetch, { u, k, o: 'balance' });
    const value = Number(body.value);
    steps.push({ label, balance: Number.isFinite(value) ? value : null });
    log(`${label}: balance=${Number.isFinite(value) ? value.toFixed(2) : 'unknown'}`);
    return value;
  };
  await search('1 test mode (free)', { x: '1', c: '3' });
  const before = await balance('2 balance');
  await search('3 check c=0', { c: '0' });
  await search('4 check c=5', { c: '5' });
  const after = await balance('5 balance');
  log(`reported cost total=${spent.toFixed(2)}${Number.isFinite(before) && Number.isFinite(after) ? ` balance change=${(before - after).toFixed(2)}` : ''}`);
  return { spentUsd: spent, steps };
}

function maxUsdOf(argv) {
  const i = argv.indexOf('--max-usd');
  const value = i >= 0 ? Number(argv[i + 1]) : NaN;
  if (!(value > 0)) throw new Error('--max-usd <amount> is required');
  if (value > HARD_CAP_USD) throw new Error(`--max-usd is at most ${HARD_CAP_USD.toFixed(2)}`);
  return value;
}

async function main(argv = process.argv.slice(2), env = process.env) {
  if (env.SIMILARITY_TRIAL !== SWITCH) throw new Error(`set SIMILARITY_TRIAL=${SWITCH} to make real (paid) calls`);
  if (['test', 'production'].includes(String(env.NODE_ENV || '').toLowerCase())) throw new Error('refused: NODE_ENV is test or production');
  const maxUsd = maxUsdOf(argv);
  return runTrial({ env, fetch: globalThis.fetch, maxUsd });
}

if (require.main === module) {
  require('dotenv').config();
  main().catch(error => { console.error(`similarityCostTrial: ${error.message}`); process.exitCode = 1; });
}
module.exports = { main, runTrial, trialText, maxUsdOf, HARD_CAP_USD };
