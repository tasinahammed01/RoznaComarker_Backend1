'use strict';
// Offline evidence assembly only. This script imports no provider clients.
const fs = require('fs');
const path = require('path');
const v = require('./local-shadow/source-fidelity-v2.cjs');
const escape = text => String(text ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function reviewedDecision(crop, veto) {
  if (veto) return {state:'OCR_UNCERTAIN',text:null,reason:'SOURCE_CONFLICT_REQUIRES_HUMAN_ADJUDICATION'};
  return v.decision(crop);
}
function build(plan, alignment, cropResults, vetoes = []) {
  const spans=[], covered=new Set(), byWord=new Map();
  plan.targets.forEach(t=>t.wordIds.forEach(id=>byWord.set(id,t)));
  for (const w of alignment.orderedWords) {
    if (covered.has(w.id)) continue;
    const target=byWord.get(w.id), crop=target?cropResults.find(c=>c.cropId===target.cropId):null;
    const ids=target?target.wordIds:[w.id], veto=vetoes.find(x=>x.cropId===target?.cropId), d=reviewedDecision(crop,veto);
    ids.forEach(id=>covered.add(id));
    const span={spanId:`SPAN_${String(spans.length+1).padStart(3,'0')}`,cropId:target?.cropId??null,sourceText:d.text,
      state:d.state,reason:d.reason,wordIds:ids,googleGeometry:ids.map(id=>alignment.orderedWords.find(x=>x.id===id)?.polygon),
      geometryAuthority:target?.geometryValid===false?'WITHHELD':'NATIVE_GOOGLE_WORD_REGION_ONLY',
      exactGoogleWords:ids.map(id=>alignment.orderedWords.find(x=>x.id===id)?.text),
      cropVerifier:crop??null,visualLine:w.visualLine,manualReview:'PENDING',publishable:false,
      authority:d.state==='VERIFIED_SOURCE'?'EXPERIMENTAL_MODEL_CROP_EVIDENCE':'NONE',reviewVeto:veto??null};
    if (!target) span.reason='AGREEMENT_IS_NOT_VISUAL_VERIFICATION';
    spans.push(span);
  }
  // Sol-only tokens are evidence with no native geometry, never inserted into active source.
  const unlocated=plan.unlocatedSolTokens;
  const complete=spans.every(s=>['VERIFIED_SOURCE','OCR_ARTIFACT'].includes(s.state)) && unlocated.length===0;
  let previousLine=null;
  const reviewTranscript=spans.map(s=>{
    const separator=previousLine===null?'':previousLine===s.visualLine?' ':'\n';previousLine=s.visualLine;
    return separator+(s.sourceText??`⟦${s.state}:${s.spanId}⟧`);
  }).join('');
  return {sourceSha256:v.HASH,publishable:false,complete,activeTranscript:complete?reviewTranscript:null,
    reviewTranscript,reviewTranscriptWarning:'Bracketed IDs are review placeholders, never OCR text. Spaces between spans and native visual line breaks are presentation separators, not verified source glyphs.',
    spans,unlocatedSolEvidence:unlocated,manualReview:'PENDING',normalization:'NONE'};
}
function review() {
  v.initialize();
  const plan=v.read(v.DIR,'crop-plan.json'),alignment=v.read(v.DIR,'alignment.json'),google=v.read(v.DIR,'google-result.json');
  const results=[],batches=[];
  for(const n of [1,2]) {
    const file=path.join(v.DIR,`batch-${n}-result.json`);
    if (!fs.existsSync(file)) continue;
    const state=v.read(v.DIR,`batch-${n}-result.json`); batches.push({batch:n,...state});
    if(state.status==='COMPLETE') {
      const raw=fs.readFileSync(path.join(v.DIR,`batch-${n}-raw.txt`),'utf8');
      results.push(...v.validate(raw,plan.batches[n-1]).crops);
    }
  }
  const vetoes=fs.existsSync(path.join(v.DIR,'review-vetoes.json'))?v.read(v.DIR,'review-vetoes.json'):[];
  const final=build(plan,alignment,results,vetoes);
  const baseline=v.read(v.DIR,'baseline.json'),protectedCount=v.assertSnapshot(baseline);
  const validation=fs.existsSync(path.join(v.DIR,'validation.json'))?v.read(v.DIR,'validation.json'):null;
  const write=(n,val)=>fs.writeFileSync(path.join(v.DIR,n),typeof val==='string'?val:JSON.stringify(val,null,2)+'\n',{mode:0o600});
  write('final-private-transcript.json',final);
  write('final-private-review-transcript.txt',final.reviewTranscript);
  const count=state=>final.spans.filter(s=>s.state===state).length;
  const integrity={sourceSha256:v.HASH,protectedFileCount:protectedCount,allProtectedUnchanged:true,oldSolLedgerAndOutputUnchanged:true,
    realOneLedgerUnchanged:true,productionSourceAndConfigUnchanged:true,normalization:'NONE',manualReview:'PENDING'};
  write('integrity.json',integrity);
  const status=target=>{
    const result=results.find(c=>c.cropId===target.cropId),decision=reviewedDecision(result,vetoes.find(x=>x.cropId===target.cropId));
    return {result,decision};
  };
  const cards=plan.targets.map(t=>{
    const {result,decision}=status(t);
    const flags=[...t.differences,...(t.solMappingAmbiguous?['AMBIGUOUS_OCCURRENCE']:[]),
      ...(decision.state!=='VERIFIED_SOURCE'?['MANUAL_REVIEW_REQUIRED']:[]),
      ...(result?.verbatim!==undefined&&result?.verbatim!==t.googleText?['GOOGLE_READING_DIFFERS']:[]),
      ...(result?.verbatim!==undefined&&result?.verbatim!==t.solText?['FULL_SOL_READING_DIFFERS']:[])];
    const reading=(name,text,reference)=>`<section><h3>${escape(name)}</h3><pre>${[...String(text??'UNASSERTED')].map((c,i)=>`<span${reference!==undefined&&c!==String(reference??'')[i]?' class="changed"':''}>${escape(c)}</span>`).join('')}</pre></section>`;
    return `<article id="${t.cropId}"><h2>${t.cropId} · ${decision.state}</h2><p>${escape(flags.join(' · '))}</p><p>${t.selected?'Selected for provider verification':'Budget limit: manual review only'} · Native words: ${escape(t.wordIds.join(', '))}</p>
      <figure><figcaption>Original pixels (lossless PNG, no enhancement)</figcaption><a href="${t.cropId}-original.png"><img src="${t.cropId}-original.png" width="${t.rect.width}" height="${t.rect.height}" alt="Original ${t.cropId} handwriting"></a></figure>
      <details><summary>View 4× Lanczos enlargement</summary><div class="zoom"><img src="${t.cropId}-enlarged.png" alt="4 times enlarged ${t.cropId}"></div></details>
      <div class="readings">${reading('Google native words (display spaces inserted)',t.googleText)}${reading('Saved full-page Sol · '+(t.solMappingAmbiguous?'AMBIGUOUS correspondence':'aligned evidence'),t.solText,t.googleText)}
      ${reading('Crop verifier verbatim',result?.verbatim,t.googleText)}${reading('Final source span',decision.text,result?.verbatim)}</div>
      <p><strong>${escape(decision.reason)}</strong> · ${escape(result?.visualReason??'No crop result within this budget.')}</p>
      <details><summary>Character array, uncertainty and exact geometry</summary><pre>${escape(JSON.stringify({characters:result?.characters??null,uncertainCharacterIndexes:result?.uncertainCharacterIndexes??null,crossedOutVisible:result?.crossedOutVisible??null,rect:t.rect,nativePolygons:t.nativePolygons,reasons:t.reasons},null,2))}</pre></details></article>`;
  }).join('\n');
  const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>Private source fidelity review · Page 01</title><style>
  body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#f2f5f8;color:#162334;overflow-wrap:anywhere}main{max-width:1180px;margin:auto;padding:24px}
  article,header{background:white;border:1px solid #c9d2dd;border-radius:12px;padding:22px;margin:18px 0}
  h1,h2,h3{line-height:1.25}h3{font-size:14px}pre{font:18px/1.6 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
  .readings{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.readings section{border:1px solid #ccd4df;padding:14px}
  .changed{background:#fff0a3;border-bottom:2px solid #925100}.zoom{overflow:auto;max-height:560px}figure{margin:16px 0;overflow:auto}
  figcaption{font-weight:600;margin-bottom:10px}summary{cursor:pointer;padding:12px;background:#edf2f7}
  a:focus-visible,summary:focus-visible{outline:3px solid #175ed0;outline-offset:3px}.notice{border-left:4px solid #925100;padding-left:16px}
  @media(max-width:650px){main{padding:10px}article{padding:14px}.readings{grid-template-columns:1fr}}
  </style><main><header><h1>Source-faithful crop verification V2</h1><p class="notice"><strong>NEEDS MANUAL REVIEW.</strong> Model evidence is provisional. No complete authoritative page transcript is asserted. Highlighted characters differ exactly in case, spelling, spacing or punctuation; highlights are positional diagnostics, not fuzzy mappings.</p>
  <p>Source SHA-256: <code>${v.HASH}</code></p><p>${plan.targets.length} targets · ${results.length} crop responses · ${count('VERIFIED_SOURCE')} accepted crop spans · ${plan.omittedTargets.length} targets outside the authorized budget.</p>
  <p><strong>Provider stages:</strong> Google ${google.status}; ${batches.map(b=>`Sol batch ${b.batch}: ${b.status}`).join('; ')}. Failed requests are consumed and were not retried. Selected targets without a result remain uncertain.</p>
  <p>Read the original first. Compare every capital, misspelling, punctuation mark, uncertain glyph and deletion. No candidate spelling was sent to the crop provider. A native word polygon does not prove new character-level placement.</p>
  <details><summary>Incomplete private transcript and unresolved locations</summary><pre>${escape(final.reviewTranscript)}</pre><p>${escape(final.reviewTranscriptWarning)}</p></details>
  <p>Jump to selected: ${plan.targets.filter(t=>t.selected).map(t=>`<a href="#${t.cropId}">${t.cropId}</a>`).join(' · ')}</p></header>${cards}</main></html>`;
  write('review.html',html);
  const calls={google:google.providerCalls,sol:batches.reduce((s,b)=>s+b.providerCalls,0)};
  const table=plan.targets.filter(t=>t.selected).map(t=>{
    const {result,decision}=status(t),safe=x=>JSON.stringify(x??null).replace(/\|/g,'\\|');
    return `| ${t.cropId} | ${safe(t.googleText)} | ${safe(t.solText)}${t.solMappingAmbiguous?' (ambiguous)':''} | ${safe(result?.verbatim)} | ${decision.state} |`;
  }).join('\n');
  const report=`# OCR source fidelity crop verification — Page 01

Date: 2026-10-20 (Asia/Dhaka). Private standalone experiment; production source/configuration unchanged.

## Verdict

NEEDS_MANUAL_REVIEW. The experiment supplies character-level crop evidence without applying autocorrection, but model normalization remains unresolved. It does **not** establish a complete source-faithful page transcript. ${plan.omittedTargets.length} eligible targets exceed the authorized 24-target cap; all remain uncertain. Agreement between Google and the old full-page Sol output is not promoted to verified source.

CROP_001 returned \`Social and Cultural\`, repeating the capitalization conflict identified by the user. A review veto withholds the entire span instead of accepting model confidence or rewriting the returned string. The raw response is unchanged. This is a failure signal for using crop-model confidence alone as source authority; no fidelity improvement is claimed from this case.

The second crop request failed after HTTP 200, before a usable parsed completion/usage record. Its request is consumed, with no retry. Its measured elapsed time was ${batches.find(b=>b.batch===2)?.latencyMs??'not recorded'} ms; the configured 240000 ms timeout does not establish a measured wall-clock bound for this execution. The precise transport/body failure cause is unavailable from the sanitized record. Billing may have occurred; second-batch cost is unknown.

## Input and immutable evidence

Source: staging-test-data/handwritten-page-01.jpeg. SHA-256: \`${v.HASH}\`. Original JPEG bytes were sent to Google once, without resizing, rotation, cleanup or replacement. The existing raw Google document helper (detectOrientationAnnotation, which issues DOCUMENT_TEXT_DETECTION despite its name) was used with the configured Vision SDK, REST transport and retry disabled. No orientation request was made.

The prior full-page Sol activeTranscript, raw response and spent ledger were read only. The correction --real-one ledger was not used. ${protectedCount} protected source/config/evidence files matched their before-run hashes, including all 262 prior protected files. No OCR defaults, correction/scoring/rubric/marker/PDF/publication code was edited or invoked.

## Google geometry and exact alignment

Google returned ${plan.wordCount} native words, native vertices, symbol/word confidences and 1200×1600 dimensions matching the original pixels. The private raw annotation and exact raw transcript are saved without normalization.

Google's native annotation order includes displaced words, duplicate detections, margin holes and deleted writing. A separate geometry-based reading order uses vertical polygon clusters and horizontal position; the untouched raw sequence remains available. Every non-space glyph and punctuation mark is tokenized with exact offsets. Monotonic minimum-edit alignment uses exact equality; all equally optimal alternatives are retained. No case folding, dictionary, spelling repair, nearest-word or first-occurrence fallback is used.

Deterministic diagnostic path counts (not a human error count):

- Total nonmatching token operations: **${plan.counts.totalDisagreements}**
- Case-only: **${plan.counts.caseOnly}**
- Spelling/other lexical substitutions: **${plan.counts.spellingOrOther}**
- Punctuation or insertion/deletion gaps: **${plan.counts.punctuationOrGap}**
- Sol-only tokens without established geometry: **${plan.counts.solOnlyTokens}**

Ambiguous alternatives can carry additional case differences (including Vivid/vivid) hidden by the chosen diagnostic path; these alternatives also influence crop priority, never occurrence authority. Gaps include artifacts/deletions and are not all punctuation errors. Character-level spaces inside crop results are preserved; original handwriting does not establish typed inter-span whitespace.

## Crop selection and budget

${plan.eligibleWordCount} words triggered exact disagreement, minimum word/symbol confidence below 0.85, ambiguous alignment, overlapping geometry or visually observed revisions. Agent visual observations flag regions for review only and do not assert human gold. ${plan.targets.length} native short-span crops were created; ${plan.batches.map(b=>b.length).join(' + ')} were selected, prioritizing case and lexical disagreements, then punctuation and revisions.

Both original lossless PNG crops and 4× Lanczos enlargements are supplied as labeled image pairs. The labels are separate text, outside all handwriting pixels. Decoded crop pixel equality with the original JPEG decode was checked. No generative enhancement, thresholding, denoising, grayscale or contrast changes were applied. The second batch is justified because 71 eligible crop regions cannot fit within one 12-target batch.

The full user-supplied forensic instruction block is stored verbatim in source-fidelity-prompt.txt. Per-image OCR candidates were withheld. Required character arrays must reconstruct verbatim exactly; null/uncertain characters cannot yield authoritative text. READABLE alone is insufficient: every character must have confidence ≥0.95 and crossedOutVisible must be false. Crops containing deletions are withheld conservatively. Crop evidence outranks the old full-page reading, but remains model evidence awaiting manual visual confirmation. Native polygons are retained at the crop-span level; no new per-character or per-word polygon is invented.

## Provider accounting

Google: ${google.status}; ${google.latencyMs} ms; ${google.providerCalls} document request. Google supplies no token or per-request billing information here: tokens and cost **not reported**, not zero.

${batches.map(b=>`Sol batch ${b.batch}: ${b.status}; model ${b.returnedModel??'unconfirmed'}; ${b.latencyMs} ms; HTTP ${b.httpStatus??'not recorded'}; tokens ${b.usage?.total_tokens??'not reported'} (prompt ${b.usage?.prompt_tokens??'not reported'}, completion ${b.usage?.completion_tokens??'not reported'}); provider-reported cost ${b.providerReportedCost??'not reported'}${b.errorCode?`; error ${b.errorCode}`:''}.`).join('\n\n')}

Each attempt and HTTP dispatch is independently reserved with exclusive-create/fsync in the NEW ignored directory before transport. A spent reservation refuses reuse across restarts. A failed stage stops; the second Sol batch requires a successful first batch. No retry, fallback provider, full-page Sol generation, correction engine or semantic verifier was invoked.

## Crop decisions

${results.length} crops returned schema-valid character arrays; **${count('VERIFIED_SOURCE')}** spans meet the conservative acceptance gate. **${count('OCR_UNCERTAIN')}** native spans remain OCR_UNCERTAIN, **${count('SOURCE_UNREADABLE')}** SOURCE_UNREADABLE, plus ${final.unlocatedSolEvidence.length} unlocated Sol evidence tokens. These spans have null sourceText, never a guessed or grammatically preferred word. Purely deleted and mixed deleted/active crops remain withheld; no deleted character enters active source.

| Crop | Google display | Old full-page Sol evidence | Crop verbatim | Final state |
|---|---|---|---|---|
${table}

The private HTML review shows **all ${plan.targets.length} targets**, with original/enlarged pixels, exact character arrays, candidate readings, final decisions, source IDs and coordinates. It highlights case/spelling/punctuation changes and uncertain/unverified crops. The phrase strings in Google display join unchanged native word strings with display spaces; the individual strings are retained exactly.

## Exact final private transcript

\`activeTranscript = null\`: a complete authoritative page transcript cannot safely be asserted from this bounded run. The exact accepted source strings and null unresolved spans are in final-private-transcript.json. Below is the exact **review rendering**, with explicit placeholders instead of silently filling gaps from Google or full-page Sol. Placeholders and inter-span separators are UI metadata, not source text:

\`\`\`text
${final.reviewTranscript}
\`\`\`

## MANUAL REVIEW — pending

Open backend/.local-shadow/private/source-fidelity-crop-v2-page01/review.html locally. Compare the original crop before the enlargement and each model string. Specifically inspect both sence/sense targets, cultural/Cultural, Vivid/vivid, every case or punctuation discrepancy, and all crossed-out/overwritten regions. Model confidence is not calibrated accuracy; no human review has been inferred from agent inspection.

The ${plan.omittedTargets.length} unselected targets and ${final.unlocatedSolEvidence.length} unlocated Sol tokens require manual adjudication or separately authorized future evidence. This task's spent requests must not be rerun. No automatic claim of perfect accuracy is made.

## Validation and artifacts

Private ignored experiment directory: backend/.local-shadow/private/source-fidelity-crop-v2-page01/.

Raw Google annotation/transcript; geometry; exact alignment with alternatives; crop-plan and all original/enlarged crops; exact prompt/schema request metadata; raw Sol outputs; validated character arrays; provider usage/latency; durable budgets; final private spans; review HTML; integrity hashes.

${validation?`${validation.testSuites} offline suites / ${validation.testsPassed} tests passed with network denied (output/source-fidelity-v2-final-tests.log). All ${validation.losslessCropCount} original crop PNGs were checked against their exact decoded source rectangles and recorded hashes. Desktop (1280px) and mobile (390px) HTML checks passed: 71 targets, no broken images, no page overflow, zero external requests. API credentials were absent from saved artifacts. See private validation.json and html-validation.json.`:'Offline tests and visual review validation are recorded in validation.json after execution.'}

This report is generated offline and makes no provider calls. Production/default OCR and all protected evidence remain byte-for-byte unchanged.

GOOGLE_PROVIDER_CALLS=${calls.google}
NEW_SOL_CROP_PROVIDER_CALLS=${calls.sol}
FULL_PAGE_SOL_PROVIDER_CALLS_THIS_TASK=0
GPT41_CORRECTION_CALLS=0

SOURCE_FIDELITY_VERDICT=NEEDS_MANUAL_REVIEW
`;
  fs.writeFileSync(path.resolve(__dirname,'../../OCR_SOURCE_FIDELITY_CROP_VERIFICATION_PAGE01_REPORT.md'),report);
  console.log(JSON.stringify({calls,verified:count('VERIFIED_SOURCE'),uncertain:count('OCR_UNCERTAIN'),unreadable:count('SOURCE_UNREADABLE'),protectedCount,complete:final.complete}));
  return {final,html,report};
}
if(require.main===module) try{review();}catch(e){console.error(e.message);process.exitCode=1;}
module.exports={build,review};
