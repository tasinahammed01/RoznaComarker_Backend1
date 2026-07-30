'use strict';

require('dotenv').config();

const crypto = require('crypto');
const semanticWriting = require('../src/services/semanticWritingCorrections.service');
const semanticRubric = require('../src/services/semanticRubricAssessment.service');
const { getSemanticAIConfig } = require('../src/services/semanticAIClient.service');

function safeResult(stage, result, startedAt) {
  return {
    stage,
    status: 'completed',
    provider: result.provider || null,
    model: result.model || null,
    durationMs: Date.now() - startedAt,
    correctionCount: Array.isArray(result.corrections) ? result.corrections.length : undefined,
    categoryCount: result.categories ? Object.keys(result.categories).length : undefined,
    attemptCount: Number(result.metrics?.attemptCount) || null,
    inputTokens: Number(result.usage?.prompt_tokens || result.metrics?.inputTokenCount) || null,
    outputTokens: Number(result.usage?.completion_tokens || result.metrics?.outputTokenCount) || null
  };
}

function safeFailure(stage, error, startedAt) {
  return {
    stage,
    status: 'failed',
    provider: error?.provider || null,
    model: error?.model || null,
    durationMs: Date.now() - startedAt,
    httpStatus: Number(error?.httpStatus || error?.status) || null,
    finishReason: error?.finishReason || null,
    candidateCount: Number.isFinite(error?.candidateCount) ? error.candidateCount : null,
    responseTextLength: Number.isFinite(error?.responseTextLength) ? error.responseTextLength : null,
    validationStage: error?.validationStage || null,
    validationIssues: Array.isArray(error?.validationIssues) ? error.validationIssues : [],
    errorCode: error?.code || 'LIVE_SMOKE_FAILED'
  };
}

async function main() {
  if (process.env.RUN_LIVE_AI_SMOKE_TEST !== 'true') {
    console.log(JSON.stringify({ status: 'skipped', reason: 'RUN_LIVE_AI_SMOKE_TEST_NOT_ENABLED' }));
    return;
  }
  const config = getSemanticAIConfig();
  const transcript = 'Public transport can reduce traffic. Clear schedules help people choose buses.';
  const sourceHash = crypto.createHash('sha256').update(transcript).digest('hex');
  let startedAt = Date.now();
  let semantic;
  try {
    semantic = await semanticWriting.analyze({
      transcript,
      transcriptHash: sourceHash,
      assignment: { title: 'Benefits of public transport' },
      pageManifest: [{ fileId: 'synthetic-page', pageNumber: 1, startChar: 0, endChar: transcript.length }]
    }, { config, env: process.env });
    console.log(JSON.stringify(safeResult('semantic_corrections', semantic, startedAt)));
  } catch (error) {
    console.error(JSON.stringify(safeFailure('semantic_corrections', error, startedAt)));
    process.exitCode = 1;
    return;
  }
  const corrections = (semantic.corrections || []).map((item, index) => ({
    ...item,
    id: `synthetic-${index + 1}`
  }));
  startedAt = Date.now();
  try {
    const rubric = await semanticRubric.assess({
      transcript,
      sourceHash,
      assignment: { title: 'Benefits of public transport' },
      corrections,
      statistics: {},
      pageManifest: [{ fileId: 'synthetic-page', pageNumber: 1, startChar: 0, endChar: transcript.length }]
    }, { config, env: process.env });
    console.log(JSON.stringify(safeResult('semantic_rubric', rubric, startedAt)));
  } catch (error) {
    console.error(JSON.stringify(safeFailure('semantic_rubric', error, startedAt)));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(JSON.stringify(safeFailure('startup', error, Date.now())));
  process.exitCode = 1;
});
