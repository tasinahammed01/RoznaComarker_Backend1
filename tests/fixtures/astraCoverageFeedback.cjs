'use strict';
function fixture() {
  const data = require('./astraRubricEvidence.cjs').fixture();
  data.transcript += ' do a decision';
  data.corrections.push(require('../../src/services/correctionCanonical.service').normalizeCorrection({
    symbol: 'COL', category: 'VOCABULARY', quotedText: 'do a decision', suggestedText: 'make a decision',
    startChar: data.transcript.indexOf('do a decision'), endChar: data.transcript.length,
    message: 'Use the appropriate collocation.', confidence: .99, correctionKind: 'localized', severity: 'medium'
  }, data.transcript, [], require('../../src/services/writingCorrections.service').defaultLegend(), 'AI'));
  data.transcript += ' The narrator considers how personal freedom relates to social expectations. This reflection connects the situation to the central theme.';
  data.findings = data.corrections.map(c => ({ category: c.category, symbol: c.symbol, quotedText: c.quotedText,
    suggestedText: c.suggestedText || '', message: c.message, correctionKind: c.correctionKind,
    confidence: .99, severity: 'medium', stylePreference: false, occurrence: 0 }));
  return data;
}
module.exports = { fixture };
