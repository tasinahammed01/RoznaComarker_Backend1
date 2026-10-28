'use strict';

require('dotenv').config({quiet:true});

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
  if(process.argv.includes('--rubric-only')) {
    const result=await runRubricOnly({authorized:process.argv.includes('--authorize-one-call'),
      wireV2:process.argv.includes('--rubric-wire-v2'),evidenceV2:process.argv.includes('--rubric-evidence-v2')});
    console.log(JSON.stringify(result));
    if(result.status!=='completed')process.exitCode=1;
    return;
  }
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

async function runRubricOnly({authorized=false,env=process.env,fetchImpl=global.fetch,consume,wireV2=false,evidenceV2=false}={}) {
  if(!authorized)throw Object.assign(Error('Separate single-call authorization required.'),{code:'RUBRIC_QA_AUTHORIZATION_REQUIRED'});
  const gateway=require('../src/services/aiGateway.service');
  const config=getSemanticAIConfig(env);
  if(config.model!==gateway.GEMINI_RUBRIC_MODEL||config.thinkingLevel!=='low')throw Error('RUBRIC_QA_CONFIG_MISMATCH');
  const transcript='Public transport can reduce traffic. Clear schedules help people choose buses. Reliable buses also help workers arrive on time.';
  const input={transcript,sourceHash:crypto.createHash('sha256').update(transcript).digest('hex'),transcriptComplete:true,includeLanguageCategories:true,
    assignment:{title:'Benefits of public transport',instructions:'Explain a benefit and support it with an example.'},corrections:[],statistics:{},
    policy:{strictness:'balanced',checks:{grammarSpelling:true,coherenceLogic:true,factChecking:false}},
    pageManifest:[{fileId:'synthetic-rubric-page',pageNumber:1,startChar:0,endChar:transcript.length}]};
  const bounded={...config,attemptTimeoutMs:90000,totalBudgetMs:95000,maxOutputTokens:8000,
    primaryRetries:0,fallbackRetries:0,retriesPerModel:0,maxRetries:0};
  const consumeMarker=consume||(()=>{
    const fs=require('fs'),path=require('path'),dir=path.resolve(__dirname,'../tmp');fs.mkdirSync(dir,{recursive:true});
    const marker=evidenceV2?'gemini-rubric-evidence-v2-a2c19f48-one-call.consumed'
      :wireV2?'gemini-rubric-wire-v2-6f1cb2b7-one-call.consumed':'gemini-rubric-v1-one-call.consumed';
    const fd=fs.openSync(path.join(dir,marker),'wx');fs.closeSync(fd);
  });
  let providerCallCount=0;const started=Date.now();
  const guardedFetch=(url,options)=>{
    if(providerCallCount!==0)throw Error('RUBRIC_QA_SECOND_FETCH_BLOCKED');
    const body=JSON.parse(options.body);
    if(url!=='https://openrouter.ai/api/v1/chat/completions'||body.model!==gateway.GEMINI_RUBRIC_MODEL
      ||body.reasoning?.effort!=='low'||body.provider?.require_parameters!==true||body.provider?.allow_fallbacks!==false
      ||body.response_format?.json_schema?.strict!==true||body.max_tokens!==8000)throw Error('RUBRIC_QA_TRANSPORT_MISMATCH');
    consumeMarker();providerCallCount++;
    return fetchImpl(url,options);
  };
  try {
    const result=await semanticRubric.assess(input,{env,config:bounded,fetchImpl:guardedFetch,disableEvidenceRepair:true});
    return {stage:'rubric_only',status:'completed',requestedModel:config.model,returnedModel:result.returnedModel,httpStatus:result.httpStatus,
      providerCallCount,latencyMs:Date.now()-started,finishReason:result.finishReason,...semanticRubric.contractVersions(config.model),
      strictness:'balanced',reasoningEffort:'low',schemaValidation:'PASS',quality:'UNPROVEN',
      categoryScores:Object.fromEntries(Object.entries(result.categories).map(([key,value])=>[key,value.score])),
      promptTokens:result.metrics.promptTokenCount,completionTokens:result.metrics.outputTokenCount,reasoningTokens:result.metrics.thoughtsTokenCount,
      totalTokens:result.metrics.totalTokenCount,costUSD:result.metrics.providerCostUSD};
  }catch(error){return {stage:'rubric_only',status:'failed',requestedModel:config.model,providerCallCount,latencyMs:Date.now()-started,
    safeFailureCode:/^[A-Z0-9_]+$/.test(error.code||'')?error.code:'RUBRIC_QA_FAILED',quality:'UNPROVEN'};}
}
if(require.main===module)main().catch((error) => {
  console.error(JSON.stringify(safeFailure('startup', error, Date.now())));
  process.exitCode = 1;
});
module.exports={runRubricOnly};
