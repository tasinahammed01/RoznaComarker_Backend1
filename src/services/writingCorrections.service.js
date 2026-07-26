const { checkTextWithLanguageTool } = require('./languageTool.service');
const { normalizeOcrTranscript } = require('../utils/ocrTranscriptNormalizer');
const CorrectionLegend = require('../models/CorrectionLegend');

let _legendCache = null;
let _legendCacheAt = 0;
const LEGEND_CACHE_TTL_MS = 5 * 60 * 1000;

const LANGUAGE_TOOL_MAPPING_VERSION = 'language-tool-mapping-2';

const EXACT_RULE_OVERRIDES = Object.freeze({
  EN_UPPER_CASE_NGRAM: ['MECHANICS', 'CAP'],
  UPPERCASE_SENTENCE_START: ['MECHANICS', 'CAP'],
  INFORMATIONS: ['VOCABULARY', 'WF'],
  EVERYDAY_EVERY_DAY: ['VOCABULARY', 'WF'],
  THERE_THEIR: ['VOCABULARY', 'WC'],
  MORFOLOGIK_RULE_EN_US: ['MECHANICS', 'SP'],
  MD_BASEFORM: ['GRAMMAR', 'VF'],
  BASE_FORM: ['GRAMMAR', 'VF'],
  HAVE_PART_AGREEMENT: ['GRAMMAR', 'VF'],
  NON3PRS_VERB: ['GRAMMAR', 'AGR'],
  AGREEMENT_SENT_START: ['GRAMMAR', 'AGR'],
  HE_VERB_AGR: ['GRAMMAR', 'AGR'],
  IT_VBZ: ['GRAMMAR', 'AGR'],
  MANY_NN: ['GRAMMAR', 'AGR'],
  EACH_EVERY_NNS: ['GRAMMAR', 'AGR'],
  EN_A_VS_AN: ['GRAMMAR', 'ART'],
  SENT_START_CONJUNCTIVE_LINKING_ADVERB_COMMA: ['MECHANICS', 'P'],
  ENGLISH_WORD_REPEAT_RULE: ['VOCABULARY', 'REP'],
  INFORMALITY: ['VOCABULARY', 'FORM']
});

const CATEGORY_MAPPINGS = Object.freeze({
  CASING: ['MECHANICS', 'CAP'],
  PUNCTUATION: ['MECHANICS', 'P'],
  CONFUSED_WORDS: ['VOCABULARY', 'WC'],
  REDUNDANCY: ['VOCABULARY', 'REP'],
  COLLOCATIONS: ['VOCABULARY', 'COL'],
  WORD_FORM: ['VOCABULARY', 'WF']
});

// Reviewed, anchored rule families only. These patterns inspect rule IDs alone.
const REVIEWED_RULE_ID_PATTERNS = Object.freeze([
  [/^(?:SUBJECT_VERB_AGREEMENT|SVA|VERB_AGR|DOES_NP_VBZ|PLURAL_VERB)(?:_|$)/u, 'GRAMMAR', 'AGR'],
  [/^(?:VERB_FORM|INFINITIVE|GERUND|PARTICIPLE|BASE_FORM|TO_NON_BASE|AUXILIARY_VERB)(?:_|$)/u, 'GRAMMAR', 'VF'],
  [/^(?:TENSE|PAST_TENSE|PRESENT_TENSE)(?:_|$)/u, 'GRAMMAR', 'T'],
  [/^(?:ARTICLE|A_VS_AN)(?:_|$)/u, 'GRAMMAR', 'ART'],
  [/^(?:PREPOSITION|PREP)(?:_|$)/u, 'GRAMMAR', 'PREP'],
  [/^(?:WORD_ORDER|ORDER_OF_WORDS)(?:_|$)/u, 'GRAMMAR', 'WO'],
  [/^(?:FRAGMENT|SENTENCE_FRAGMENT)(?:_|$)/u, 'GRAMMAR', 'FRAG'],
  [/^(?:RUN_ON|COMMA_SPLICE)(?:_|$)/u, 'GRAMMAR', 'RO'],
  [/^(?:WHITESPACE|SPACE_BEFORE|DOUBLE_SPACE)(?:_|$)/u, 'MECHANICS', 'SPC'],
  [/^(?:PUNCTUATION|COMMA|APOSTROPHE)(?:_|$)/u, 'MECHANICS', 'P'],
  [/^(?:UPPERCASE|LOWERCASE|CASING|CAPITAL)(?:_|$)/u, 'MECHANICS', 'CAP'],
  [/^(?:MORFOLOGIK_RULE|SPELLING_RULE)(?:_|$)/u, 'MECHANICS', 'SP']
]);

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

function mapLanguageToolRule(match, legend = defaultLegend()) {
  const rule = match?.rule || {};
  const ruleId = String(rule.id || '').trim().toUpperCase();
  const categoryId = String(rule.category?.id || '').trim().toUpperCase();
  const issueType = String(rule.issueType || '').trim().toLowerCase();
  let mapped = EXACT_RULE_OVERRIDES[ruleId];
  let reason = mapped ? 'EXACT_RULE_OVERRIDE' : null;
  if (!mapped && CATEGORY_MAPPINGS[categoryId]) {
    mapped = CATEGORY_MAPPINGS[categoryId];
    reason = 'STRUCTURED_CATEGORY_ID';
  }
  if (!mapped && issueType === 'duplication') {
    mapped = ['VOCABULARY', 'REP'];
    reason = 'STRUCTURED_ISSUE_TYPE';
  }
  if (!mapped) {
    const pattern = REVIEWED_RULE_ID_PATTERNS.find(([re]) => re.test(ruleId));
    if (pattern) {
      mapped = [pattern[1], pattern[2]];
      reason = 'REVIEWED_RULE_ID_PATTERN';
    }
  }
  const decisionBase = { ruleId, categoryId, issueType, mappingVersion: LANGUAGE_TOOL_MAPPING_VERSION };
  if (!mapped) return { accepted: false, reason: 'UNSUPPORTED_LANGUAGETOOL_RULE', ...decisionBase };
  const [category, mappedSymbol] = mapped;
  const group = legend.groups.find((item) => item.key === category);
  const symbol = group?.symbols?.find((item) => item.symbol === mappedSymbol);
  if (!group || !symbol) return { accepted: false, reason: 'LEGEND_SYMBOL_UNAVAILABLE', ...decisionBase };
  return { accepted: true, reason, ...decisionBase, category, groupKey: category, groupLabel: group.label,
    symbol: symbol.symbol, symbolLabel: symbol.label, description: symbol.description, color: group.color };
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

      const meta = mapLanguageToolRule(m, legend);
      if (!meta.accepted) return null;
      const groupKey = meta.groupKey;

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
        message,
        classificationReason: meta.reason,
        languageToolRuleId: meta.ruleId,
        languageToolCategoryId: meta.categoryId,
        languageToolIssueType: meta.issueType,
        languageToolMappingVersion: meta.mappingVersion
      };
    })
    .filter(Boolean);
}

function languageToolDiagnostics(text, ltResponse, legend) {
  const matches = Array.isArray(ltResponse?.matches) ? ltResponse.matches : [];
  const counts = { rawMatches: matches.length, accepted: 0, dropped: 0, invalidOffset: 0,
    byRuleId: {}, byCategoryId: {}, byIssueType: {}, byFinalClassification: {},
    dropReasons: {}, droppedGrammarRuleIds: [] };
  const droppedGrammar = new Set();
  const increment = (target, key) => { target[key || 'UNSPECIFIED'] = (target[key || 'UNSPECIFIED'] || 0) + 1; };
  for (const match of matches) {
    const start = Number(match?.offset); const length = Number(match?.length);
    const ruleId = String(match?.rule?.id || 'UNSPECIFIED').toUpperCase();
    const categoryId = String(match?.rule?.category?.id || 'UNSPECIFIED').toUpperCase();
    const issueType = String(match?.rule?.issueType || 'UNSPECIFIED').toLowerCase();
    increment(counts.byRuleId, ruleId); increment(counts.byCategoryId, categoryId); increment(counts.byIssueType, issueType);
    if (!Number.isFinite(start) || !Number.isFinite(length) || length <= 0 || start < 0 || start + length > text.length) {
      counts.invalidOffset++; counts.dropped++; increment(counts.dropReasons, 'INVALID_OFFSET'); continue;
    }
    const decision = mapLanguageToolRule(match, legend);
    if (!decision.accepted) {
      counts.dropped++; increment(counts.dropReasons, decision.reason);
      if (categoryId === 'GRAMMAR' || issueType === 'grammar') droppedGrammar.add(ruleId);
    } else {
      counts.accepted++; increment(counts.byFinalClassification, `${decision.category}/${decision.symbol}`);
    }
  }
  counts.droppedGrammarRuleIds = [...droppedGrammar].sort();
  return counts;
}

async function getLegend() {
  return getLegendFromDb();
}

async function check({ text, language }) {
  const safeText = normalizeOcrTranscript(text);
  const [lt, legend] = await Promise.all([
    checkTextWithLanguageTool({ text: safeText, language }),
    getLegendFromDb()
  ]);
  const issues = toIssuesFromLanguageTool(safeText, lt, legend);

  return {
    text: safeText,
    issues,
    legendSource: 'DB',
    imageAnnotations: [],
    diagnostics: languageToolDiagnostics(safeText, lt, legend)
  };
}

module.exports = {
  getLegend,
  check,
  defaultLegend,
  mapLanguageToolRule,
  toIssuesFromLanguageTool,
  languageToolDiagnostics,
  LANGUAGE_TOOL_MAPPING_VERSION
};
