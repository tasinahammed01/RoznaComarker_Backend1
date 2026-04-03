const { checkTextWithLanguageTool } = require('./languageTool.service');
const CorrectionLegend = require('../models/CorrectionLegend');

let _legendCache = null;
let _legendCacheAt = 0;
const LEGEND_CACHE_TTL_MS = 5 * 60 * 1000;

const LANGUAGETOOL_TO_ACADEMIC_GROUP = {
  spelling: 'MECHANICS',
  grammar: 'GRAMMAR',
  style: 'ORGANIZATION',
  typography: 'MECHANICS',
  other: 'VOCABULARY'
};

const LANGUAGETOOL_SYMBOLS = {
  spelling: 'SP',
  grammar: 'GR',
  style: 'ST',
  typography: 'TY',
  other: 'CK'
};

function defaultLegend() {
  return {
    version: '1.0',
    description: 'Academic correction legend for AI-assisted writing feedback',
    groups: [
      {
        key: 'CONTENT',
        label: 'Content (Ideas & Relevance)',
        color: '#FFD6A5',
        symbols: [
          { symbol: 'REL', label: 'Relevance', description: 'The idea is not related to the topic or task.' },
          { symbol: 'DEV', label: 'Idea Development', description: 'The point is too general or lacks details or examples.' },
          { symbol: 'TA', label: 'Task Achievement', description: 'The response does not fully answer the prompt or question.' },
          { symbol: 'CL', label: 'Clarity of Ideas', description: 'The message is unclear or confusing.' },
          { symbol: 'SD', label: 'Supporting Details', description: 'Examples or explanations are missing to support the main idea.' }
        ]
      },
      {
        key: 'ORGANIZATION',
        label: 'Organization (Structure & Flow)',
        color: '#CDE7F0',
        symbols: [
          { symbol: 'COH', label: 'Coherence', description: 'Ideas are not logically connected.' },
          { symbol: 'CO', label: 'Cohesion', description: 'Linking words or transitions are missing or misused.' },
          { symbol: 'PU', label: 'Paragraph Unity', description: 'The paragraph contains unrelated ideas.' },
          { symbol: 'TS', label: 'Topic Sentence', description: 'The topic sentence is missing or unclear.' },
          { symbol: 'CONC', label: 'Conclusion', description: 'The conclusion is weak or missing.' }
        ]
      },
      {
        key: 'GRAMMAR',
        label: 'Grammar (Sentence & Structure)',
        color: '#B7E4C7',
        symbols: [
          { symbol: 'T', label: 'Tense', description: 'Incorrect verb tense.' },
          { symbol: 'VF', label: 'Verb Form', description: 'Incorrect verb form.' },
          { symbol: 'AGR', label: 'Subject–Verb Agreement', description: 'The verb does not agree with the subject.' },
          { symbol: 'FRAG', label: 'Sentence Fragment', description: 'Incomplete sentence missing a subject or verb.' },
          { symbol: 'RO', label: 'Run-on Sentence', description: 'Two or more sentences are joined incorrectly.' },
          { symbol: 'WO', label: 'Word Order', description: 'The order of words in the sentence is incorrect.' },
          { symbol: 'ART', label: 'Article Use', description: 'Missing or incorrect article (a, an, the).' },
          { symbol: 'PREP', label: 'Preposition', description: 'Incorrect or missing preposition.' }
        ]
      },
      {
        key: 'VOCABULARY',
        label: 'Vocabulary (Word Use & Form)',
        color: '#E4C1F9',
        symbols: [
          { symbol: 'WC', label: 'Word Choice', description: 'A more suitable word could be used.' },
          { symbol: 'WF', label: 'Word Form', description: 'Incorrect form of the word.' },
          { symbol: 'REP', label: 'Repetition', description: 'The same word or phrase is repeated too often.' },
          { symbol: 'FORM', label: 'Formal / Inappropriate Word', description: 'The word is too informal or not suitable for academic context.' },
          { symbol: 'COL', label: 'Collocation', description: 'Words do not naturally go together.' }
        ]
      },
      {
        key: 'MECHANICS',
        label: 'Mechanics (Spelling & Punctuation)',
        color: '#FFF3BF',
        symbols: [
          { symbol: 'SP', label: 'Spelling', description: 'The word is spelled incorrectly.' },
          { symbol: 'P', label: 'Punctuation', description: 'Punctuation mark is missing, extra, or incorrect.' },
          { symbol: 'CAP', label: 'Capitalization', description: 'Incorrect use of capital or lowercase letters.' },
          { symbol: 'SPC', label: 'Spacing', description: 'Missing or extra space between words or sentences.' },
          { symbol: 'FMT', label: 'Formatting', description: 'Inconsistent formatting, alignment, or spacing.' }
        ]
      }
    ]
  };
}

async function getLegendFromDb() {
  const now = Date.now();
  if (_legendCache && (now - _legendCacheAt) < LEGEND_CACHE_TTL_MS) {
    return _legendCache;
  }

  try {
    const doc = await CorrectionLegend.findOne({ version: '1.0' }).lean();
    if (doc && Array.isArray(doc.groups) && doc.groups.length) {
      const { _id, __v, ...legend } = doc;
      _legendCache = legend;
      _legendCacheAt = now;
      return _legendCache;
    }
  } catch {
  }

  return defaultLegend();
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

function legendMetaForGroup(groupKey, legend) {
  const activeLegend = legend || defaultLegend();
  const academicGroupKey = LANGUAGETOOL_TO_ACADEMIC_GROUP[groupKey] || 'MECHANICS';
  const groups = Array.isArray(activeLegend.groups) ? activeLegend.groups : [];

  const group = groups.find(
    (g) => g && typeof g.key === 'string' && g.key.toUpperCase() === academicGroupKey.toUpperCase()
  ) || groups[groups.length - 1];

  const symbol = LANGUAGETOOL_SYMBOLS[groupKey] || 'CK';
  const symbolLabel = group && group.label ? group.label : groupKey;
  const description = group && group.symbols && group.symbols[0] ? group.symbols[0].description : '';
  const color = group && typeof group.color === 'string' ? group.color : '#FFC107';

  return { groupLabel: symbolLabel, symbol, symbolLabel, description, color };
}

function toIssuesFromLanguageTool(text, ltResponse, legend) {
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
      const meta = legendMetaForGroup(groupKey, legend);

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
  return getLegendFromDb();
}

async function check({ text, language }) {
  const safeText = typeof text === 'string' ? text : '';
  const [lt, legend] = await Promise.all([
    checkTextWithLanguageTool({ text: safeText, language }),
    getLegendFromDb()
  ]);
  const issues = toIssuesFromLanguageTool(safeText, lt, legend);

  return {
    text: safeText,
    issues,
    legendSource: 'DB',
    imageAnnotations: []
  };
}

module.exports = {
  getLegend,
  check
};
