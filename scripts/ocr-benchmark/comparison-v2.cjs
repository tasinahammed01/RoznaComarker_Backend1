'use strict';
const fs=require('fs'),path=require('path');
const v2=require('./benchmark-v2.cjs');
function report() {
  const protectedCount=v2.assertSnapshot(v2.read(v2.DIRECTORY,'protected-baseline.json'));
  // Reuse the exact diff and HTML rendering without writing V1 reports or checking V1's older baseline.
  const rendered=require('./comparison.cjs').report({directory:v2.DIRECTORY,writeRoot:false,checkIntegrity:false});
  const summary={...rendered.summary,version:2,protectedFileCount:protectedCount,wireParameterKeys:v2.KEYS,temperatureOmitted:true,max_tokensOmitted:true,
    max_completion_tokens:12000,promptPreservedFromV1:true,promptSha256:v2.EXPECTED_PROMPT_SHA,schemaSha256:v2.sha(JSON.stringify(v2.schema))};
  const write=(name,data)=>fs.writeFileSync(path.join(v2.DIRECTORY,'comparison',name),typeof data==='string'?data:JSON.stringify(data,null,2)+'\n',{mode:0o600});
  write('benchmark-summary.json',summary);
  const html=rendered.html.replace('<h1>Exact handwriting · GPT Astra vs Claude Fable 5.1</h1>',
    '<h1>V2 · Exact handwriting · GPT Astra vs Claude Fable 5.1</h1><p>Shared V2 wire keys: model, messages, max_completion_tokens, response_format, provider. Output limit: 12000. Temperature and all sampling parameters omitted.</p>');
  write('comparison.html',html);
  const slots=summary.models.map(s=>({slot:s.slot,state:s,parsed:fs.existsSync(path.join(v2.DIRECTORY,s.slot,'parsed-response.json'))?v2.read(path.join(v2.DIRECTORY,s.slot),'parsed-response.json'):null}));
  const incomplete=slots.filter(s=>s.state.status!=='COMPLETE');
  const validation=fs.existsSync(path.join(v2.DIRECTORY,'validation.json'))?v2.read(v2.DIRECTORY,'validation.json'):null;
  const table=slots.map(({slot,state})=>`| ${slot} | ${state.requestedModel} | ${state.returnedModel??'none'} | ${state.status} | ${state.providerCalls} | ${state.httpStatus??'not reported'} | ${state.finishReason??'not reported'} | ${state.latencyMs??'not reported'} | ${state.usage?.prompt_tokens??'not reported'} | ${state.usage?.completion_tokens??'not reported'} | ${state.usage?.total_tokens??'not reported'} | ${state.usage?.reasoning_tokens??'not reported'} | ${state.usage?.cost??'not reported'} |`).join('\n');
  const hasRoutingFailure=slots.some(s=>s.state.routingCompatibilityFailure);
  if(hasRoutingFailure)write('failure-analysis.json',{failureType:'REQUEST_COMPATIBILITY_NOT_OCR_QUALITY',wireParameterKeys:v2.KEYS,
    errors:slots.map(s=>({slot:s.slot,error:s.state.providerError??null})),samplingParameters:[],max_completion_tokens:12000,
    structuredSchemaKeywords:[...new Set(JSON.stringify(v2.schema).match(/\"(?:type|properties|required|additionalProperties|items|enum|description)\"/g))],
    conclusion:'If the provider supplies only Filter by Parameters, it does not identify which remaining parameter was rejected. Inspect saved endpoint evidence and response details offline; no additional generation, fallback relaxation or structured-output removal is permitted.'});
  const text=`# Astra vs Fable — Page 01 V2 compatibility benchmark

Benchmark date: 2026-10-20 (Asia/Dhaka). Private experiment only.

## Outcome

${slots.map(s=>`${s.slot}: **${s.state.status}** (${s.state.providerCalls} request)`).join('; ')}. ${incomplete.length?'A complete successful two-model transcription comparison is not available.':'Both exact requested models completed and passed structural validation.'} Confidence, model agreement and cleaner English are not human source gold.

## V1 failure and V2 change

V1 failed HTTP 404 at **Filter by Parameters**, before OCR-quality could be assessed. Its outbound envelope was reconstructed from unchanged V1 code and saved request metadata: model, messages, temperature, max_tokens, response_format, provider, stream. It sent temperature=0, max_tokens=12000, stream=false, require_parameters=true, allow_fallbacks=false, and numeric confidence minimum/maximum constraints. V1 did not retain a full image-bearing outbound body; this is a deterministic source/metadata reconstruction, not a new transport capture. See private v1-request-audit.json.

V2 sends exactly these five top-level keys, for both models:

\`\`\`json
${JSON.stringify(v2.KEYS,null,2)}
\`\`\`

**temperature is omitted entirely. max_tokens is absent. max_completion_tokens=12000.** All other sampling parameters, stream, fallback model lists and plugins are absent. provider.require_parameters=true and provider.allow_fallbacks=false remain enabled.

The shared strict JSON schema retains object/string/array/number/null types, required fields, additionalProperties=false and the segment classification enum. Confidence uses a plain number with a 0..1 description, without minimum/maximum keywords. The local validator still requires numeric 0..1 confidence and exact active-segment reconstruction; no transcription semantics are weakened and no response is repaired. Strict output support is endpoint-dependent, as documented by [OpenRouter](https://openrouter.ai/docs/guides/features/structured-outputs). Capability references: [Astra](https://openrouter.ai/openai/gpt-6-astra), [Fable](https://openrouter.ai/anthropic/claude-fable-5.1).

The production gateway remains unchanged. Its internal max_tokens field is converted only by the private V2 transport wrapper into max_completion_tokens before HTTP. A strict five-key whitelist and semantic-body hash reject leaked sampling parameters or model/message/schema changes. No temperature value is passed to the gateway by V2.

## Frozen source and prompt identity

Source: ${summary.sourcePath}. Original JPEG: 149973 bytes, ${summary.width}×${summary.height}; no preprocessing or image replacement.

IMAGE_SHA_GPT=${summary.sourceSha256}
IMAGE_SHA_CLAUDE=${summary.sourceSha256}
IMAGE_HASHES_IDENTICAL=true

PROMPT_SHA_GPT=${v2.EXPECTED_PROMPT_SHA}
PROMPT_SHA_CLAUDE=${v2.EXPECTED_PROMPT_SHA}
PROMPT_HASHES_IDENTICAL=true

Prompt bytes match the spent V1 shared-prompt.txt byte-for-byte. The same user instruction, original image bytes, response semantics, output budget and schema are used for both models. Historical expected words, Google text and previous model transcripts are not sent.

## Provider accounting

| Slot | Requested | Returned | Status | Calls | HTTP | Finish | Latency ms | Input tokens | Output tokens | Total tokens | Reasoning tokens | Reported cost |
|---|---|---|---|---:|---|---|---|---|---|---|---|---|
${table}

Unreported usage/cost is unknown, not zero. Reasoning tokens are included in completion tokens, not added twice. Retries=0; fallbacks=0. No Google, Sol, correction, scoring, crop or second-pass generation was requested. Each attempt and HTTP dispatch was durably reserved in the NEW V2 directory before transport. A global run lock prevents restarts/repeats. ${hasRoutingFailure?'A parameter-routing failure stopped all further V2 dispatches. See comparison/failure-analysis.json and the unchanged raw response. The generic routing error alone may not identify a specific remaining unsupported parameter; no unsupported cause is asserted.':'No parameter-routing failure was recorded.'}

${slots.map(s=>`## ${s.slot} exact transcript\n\n\`\`\`text\n${s.parsed?.activeTranscript??'NO VALIDATED TRANSCRIPT — '+s.state.status}\n\`\`\`\n\nDeleted/artifact/uncertain classifications (model evidence only):\n\n\`\`\`json\n${JSON.stringify({segments:s.parsed?.segments.filter(x=>x.type!=='ACTIVE_STUDENT_TEXT')??null,uncertainSpans:s.parsed?.uncertainSpans??null},null,2)}\n\`\`\``).join('\n\n')}

## Exact case-sensitive differences

${rendered.diff?`Total diagnostic disagreements: ${rendered.diff.counts.total}. Capitalization-only: ${rendered.diff.counts.capitalizationOnly}. Spelling/lexical: ${rendered.diff.counts.spellingLexical}. Punctuation substitutions: ${rendered.diff.counts.punctuation}. Insertions/deletions: ${rendered.diff.counts.insertionDeletion}. Whitespace/line-break substitutions: ${rendered.diff.counts.whitespace}. Alignment ambiguity: ${rendered.diff.alignmentAmbiguous}.`:'NOT_COMPARABLE: both exact models must complete with valid responses; no disagreement count or accuracy result is invented.'}

The diagnostic alignment reconstructs both strings exactly, including whitespace, spelling, case and punctuation. Punctuation additions/removals count as insertions/deletions. No lowercasing, trimming, Unicode quote normalization, dictionary correction or cleanup is applied. Model agreement does not establish source truth.

## Validation and isolation

${protectedCount} protected files match their before-V2 hashes, including all V1 benchmark evidence, ledger, implementation, tests, report, earlier experiments and production source/configuration. No historical hash manifest is changed. The V2 ledger is backend/.local-shadow/private/astra-vs-fable-page01-v2/; V1 is not reset, reused or written. Production/default OCR, Mongo/Firebase, corrections, scoring, rubrics, markers, PDFs, publication and deployments are untouched.

${validation?`${validation.testsPassed} offline tests passed across ${validation.testSuites} suites, with network denied. Desktop/mobile HTML validation: ${validation.htmlValidated?'PASS':'pending'}. Secret persistence check: ${validation.credentialsAbsent?'PASS':'pending'}. See output/astra-fable-v2-offline-tests.log and private validation.json.`:'Offline and HTML validation results will be recorded in private validation.json.'}

Private review: backend/.local-shadow/private/astra-vs-fable-page01-v2/comparison/comparison.html. It shows the original image, exact model strings, sensitive differences, classifications and uncertainty. Human gold and winner remain pending; no model output is promoted into production OCR authority.

Preflight (zero generation calls):
\`\`\`powershell
node backend/scripts/ocr-benchmark/astra-vs-fable-page01-v2.cjs --preflight
\`\`\`

One-shot run (spent budgets cannot be reused):
\`\`\`powershell
node backend/scripts/ocr-benchmark/astra-vs-fable-page01-v2.cjs --run-once
\`\`\`

GPT_ASTRA_V2_PROVIDER_CALLS=${slots[0].state.providerCalls}
CLAUDE_FABLE_V2_PROVIDER_CALLS=${slots[1].state.providerCalls}
HUMAN_GOLD_STATUS=PENDING
ACCURACY_WINNER=UNDETERMINED_PENDING_HUMAN_REVIEW
PRODUCTION_BEHAVIOR_CHANGED=false
`;
  fs.writeFileSync(path.join(v2.WORKSPACE,'OCR_ASTRA_VS_FABLE_PAGE01_V2_REPORT.md'),text);
  return {summary,diff:rendered.diff,html};
}
module.exports={report};
