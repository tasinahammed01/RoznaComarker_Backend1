'use strict';
const crypto = require('crypto');
const IDENTITY_VERSION = 'assessment-content-identity-v1';
const stable = value => value == null ? null : Array.isArray(value) ? value.map(stable)
  : typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
function assessmentContext(assignment = {}) {
  // These are the assignment fields consumed by the correction/assessment prompt.
  return { title: assignment.title || '', instructions: assignment.instructions || assignment.description || '' };
}
function pageContentIdentity(pages = []) {
  return pages.map((page, index) => ({ order: index,
    pageIndex: Number.isFinite(Number(page?.pageIndex)) ? Number(page.pageIndex) : Number(page?.pageNumber || 1) - 1,
    textHash: hash(String(page?.text || '')) }));
}
function correctionInputHash({ transcript, pages = [], assignment = {}, fileContentIdentity = null, versions = {}, legend = {} }) {
  return hash({ identityVersion: IDENTITY_VERSION, transcript: String(transcript || ''),
    fileContentIdentity, pages: pageContentIdentity(pages), context: assessmentContext(assignment), versions,
    legendVersion: legend.version || null, legendContentHash: legend.contentHash || null });
}
function evaluationInputHash({ sourceHash, rubricHash, policyHash, contextHash, versions }) {
  return hash({ identityVersion: IDENTITY_VERSION, sourceHash, rubricHash, policyHash, contextHash, versions });
}
module.exports = { IDENTITY_VERSION, hash, assessmentContext, pageContentIdentity, correctionInputHash, evaluationInputHash };
