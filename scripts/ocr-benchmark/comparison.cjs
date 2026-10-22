'use strict';
const fs=require('fs'),path=require('path');
const core=require('./benchmark-core.cjs');
const {align,difference}=require('../local-shadow/source-fidelity-v2.cjs');
function exactTokens(text) {
  return [...text.matchAll(/\s+|[\p{L}\p{M}\p{N}]+|[^\s\p{L}\p{M}\p{N}]/gu)].map(m=>({text:m[0],start:m.index,end:m.index+m[0].length}));
}
function compare(left,right) {
  const a=exactTokens(left),b=exactTokens(right),aligned=align(a,b);
  const counts={total:0,capitalizationOnly:0,spellingLexical:0,punctuation:0,insertionDeletion:0,whitespace:0};
  const operations=aligned.operations.map(op=>{
    const l=op.googleIndex===null?null:a[op.googleIndex],r=op.solIndex===null?null:b[op.solIndex];
    let category='EXACT';
    if(!op.exact) {
      counts.total++;
      if(!l||!r) {category='INSERTION_DELETION';counts.insertionDeletion++;}
      else if(/^\s+$/u.test(l.text)||/^\s+$/u.test(r.text)){category='WHITESPACE';counts.whitespace++;}
      else if(difference(l.text,r.text)==='CASE_ONLY'){category='CAPITALIZATION_ONLY';counts.capitalizationOnly++;}
      else if(/^[\p{P}\p{S}]+$/u.test(l.text)||/^[\p{P}\p{S}]+$/u.test(r.text)){category='PUNCTUATION';counts.punctuation++;}
      else {category='SPELLING_LEXICAL';counts.spellingLexical++;}
    }
    return {left:l,right:r,category,ambiguous:op.ambiguous};
  });
  if(operations.map(o=>o.left?.text??'').join('')!==left||operations.map(o=>o.right?.text??'').join('')!==right) throw Error('DIFF_RECONSTRUCTION_FAILED');
  return {caseSensitive:true,normalization:'NONE',diagnosticOnly:true,providerAgreementIsNotGold:true,counts,operations,
    alignmentAmbiguous:operations.some(o=>o.ambiguous),leftSha256:core.sha(left),rightSha256:core.sha(right)};
}
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function report({directory=core.DIRECTORY,writeRoot=true,checkIntegrity=true}={}) {
  const image=core.source();
  const identity=fs.existsSync(path.join(directory,'benchmark-identity.json'))?core.read(directory,'benchmark-identity.json'):null;
  let configured=null;try{configured=core.loadConfiguration().models;}catch{}
  const states=core.SLOTS.map(slot=>{
    const d=path.join(directory,slot),file=path.join(d,'result.json');
    const state=fs.existsSync(file)?core.read(d,'result.json'):{status:fs.existsSync(path.join(d,'attempt.json'))?'INTERRUPTED':'NOT_RUN',
      requestedModel:identity?.requestedModels?.[slot]??configured?.[slot]??null,returnedModel:null,providerCalls:Number(fs.existsSync(path.join(d,'transport.json'))),usage:null};
    const parsed=fs.existsSync(path.join(d,'parsed-response.json'))?core.read(d,'parsed-response.json'):null;
    let providerFailure=null;
    if(state.status==='FAILED'&&fs.existsSync(path.join(d,'raw-transport-response.txt'))) {
      try {
        const error=JSON.parse(fs.readFileSync(path.join(d,'raw-transport-response.txt'),'utf8')).error;
        if(error) providerFailure={code:error.code??null,message:typeof error.message==='string'?error.message:null,
          failedRoutingStep:error.metadata?.failed_routing_step??null};
      } catch {}
    }
    return {slot,state,parsed,providerFailure};
  });
  const comparable=states.every(s=>s.state.status==='COMPLETE'&&s.parsed);
  const diff=comparable?compare(states[0].parsed.activeTranscript,states[1].parsed.activeTranscript):null;
  const protectedCount=checkIntegrity?core.assertSnapshot(core.read(directory,'protected-baseline.json')):null;
  const summary={sourcePath:image.file,sourceSha256:image.sha256,width:image.width,height:image.height,promptSha256:core.PROMPT_SHA,
    promptBytesIdentical:true,sourceImageBytesIdentical:true,models:states.map(s=>({slot:s.slot,...s.state,providerFailure:s.providerFailure})),disagreements:diff?.counts??null,
    HUMAN_GOLD_STATUS:'PENDING',ACCURACY_WINNER:'UNDETERMINED_PENDING_HUMAN_REVIEW',SOURCE_FIDELITY_GPT_ASTRA:'PENDING_MANUAL_REVIEW',
    SOURCE_FIDELITY_CLAUDE_FABLE:'PENDING_MANUAL_REVIEW',productionBehaviorChanged:false,protectedFileCount:protectedCount};
  const write=(name,data)=>fs.writeFileSync(path.join(directory,'comparison',name),typeof data==='string'?data:JSON.stringify(data,null,2)+'\n',{mode:0o600});
  write('exact-diff.json',diff??{status:'NOT_COMPARABLE',reason:'Both exact requested models must complete successfully.',normalization:'NONE'});
  write('benchmark-summary.json',summary);
  const renderDiff=side=>diff?diff.operations.map(o=>o[side]?`<span class="${o.category}" title="${escape(o.category+(o.ambiguous?' · ambiguous diagnostic alignment':''))}">${escape(o[side].text)}</span>`:'').join(''):'Not available until both exact requested models complete.';
  const originalRelative=path.relative(path.join(directory,'comparison'),image.file).split(path.sep).join('/');
  const details=states.map(({slot,state,parsed,providerFailure},i)=>`<section class="model"><h2>${i===0?'GPT Astra':'Claude Fable 5.1'}</h2>
    <p><strong>${escape(state.status)}</strong> · Requested: <code>${escape(state.requestedModel??'MISSING')}</code><br>Returned: <code>${escape(state.returnedModel??'not returned')}</code></p>
    ${providerFailure?`<p class="notice"><strong>Provider rejection:</strong> ${escape(providerFailure.message)}<br>Routing stage: ${escape(providerFailure.failedRoutingStep??'not reported')}. The request is consumed; no retry was made.</p>`:''}
    <h3>Exact active transcript</h3><pre>${escape(parsed?.activeTranscript??'NO VALIDATED TRANSCRIPT')}</pre>
    <details><summary>Deleted / artifact classifications and uncertainty</summary><pre>${escape(JSON.stringify({segments:parsed?.segments.filter(s=>s.type!=='ACTIVE_STUDENT_TEXT')??null,uncertainSpans:parsed?.uncertainSpans??null},null,2))}</pre></details>
    <details><summary>All segments, confidence (not truth), model metadata and cost</summary><pre>${escape(JSON.stringify({state,segments:parsed?.segments??null},null,2))}</pre></details></section>`).join('');
  const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
    <title>Private handwriting comparison · Astra vs Fable</title><style>
    *{box-sizing:border-box}body{margin:0;background:#f1f4f7;color:#17263b;font:16px/1.6 system-ui,sans-serif;overflow-wrap:anywhere}
    main{max-width:1500px;margin:auto;padding:24px}header,section{background:white;border:1px solid #cbd5e0;border-radius:12px;padding:22px;margin-bottom:20px}
    h1,h2,h3{line-height:1.3}h3{font-size:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:17px/1.7 ui-monospace,monospace}
    .columns{display:grid;grid-template-columns:1fr 1fr;gap:20px}.original{max-width:100%;height:auto}summary{cursor:pointer;padding:12px;background:#edf2f7}
    summary:focus-visible,a:focus-visible{outline:3px solid #225ee2;outline-offset:3px}.CAPITALIZATION_ONLY{background:#ffe78a;border-bottom:2px solid #865c00}
    .SPELLING_LEXICAL{background:#ffd4e0}.PUNCTUATION{background:#beeafc}.INSERTION_DELETION{background:#dcd0ff;text-decoration:underline}
    .WHITESPACE{background:#c8ead9;outline:1px dotted #217349}.notice{border-left:4px solid #876000;padding-left:14px}
    @media(max-width:800px){main{padding:10px}.columns{grid-template-columns:1fr}section,header{padding:16px}}
    </style><main><header><h1>Exact handwriting · GPT Astra vs Claude Fable 5.1</h1><p class="notice"><strong>Human gold: PENDING. Accuracy winner: UNDETERMINED_PENDING_HUMAN_REVIEW.</strong> Cleaner English and model confidence do not establish fidelity. Agreement can be jointly wrong. Only manual comparison with the original pixels can adjudicate accuracy.</p>
    <p>Source SHA: <code>${image.sha256}</code><br>Identical prompt SHA: <code>${core.PROMPT_SHA}</code><br>Original ${image.width}×${image.height} image, unchanged bytes; no preprocessing.</p>
    <p>Provider states: ${states.map(s=>`${escape(s.slot)}: ${escape(s.state.status)}`).join(' · ')}. No retries or fallbacks.</p>
    <p>Review especially: capitalization, misspellings, punctuation, deleted-text leakage, repetitions, grammar cleanup, inserted and omitted words. No historical candidate readings were sent to either provider.</p></header>
    <section><h2>Original image · source authority</h2><a href="${escape(originalRelative)}"><img class="original" src="${escape(originalRelative)}" width="${image.width}" height="${image.height}" alt="Original handwritten student page, unchanged"></a></section>
    <div class="columns">${details}</div><section><h2>Exact case-sensitive diff · diagnostics only</h2>
    <p><span class="CAPITALIZATION_ONLY">Capitalization</span> · <span class="SPELLING_LEXICAL">Spelling / lexical</span> · <span class="PUNCTUATION">Punctuation</span> · <span class="INSERTION_DELETION">Insertion / deletion</span> · <span class="WHITESPACE">Whitespace / line breaks</span></p>
    <p>${escape(JSON.stringify(diff?.counts??{status:'NOT_COMPARABLE'}))}</p><div class="columns"><div><h3>GPT Astra</h3><pre>${renderDiff('left')}</pre></div><div><h3>Claude Fable 5.1</h3><pre>${renderDiff('right')}</pre></div></div>
    <p>Deterministic monotonic token alignment preserves every character and whitespace token. Ambiguous alignments are diagnostic only. No normalized string or corrected transcript is generated.</p></section></main></html>`;
  write('comparison.html',html);
  const row=(label,fn)=>`| ${label} | ${fn(states[0])??'not reported'} | ${fn(states[1])??'not reported'} |`;
  const table=[
    row('Requested model',s=>s.state.requestedModel),row('Returned model',s=>s.state.returnedModel),row('Status',s=>s.state.status),
    row('Prompt SHA',()=>core.PROMPT_SHA),row('Image SHA',()=>image.sha256),row('Generation attempts',s=>s.state.providerCalls),
    row('HTTP status',s=>s.state.httpStatus),row('Finish reason',s=>s.state.finishReason),row('Latency ms (monotonic)',s=>s.state.latencyMs),
    row('Input tokens',s=>s.state.usage?.prompt_tokens),row('Output tokens',s=>s.state.usage?.completion_tokens),row('Total tokens',s=>s.state.usage?.total_tokens),
    row('Reasoning tokens (included in output)',s=>s.state.usage?.reasoning_tokens),row('Provider-reported cost',s=>s.state.usage?.cost),
    row('Retries',()=>0),row('Fallbacks',()=>0),row('Error code',s=>s.state.errorCode??'none')
  ].join('\n');
  const validation=fs.existsSync(path.join(directory,'validation.json'))?core.read(directory,'validation.json'):null;
  const reportText=`# Astra vs Fable — exact handwriting benchmark

Benchmark date: ${new Date().toISOString()} (UTC; operator timezone Asia/Dhaka).

## Status and limits

${states.map(s=>`${s.slot}: **${s.state.status}**`).join('; ')}. This isolated comparison never promotes model text into source authority. No human-reviewed exact transcript exists for this page in the supplied material. Prior reports, model outputs and sparse case observations are not exhaustive human gold. No accuracy winner is asserted.

${states.some(s=>s.providerFailure)?`Provider rejection details:\n\n${states.filter(s=>s.providerFailure).map(s=>`- ${s.slot}: HTTP ${s.state.httpStatus}; ${s.providerFailure.message} Routing stage: ${s.providerFailure.failedRoutingStep??'not reported'}.`).join('\n')}\n\nThe response does not identify which required parameter was unsupported. These routing failures do not establish transcription quality or prove that the model IDs are invalid. No parameters were changed and no additional generation was attempted. There are no transcripts, deleted classifications, uncertain-span results or disagreement measurements to compare from failed requests.`:''}

Source: ${image.file}

SHA-256: \`${image.sha256}\`. Dimensions: **${image.width}×${image.height}**. Both request specifications use the same original ${image.bytes.length} bytes. No preprocessing, crop, resize, rotation, enhancement, Google OCR or historical candidate text is used.

## Request and response accounting

| Field | GPT Astra | Claude Fable 5.1 |
|---|---|---|
${table}

Prompt bytes, image bytes, message content, strict semantic schema, temperature (${core.LIMITS.temperature}), maximum output budget (${core.LIMITS.maxOutputTokens}), timeout (${core.LIMITS.timeoutMs} ms) and no-retry rules are identical. Unreported usage/cost is unknown, not zero. A failed response may still be billed.

One shared STRICT_FORENSIC_HANDWRITING_PROMPT preserves the full instruction block supplied by the user, with one identical structural segment contract appended. No page-specific spelling/case examples are sent. Each prompt SHA and image SHA is checked before dispatch; complete wire messages/schema hashes are checked again at transport.

Requests use the existing aiGateway.providerAttempt directly, without its retry/fallback orchestrator. The isolated wrapper sets provider.allow_fallbacks=false and provider.require_parameters=true; unsupported parameters fail rather than creating a different experiment. These controls follow [OpenRouter provider-routing documentation](https://openrouter.ai/docs/guides/routing/provider-selection). No catalogue requests or other provider calls are made.

Every slot has exclusive-create/fsync attempt and transport reservations; a global run-once lock prevents concurrent or restarted repeats. A failed or interrupted attempt remains consumed. The process network guard independently reserves each dispatch and allows only the OpenRouter generation endpoint. Raw output is saved before schema validation, with no repair, trimming, case/spelling/punctuation transformation. Secret-bearing echoes are withheld rather than persisted.

The shared existing validator requires activeTranscript to exactly equal active line segment strings joined by newline. Deleted, uncertain and non-student segments cannot be merged by postprocessing. This checks structural consistency only; it does not prove the model visually classified handwriting correctly.

## Exact GPT Astra transcript

\`\`\`text
${states[0].parsed?.activeTranscript??'NO VALIDATED TRANSCRIPT — see status above'}
\`\`\`

## Exact Claude Fable 5.1 transcript

\`\`\`text
${states[1].parsed?.activeTranscript??'NO VALIDATED TRANSCRIPT — see status above'}
\`\`\`

## Deleted classifications and uncertainty

${states.map(s=>`### ${s.slot}\n\n\`\`\`json\n${JSON.stringify({segments:s.parsed?.segments.filter(x=>x.type!=='ACTIVE_STUDENT_TEXT')??null,uncertainSpans:s.parsed?.uncertainSpans??null},null,2)}\n\`\`\``).join('\n\n')}

## Exact disagreement summary

${diff?`Total nonmatching aligned token operations: ${diff.counts.total}. Capitalization-only: ${diff.counts.capitalizationOnly}. Spelling/lexical: ${diff.counts.spellingLexical}. Punctuation substitutions: ${diff.counts.punctuation}. Insertions/deletions: ${diff.counts.insertionDeletion}. Whitespace/line-break substitutions: ${diff.counts.whitespace}. Alignment ambiguity: ${diff.alignmentAmbiguous}.

These categories partition diagnostic edit operations; punctuation additions/removals count under insertions/deletions. Both strings reconstruct exactly from the alignment. Equality, disagreement and confidence never determine which reading matches the pixels.`:'NOT_COMPARABLE: both exact requested models have not completed with valid output. No zero-disagreement claim or accuracy inference is made.'}

## Private review and artifacts

Open backend/.local-shadow/private/astra-vs-fable-page01/comparison/comparison.html locally. It shows the unchanged full image, exact transcripts, color-coded source-sensitive differences, deleted/artifact classifications, uncertain spans, model IDs, latency and usage/cost. Raw responses and parsed evidence remain private and ignored by Git.

## Isolation and validation

${protectedCount??'Not checked in this fixture'} protected files are unchanged against the new baseline, covering production backend/frontend source/configuration and all previous private benchmark artifacts/ledgers. The operator explicitly added the two exact model variables to backend/.env before this baseline; this authorized change is recorded without modifying any historical hash manifest. No production/default OCR, upload, correction, scoring, rubric, PDF, publication, Mongo, Firebase, submission or deployment behavior is changed.

${validation?`${validation.testsPassed} offline tests across ${validation.testSuites} suites passed. ${validation.htmlValidated?'Desktop/mobile private HTML validation passed.':'HTML validation pending.'} See output/astra-fable-offline-tests.log and private validation.json.`:'Validation results will be recorded in private validation.json.'}

Added implementation files: backend/scripts/ocr-benchmark/benchmark-core.cjs, astra-vs-fable-page01.cjs, comparison.cjs, strict-forensic-prompt.txt; backend/tests/astraFableBenchmark.test.js. Existing application files modified by the agent: none.

Preflight (zero generation calls):
\`\`\`powershell
node backend/scripts/ocr-benchmark/astra-vs-fable-page01.cjs --preflight
\`\`\`

One-shot execution (consumed slots must not be rerun):
\`\`\`powershell
node backend/scripts/ocr-benchmark/astra-vs-fable-page01.cjs --run-once
\`\`\`

HUMAN_GOLD_STATUS=PENDING
ACCURACY_WINNER=UNDETERMINED_PENDING_HUMAN_REVIEW
SOURCE_FIDELITY_GPT_ASTRA=PENDING_MANUAL_REVIEW
SOURCE_FIDELITY_CLAUDE_FABLE=PENDING_MANUAL_REVIEW
PRODUCTION_BEHAVIOR_CHANGED=false
`;
  if(writeRoot) fs.writeFileSync(path.join(core.WORKSPACE,'OCR_ASTRA_VS_FABLE_PAGE01_REPORT.md'),reportText);
  console.log(`SOURCE_IMAGE_SHA=${image.sha256}`);
  states.forEach((s,i)=>{
    const prefix=i===0?'GPT_ASTRA':'CLAUDE_FABLE';
    for(const [k,val]of Object.entries({REQUESTED_MODEL:s.state.requestedModel,RETURNED_MODEL:s.state.returnedModel,PROVIDER_CALLS:s.state.providerCalls,STATUS:s.state.status,COST:s.state.usage?.cost??'not-reported'}))console.log(`${prefix}_${k}=${val}`);
  });
  console.log(`PROMPT_BYTES_IDENTICAL=true\nSOURCE_IMAGE_BYTES_IDENTICAL=true\nCASE_SENSITIVE_DISAGREEMENTS=${diff?.counts.total??'not-comparable'}\nCAPITALIZATION_ONLY_DISAGREEMENTS=${diff?.counts.capitalizationOnly??'not-comparable'}\nSPELLING_LEXICAL_DISAGREEMENTS=${diff?.counts.spellingLexical??'not-comparable'}\nPUNCTUATION_DISAGREEMENTS=${diff?.counts.punctuation??'not-comparable'}\nINSERTION_DELETION_DISAGREEMENTS=${diff?.counts.insertionDeletion??'not-comparable'}\nHUMAN_GOLD_STATUS=PENDING\nACCURACY_WINNER=UNDETERMINED_PENDING_HUMAN_REVIEW\nPRODUCTION_BEHAVIOR_CHANGED=false`);
  return {summary,diff,html};
}
module.exports={exactTokens,compare,report,escape};
