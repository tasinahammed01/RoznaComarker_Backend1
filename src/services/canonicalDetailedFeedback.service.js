const VERSION = 'canonical-detailed-feedback-2';
const CATEGORIES = ['CONTENT', 'ORGANIZATION', 'GRAMMAR', 'VOCABULARY', 'MECHANICS'];

const clean = (value, max = 240) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

function evidenceByCategory(corrections) {
  const groups = new Map(CATEGORIES.map((category) => [category, []]));
  for (const correction of corrections || []) if (groups.has(correction?.category)) groups.get(correction.category).push(correction);
  return groups;
}

function dominantSymbols(items) {
  const counts = new Map();
  for (const item of items) if (item.symbol) counts.set(item.symbol, (counts.get(item.symbol) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([symbol]) => symbol);
}

function examples(items) {
  return [...items].sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0) || String(a.id).localeCompare(String(b.id)))
    .filter((item) => item.id && item.symbol && item.quotedText)
    .slice(0, 3).map((item) => ({ correctionId: String(item.id), symbol: item.symbol,
      symbolLabel: clean(item.symbolLabel || item.label || item.message, 80),
      quotedText: clean(item.quotedText, 140), message: clean(item.message), suggestedText: clean(item.suggestedText, 140) }));
}

function isStructuredDetailedFeedback(feedback) {
  if (!feedback || typeof feedback !== 'object' || !Array.isArray(feedback.areasForImprovement)
    || !Array.isArray(feedback.strengths) || !Array.isArray(feedback.actionSteps)) return false;
  return feedback.areasForImprovement.every((item) => item && typeof item === 'object' && !Array.isArray(item))
    && feedback.strengths.every((item) => item && typeof item === 'object' && !Array.isArray(item))
    && feedback.actionSteps.every((item) => item && typeof item === 'object' && !Array.isArray(item));
}

function buildDeterministicDetailedFeedback({ corrections, statistics, categoryScores, sourceHash, semanticAssessment = null }) {
  const grouped = evidenceByCategory(corrections);
  const areas = [];
  for (const category of CATEGORIES) {
    const key = category.toLowerCase(); const items = grouped.get(category); const issueCount = Number(statistics?.[key] || 0);
    const scoreItem = categoryScores?.[category] || {}; const score = Number(scoreItem.score || 0); const maxScore = Number(scoreItem.maxScore || 0);
    if (!issueCount || !items.length) continue;
    const symbols = dominantSymbols(items); const sample = examples(items);
    const pattern = symbols.length ? `The main recorded pattern${symbols.length === 1 ? ' is' : 's are'} ${symbols.join(', ')}.` : 'The canonical analysis identified revision evidence.';
    areas.push({ id: `area_${category.toLowerCase()}`, category, title: category[0] + category.slice(1).toLowerCase(),
      issueCount, score, maxScore, explanation: `${issueCount} distinct issue${issueCount === 1 ? '' : 's'} affected this category. ${pattern}`,
      dominantSymbols: symbols, examples: sample });
  }
  areas.sort((a, b) => (a.score / Math.max(1, a.maxScore)) - (b.score / Math.max(1, b.maxScore)) || b.issueCount - a.issueCount);

  const semanticStrengths = semanticAssessment?.categories || {};
  const strengths = [];
  for (const category of [...CATEGORIES, 'PRESENTATION']) {
    const scoreItem = categoryScores?.[category]; if (!scoreItem?.maxScore) continue;
    const key = category.toLowerCase(); const count = Number(statistics?.[key] || 0);
    const semanticEvidence = Array.isArray(semanticStrengths?.[category]?.strengthEvidence) ? semanticStrengths[category].strengthEvidence : [];
    const evidence = semanticEvidence.map((item) => clean(item.quotedText, 160)).filter(Boolean).slice(0, 2);
    if (category !== 'PRESENTATION' && !evidence.length) continue;
    if (category !== 'PRESENTATION' && count && Number(scoreItem.score) / Number(scoreItem.maxScore) < 0.75) continue;
    strengths.push({ id: `strength_${key}`, category, title: category[0] + category.slice(1).toLowerCase(),
      score: Number(scoreItem.score), maxScore: Number(scoreItem.maxScore),
      explanation: category === 'PRESENTATION'
        ? 'Presentation is provisional and should be confirmed by teacher review.'
        : clean(semanticEvidence[0]?.explanation || scoreItem.comment),
      evidence: category === 'PRESENTATION' ? [clean(scoreItem.comment)] : evidence, provisional: category === 'PRESENTATION' });
  }

  const actionSteps = areas.slice(0, 5).map((area, index) => ({ id: `action_${area.category.toLowerCase()}`, priority: index + 1,
    category: area.category, action: `Revise the ${area.dominantSymbols.join('/')} correction${area.issueCount === 1 ? '' : 's'} in the highlighted passages.`,
    reason: `${area.issueCount} canonical ${area.title.toLowerCase()} issue${area.issueCount === 1 ? '' : 's'} currently affect the ${area.score}/${area.maxScore} category result.`,
    relatedSymbols: area.dominantSymbols, relatedCorrectionIds: area.examples.map((item) => item.correctionId) }));
  return { status: 'completed', sourceHash, evaluationVersion: VERSION,
    areasForImprovement: areas.slice(0, 5), strengths: strengths.slice(0, 3), actionSteps };
}

function validateDetailedFeedback(feedback, { corrections, statistics, categoryScores, sourceHash }) {
  if (!isStructuredDetailedFeedback(feedback) || feedback.sourceHash !== sourceHash) return null;
  const ids = new Map((corrections || []).map((item) => [String(item.id), item]));
  for (const area of feedback.areasForImprovement || []) {
    if (!CATEGORIES.includes(area.category) || area.issueCount !== Number(statistics[area.category.toLowerCase()] || 0)) return null;
    const score = categoryScores[area.category]; if (!score || area.score !== Number(score.score) || area.maxScore !== Number(score.maxScore)) return null;
    for (const example of area.examples || []) { const correction = ids.get(String(example.correctionId));
      if (!correction || example.quotedText !== clean(correction.quotedText, 140) || example.symbol !== correction.symbol) return null; }
  }
  for (const step of feedback.actionSteps || []) if ((step.relatedCorrectionIds || []).some((id) => !ids.has(String(id)))) return null;
  return feedback;
}

module.exports = { VERSION, dominantSymbols, examples, isStructuredDetailedFeedback,
  buildDeterministicDetailedFeedback, validateDetailedFeedback };
