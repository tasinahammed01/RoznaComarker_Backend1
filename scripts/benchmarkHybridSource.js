'use strict';
// Offline only. No dotenv, database connection or provider call.
const fs = require('fs');
const path = require('path');
const { evaluate } = require('../src/services/hybridSource/benchmark');
const root = path.resolve(__dirname, '../tests/fixtures/hybrid-source/private');
const pages = fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()) : [];
const results = [];
for (const page of pages) {
  const directory = path.join(root, page.name);
  const goldPath = path.join(directory, 'human-gold.json'), candidatePath = path.join(directory, 'candidate.json');
  if (!fs.existsSync(goldPath) || !fs.existsSync(candidatePath)) continue;
  const read = file => {
    if (fs.statSync(file).size > 1024 * 1024) throw new Error('Fixture exceeds size limit');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };
  results.push({ fixture: page.name, metrics: evaluate(read(goldPath), read(candidatePath)) });
}
console.log(JSON.stringify({ status: results.length ? 'evaluated' : 'BLOCKED_NO_HUMAN_GOLD',
  realPagesEvaluated: results.length, results }, null, 2));
