'use strict';
// Read-only, offline diagnostic. Never prints source text or performs inference.
const fs = require('fs');
const contract = require('../src/services/gptVisionExact/contract');
try {
  const file = process.argv[2];
  if (!file || fs.statSync(file).size > 1000000) throw Error('INVALID_DIAGNOSTIC_INPUT');
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw);
  const content = parsed?.choices?.[0]?.message?.content;
  contract.validate(typeof content === 'string' ? content : raw);
  console.log(JSON.stringify({status: 'VALID_SOURCE_CONTRACT', version: contract.VERSION}));
} catch (error) {
  const safe = require('../src/services/gptVisionExact.service').safeSourceDiagnostic(error.sourceDiagnostic);
  console.log(JSON.stringify({status: 'REJECTED', code: /^OCR_[A-Z_]+$/.test(error.code || '') ? error.code : 'INVALID_DIAGNOSTIC_INPUT', ...safe}));
  process.exitCode = 1;
}
