'use strict';

const CATEGORIES = ['CONTENT', 'GRAMMAR', 'ORGANIZATION', 'VOCABULARY', 'MECHANICS'];
const COLORS = { CONTENT: '#e89b3c', GRAMMAR: '#39956b', ORGANIZATION: '#3b82a0', VOCABULARY: '#8958b8', MECHANICS: '#c59a15' };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const id = (value) => String(value?._id || value || '');
const finite = (value) => Number.isFinite(Number(value));
const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value)));

function normalizeBox(box) {
  if (!box || !['x', 'y', 'w', 'h'].every((key) => finite(box[key]))) return null;
  const rawX = Number(box.x); const rawY = Number(box.y); const rawW = Number(box.w); const rawH = Number(box.h);
  if (rawW <= 0 || rawH <= 0) return null;
  const x = clamp(rawX, 0, 100); const y = clamp(rawY, 0, 100);
  const x2 = clamp(rawX + rawW, 0, 100); const y2 = clamp(rawY + rawH, 0, 100);
  return x2 > x && y2 > y ? { x, y, w: x2 - x, h: y2 - y } : null;
}

function normalizeBoxes(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).map(normalizeBox).filter((box) => {
    if (!box) return false;
    const key = [box.x, box.y, box.w, box.h].map((n) => n.toFixed(3)).join(':');
    if (seen.has(key)) return false; seen.add(key); return true;
  });
}

function highlightedSegments(text, pageStart, corrections, numberById) {
  const safeText = String(text || ''); const pageEnd = pageStart + safeText.length;
  const relevant = corrections.filter((c) => finite(c.startChar) && finite(c.endChar) && Number(c.startChar) < pageEnd && Number(c.endChar) > pageStart);
  const boundaries = new Set([0, safeText.length]);
  relevant.forEach((c) => { boundaries.add(clamp(Number(c.startChar) - pageStart, 0, safeText.length)); boundaries.add(clamp(Number(c.endChar) - pageStart, 0, safeText.length)); });
  const points = [...boundaries].sort((a, b) => a - b);
  return points.slice(0, -1).map((start, index) => {
    const end = points[index + 1];
    const active = relevant.filter((c) => Number(c.startChar) < pageStart + end && Number(c.endChar) > pageStart + start)
      .sort((a, b) => numberById.get(a.reportId) - numberById.get(b.reportId));
    return { text: safeText.slice(start, end), correctionNumbers: active.map((c) => numberById.get(c.reportId)), symbols: active.map((c) => c.symbol), color: active[0]?.color || null };
  });
}

function flattenLegend(input) {
  const raw = Array.isArray(input) ? input : Array.isArray(input?.groups) ? input.groups.flatMap((group) => (group.symbols || []).map((item) => ({ ...item, category: group.key, color: group.color }))) : [];
  return raw.map((item) => ({ symbol: String(item.symbol || ''), label: String(item.label || item.symbol || ''), description: String(item.description || ''), category: String(item.category || '').toUpperCase(), color: COLORS[String(item.category || '').toUpperCase()] || item.color || '#64748b' }));
}

function buildSubmissionFeedbackReportViewModel(input = {}) {
  const submission = input.submission || {}; const evaluation = input.evaluation || {}; const feedback = input.feedback || {};
  const legend = flattenLegend(input.legend); const legendBySymbol = new Map(legend.map((item) => [item.symbol, item]));
  const rawCorrections = Array.isArray(submission.writingCorrections) ? submission.writingCorrections : [];
  const fileIds = (submission.files || []).map(id).filter(Boolean); const fileOrder = new Map(fileIds.map((fileId, index) => [fileId, index]));
  const corrections = rawCorrections.map((item, index) => {
    const category = String(item?.category || '').toUpperCase(); const symbol = String(item?.symbol || ''); const legendItem = legendBySymbol.get(symbol);
    return { ...item, reportId: String(item?.id || item?._id || `correction-${index}`), fileId: id(item?.fileId), page: Number(item?.page || item?.pageNumber || 1), category: CATEGORIES.includes(category) ? category : 'MECHANICS', symbol, symbolLabel: item?.symbolLabel || legendItem?.label || symbol, color: COLORS[CATEGORIES.includes(category) ? category : 'MECHANICS'], quotedText: String(item?.quotedText || item?.originalText || item?.word || ''), message: String(item?.message || ''), suggestedText: String(item?.suggestedText || ''), startChar: Number(item?.startChar), endChar: Number(item?.endChar), bboxList: normalizeBoxes(item?.bboxList) };
  }).sort((a, b) => (fileOrder.get(a.fileId) ?? 99999) - (fileOrder.get(b.fileId) ?? 99999) || a.page - b.page || (finite(a.startChar) ? a.startChar : 1e12) - (finite(b.startChar) ? b.startChar : 1e12));
  const numberById = new Map(corrections.map((c, index) => [c.reportId, index + 1]));
  const statistics = Object.fromEntries(CATEGORIES.map((category) => [category.toLowerCase(), corrections.filter((c) => c.category === category).length])); statistics.total = corrections.length;
  const teacherOverride = Boolean(feedback.overriddenByTeacher || evaluation.overriddenByTeacher);
  const evaluationCurrent = teacherOverride || (Boolean(submission.correctionSourceHash) && ['completed', 'partial'].includes(String(evaluation.status || 'completed')) && evaluation.evaluationSourceHash === submission.correctionSourceHash);
  const detailedCurrent = teacherOverride || (Boolean(submission.correctionSourceHash) && feedback.detailedFeedbackSourceHash === submission.correctionSourceHash);
  const pageSource = Array.isArray(submission.transcriptPages) ? submission.transcriptPages : [];
  const pages = [...pageSource].sort((a, b) => (fileOrder.get(id(a.fileId)) ?? 99999) - (fileOrder.get(id(b.fileId)) ?? 99999) || Number(a.pageNumber || 1) - Number(b.pageNumber || 1));
  const submittedPages = pages.map((page, index) => {
    const fileId = id(page.fileId); const pageNumber = Number(page.pageNumber || 1); const pageText = String(page.text || ''); const startChar = Number(page.startChar || 0);
    const pageCorrections = corrections.filter((c) => c.fileId === fileId && c.page === pageNumber);
    const assetKey = `${fileId}:${pageNumber}`;
    return { fileId, fileIndex: fileOrder.get(fileId) ?? index, fileName: String(page.fileName || ''), fileType: String(page.fileType || ''), pageNumber, displayPageNumber: index + 1, imageDataUrl: submission.imageDataByPageKey?.[assetKey] || submission.imageDataByFileId?.[fileId] || null, imageWidth: Number(page.imageWidth || 0), imageHeight: Number(page.imageHeight || 0), annotationObstacles: normalizeBoxes((Array.isArray(page.words) ? page.words : []).map((word) => word?.bbox)), transcriptStartChar: startChar, transcriptEndChar: Number(page.endChar ?? startChar + pageText.length), transcriptText: pageText, transcriptParagraphs: Array.isArray(page.paragraphs) ? page.paragraphs : [], corrections: pageCorrections.map((c) => ({ ...c, displayNumber: numberById.get(c.reportId) })), transcript: { text: pageText, startChar, endChar: Number(page.endChar ?? startChar + pageText.length), highlightedSegments: highlightedSegments(pageText, startChar, pageCorrections, numberById) } };
  });
  const rubric = evaluationCurrent ? evaluation.rubricScores || {} : {};
  const categoryScores = Object.entries(rubric).map(([category, item]) => { const maxScore = Math.max(0, Number(item?.maxScore || 0)); const score = clamp(Number(item?.score || 0), 0, maxScore); return { category, score, maxScore, percentage: maxScore ? Math.round(score / maxScore * 100) : 0, issueCount: CATEGORIES.includes(category) ? statistics[category.toLowerCase()] : null, feedback: String(item?.comment || '') }; });
  const boundedOverall = categoryScores.reduce((sum, item) => sum + item.score, 0); const maximumScore = categoryScores.reduce((sum, item) => sum + item.maxScore, 0) || 100;
  const completeLegend = legend; const activeLegendItems = completeLegend.filter((item) => corrections.some((c) => c.symbol === item.symbol)).map((item) => ({ ...item, count: corrections.filter((c) => c.symbol === item.symbol).length }));
  return { report: { generatedAt: input.generatedAt || new Date().toISOString(), reportVersion: 'submission-feedback-2.0' }, submission: { ...(input.identity || {}), submissionId: id(submission._id) || 'submission', wordCount: String(submission.canonicalText || '').trim().split(/\s+/).filter(Boolean).length, uploadedPageCount: submittedPages.length }, result: { overallScore: evaluationCurrent && categoryScores.length ? boundedOverall : null, maximumScore, grade: evaluationCurrent ? evaluation.grade || null : null, evaluationStatus: evaluationCurrent ? evaluation.status || 'completed' : 'stale', correctionStatus: submission.correctionStatus, correctionSourceHash: submission.correctionSourceHash || null, evaluationSourceHash: evaluationCurrent ? evaluation.evaluationSourceHash || submission.correctionSourceHash : null, teacherAdjusted: teacherOverride }, statistics, categoryScores, submittedPages, detailedFeedback: detailedCurrent ? feedback.detailedFeedback || { areasForImprovement: [], strengths: [], actionSteps: [] } : { status: 'stale', areasForImprovement: [], strengths: [], actionSteps: [] }, teacherComments: String(feedback.teacherComments || input.teacherComments || ''), activeLegendItems, completeLegend, diagnostics: { persistedStatisticsMismatch: CATEGORIES.some((category) => Number(submission.correctionStatistics?.[category.toLowerCase()] || 0) !== statistics[category.toLowerCase()]), rejectedCorrections: rawCorrections.length - corrections.length }, esc };
}

module.exports = { CATEGORIES, COLORS, esc, normalizeBoxes, highlightedSegments, buildSubmissionFeedbackReportViewModel };
