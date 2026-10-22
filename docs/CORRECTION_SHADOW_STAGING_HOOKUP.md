# Staging correction shadow hookup

This preparation is inactive by default. No provider or verifier is configured, and no production environment file is changed. It observes completed normal assignment OCR; it does not replace an upload implementation or publish grades/corrections.

## Prerequisites

Use an isolated staging deployment/database and authorized student/teacher test accounts. Review the private data-retention/access policy. A complete current OCR page must already have submission/file/page/run identity, original/prepared image SHA, exact persisted text, dimensions/orientation and known source words. The normal assignment upload path must work first.

The website's assignment upload uses multipart `files` to `POST /api/submissions/:assignmentId`; QR submission uses the same normal worker through `/api/submissions/qr/:qrToken`. Guest assignment submission also dispatches that worker. The older ad-hoc `/api/submissions/upload` creates an OcrUpload record without this stable Submission page/run contract and is intentionally not opted into this observer.

## Explicit staging configuration

Set only in staging, not production:

```text
NODE_ENV=staging
CORRECTION_PIPELINE_MODE=shadow_v15
OCR_SOURCE_MODE=legacy
```

Default/missing/unknown mode, production NODE_ENV, development and test defaults remain inactive. No real model is connected merely by setting these flags.

After receiving separate authorization for a generator's provider/model/request budget, a staging-only bootstrap can explicitly register an adapter:

```js
const hook = require('./src/services/correctionShadow/stagingHook');
hook.configureStagingAdapters({
  generator: { id: 'authorized-shadow-v15', model: 'openai/gpt-4.1-mini' },
  generate: authorizedGeneratorReturningV15Content,
  reviewers: [],
  timeoutMs: 45000
});
```

The adapter is deliberately not implemented/registered to a real provider in this phase. It must return the v15 completion string, obey its AbortSignal, and enforce the separately approved request budget; it must not retry/fallback invisibly. The existing production generator/model remains unchanged. No credential belongs in observer metadata or documentation.

There is no AI verifier connection. `verify` registration is rejected in this phase. Independent human receipts can be provided only through an explicit trusted reviewer registry/action using the phase-5 tooling, and must match the new candidate key/current source identity.

## Real lifecycle seam

`runOcrAndPersistForFiles` already loads uploaded files, processes pages, persists current-job OCR, validates source quality and runs the existing canonical correction/evaluation path. At its successful end, a staging-only guard builds immutable minimal page snapshots and calls `observeCompleted`, which delegates to phase-5 `scheduleAfterUpload` without awaiting experimental completion.

The assignment/guest/retry controller registers a staging-only response-finish gate before its unchanged background-worker dispatch. The observer consumes that gate and cannot start even a fast mocked generator until the successful HTTP response finishes. Closed/failed/missing response boundaries skip shadow work; recovery runs without a new live HTTP boundary also skip experimental capture. Shadow generation does not extend that response or hold the worker's analysis lease. It receives no live Mongoose document, score/rubric-score object, transport headers or image base64.

Snapshots use exact persisted page.text and a code-derived transcript hash, not silently substituted hybrid/human text. Stored word IDs/boxes are preserved as such; boxes are not promoted to native polygons, and ordinary OCR is not automatically independent source/classification trust. Invalid/missing/partial source provenance is skipped privately.

## Private records and currentness

The existing private `CorrectionShadowReview` model/repository is reused. Payload is select:false with a30-day TTL and no public/student route. The hook additionally checks current submission run/status, file attachment, page OCR run, source/input hashes, dimensions/orientation and exact text before every private write. Text equality against the persisted snapshot also establishes the expected transcript hash. A superseded page is discarded; records always carry their original run/hash identity.

Inspect a run only from an authorized internal staging console/storage boundary. For example, query the private model by submission and current run with an explicit `+payload` selection. Revalidate payload identity/hash against current Submission OCR pages before treating it as current; historical records are audit evidence, not current results. Do not expose a new public serializer or URL for this collection.

No generator produces a private GENERATOR_NOT_CONFIGURED state. A failed/invalid generator creates private SHADOW_UNAVAILABLE evidence where storage works. Private-write failure and skips also appear in a bounded in-memory diagnostic ring through `hook.diagnostics()`; these details are never logged to the normal student-facing application log. The ring is process-local and not durable across restart. It contains event codes, identity hashes and timings, never student text or provider secrets.

States cover SCHEDULED, SKIPPED, COMPLETED, TIMED_OUT, STALE, GENERATOR_MISSING/GENERATOR_FAILED and PRIVATE_WRITE_FAILED. Two active experimental pages are allowed. Extra admissions are skipped, not retried automatically. This is not a durable queue or automatic paid retry service.

## Inspect and human-review

Use the phase-5 private review artifact/receipt tooling documented in `CORRECTION_SHADOW_REVIEW_WORKFLOW.md`. An authorized operator may export a private review record and its authorized page image into the ignored private review root, render the local review HTML, and inspect exact source/context/edit/code and available diagnostic geometry. Do not publish that image or HTML.

Explicitly register the reviewer, then record SUPPORTED/UNSUPPORTED/UNCERTAIN actions bound to each candidateKey. Do not infer human approval from source location, geometry, generated rationale, saved benchmark matching or a test fixture. New ordinary upload source evidence has no independent source bindings by default; semantic/marker/scoring authority remains withheld until its prerequisites are independently established.

For a new fixture, separately review active transcription against the image, all correction categories/exhaustiveness, and negative/excluded controls. Use an edited draft plus an explicit hash-bound FINALIZE_HUMAN_GOLD action to freeze source/correction/negative files. No upload is auto-frozen. Unproven mapping remains MAPPING_WITHHELD.

## One future controlled real upload

1. Obtain separate authorization for the normal OCR/generation traffic and experimental request budget; this task authorized zero.
2. Configure only the isolated staging flags above and the explicitly authorized generator adapter. Confirm there is no real verifier and no publication/scoring writer in the shadow dependencies.
3. Upload ONE authorized page through the normal website assignment form. Keep the normal response and production result as the baseline.
4. After normal processing, inspect the current-run private artifact/diagnostics; verify exact page/source hashes, pending semantic state, false publication/score flags and unchanged production correction/feedback/PDF state.
5. Review source and candidates privately. Freeze gold only after explicit human completion. Keep any remaining judgments uncertain rather than forcing findings.
6. Disable the flag after the controlled attempt; inspect provider receipts/request counts according to the separately authorized budget.

## Disable / rollback

Set `CORRECTION_PIPELINE_MODE=legacy`. New snapshots/observers stop, and the hook rechecks mode before allowing private writes from pending work. Existing in-flight transport cannot be un-sent; it remains subject to its deadline/AbortSignal and must not write a completed artifact after rollback. Restart the staging process without the adapter registration to remove the connection entirely. Production rollback is simply the unchanged legacy path; there is no shadow score/public correction/PDF state to undo.

Authoritative correction/scoring/publication remains blocked. A controlled private upload can validate wiring and collect review material; it is not production readiness or a production latency/quality guarantee.
