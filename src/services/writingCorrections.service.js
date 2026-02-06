const { checkTextWithLanguageTool } = require('./languageTool.service');

function defaultLegend() {
  return {
    version: '1.0.0',
    description: 'LanguageTool-based writing corrections legend.',
    groups: [
      {
        key: 'spelling',
        label: 'Spelling',
        color: '#F44336',
        symbols: [{ symbol: 'SP', label: 'Spelling', description: 'Possible misspelling.' }]
      },
      {
        key: 'grammar',
        label: 'Grammar',
        color: '#FF9800',
        symbols: [{ symbol: 'GR', label: 'Grammar', description: 'Possible grammar issue.' }]
      },
      {
        key: 'style',
        label: 'Style',
        color: '#2196F3',
        symbols: [{ symbol: 'ST', label: 'Style', description: 'Style suggestion.' }]
      },
      {
        key: 'typography',
        label: 'Typography',
        color: '#9C27B0',
        symbols: [{ symbol: 'TY', label: 'Typography', description: 'Punctuation/typography suggestion.' }]
      },
      {
        key: 'other',
        label: 'Other',
        color: '#607D8B',
        symbols: [{ symbol: 'CK', label: 'Check', description: 'Review this suggestion.' }]
      }
    ]
  };
}

function classifyIssueType(match) {
  const issueType = match && match.rule && typeof match.rule.issueType === 'string'
    ? match.rule.issueType.toLowerCase()
    : '';

  if (issueType.includes('misspelling')) return 'spelling';
  if (issueType.includes('grammar')) return 'grammar';
  if (issueType.includes('typographical')) return 'typography';
  if (issueType.includes('style')) return 'style';

  return 'other';
}

function legendMetaForGroup(groupKey) {
  const legend = defaultLegend();
  const group = (legend.groups || []).find((g) => g.key === groupKey) || legend.groups[legend.groups.length - 1];
  const symbol = group && group.symbols && group.symbols[0] ? group.symbols[0].symbol : 'CK';
  const symbolLabel = group && group.symbols && group.symbols[0] ? group.symbols[0].label : 'Check';
  const description = group && group.symbols && group.symbols[0] ? group.symbols[0].description : '';
  const color = group && typeof group.color === 'string' ? group.color : '#FFC107';
  return { groupLabel: group.label, symbol, symbolLabel, description, color };
}

function toIssuesFromLanguageTool(text, ltResponse) {
  const safeText = typeof text === 'string' ? text : '';
  const matches = ltResponse && Array.isArray(ltResponse.matches) ? ltResponse.matches : [];

  return matches
    .map((m) => {
      const start = typeof m.offset === 'number' ? m.offset : Number(m.offset);
      const length = typeof m.length === 'number' ? m.length : Number(m.length);
      if (!Number.isFinite(start) || !Number.isFinite(length) || length <= 0) return null;

      const end = start + length;
      const wrongText = safeText.slice(start, end);

      const repl = Array.isArray(m.replacements) && m.replacements[0] && typeof m.replacements[0].value === 'string'
        ? m.replacements[0].value
        : '';

      const groupKey = classifyIssueType(m);
      const meta = legendMetaForGroup(groupKey);

      const message = typeof m.message === 'string' ? m.message : '';

      return {
        start,
        end,
        wrongText,
        suggestion: repl,
        groupKey,
        groupLabel: meta.groupLabel,
        symbol: meta.symbol,
        symbolLabel: meta.symbolLabel,
        description: meta.description || message,
        color: meta.color,
        message
      };
    })
    .filter(Boolean);
}

async function getLegend() {
  return defaultLegend();
}

async function check({ text, language }) {
  const safeText = typeof text === 'string' ? text : '';
  const lt = await checkTextWithLanguageTool({ text: safeText, language });
  const issues = toIssuesFromLanguageTool(safeText, lt);

  return {
    text: safeText,
    issues,
    legendSource: 'LANGUAGETOOL_STATIC',
    imageAnnotations: []
  };
}

module.exports = {
  getLegend,
  check
};
