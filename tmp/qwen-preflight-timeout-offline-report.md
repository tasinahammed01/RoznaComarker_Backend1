# Qwen preflight timeout: offline change report

LIVE_AI_CALLS=0. No credential-file edits, production-data changes, commit, push or deployment.

## Findings and limits

The source reader hardcoded a 180000ms attempt deadline and 16000 output tokens. Preflight did not forward browser cancellation. Failure diagnostics collapsed cancellation/deadline into REQUEST_ABORTED and omitted transport phase/timings. The observed 180731ms abort is consistent with that deadline; retained incident logs cannot prove whether connection, queue, headers, body generation, reasoning or output size consumed the time.

A separate proven retry bug existed: direct providerAttempt propagates native fetch errors, whereas the source failure mapper only recognized wrapped AI errors. Known transient socket/connect/header/body errors now remain retryable service failures, including nested causes. Certificate and configuration failures are not reclassified as transient.

Current public OpenRouter Qwen metadata advertises optional reasoning, default xhigh and supported effort none. The Qwen exact-source profile now sends reasoning.effort=none and provider.sort=latency, retaining require_parameters=true, allow_fallbacks=false, exact identity, strict JSON Schema and redirect rejection. No provider is pinned without latency evidence; no capability downgrade or automatic second call is added.

References checked without inference:
- https://openrouter.ai/api/v1/models
- https://openrouter.ai/api/v1/models/qwen/qwen3.8-27b/endpoints
- https://openrouter.ai/docs/guides/routing/provider-selection
- https://openrouter.ai/docs/guides/best-practices/reasoning-tokens

## Limits

| Setting | Before | After |
|---|---|---|
| Qwen attempt | 180000ms hardcoded | 120000ms default; OCR_GPT_VISION_ATTEMPT_TIMEOUT_MS accepts integer 100000..180000 |
| Source preflight request | No explicit overall deadline | 210000ms from middleware entry |
| Browser source request | 240000ms | 240000ms; explicit blocked retryable timeout result |
| Output ceiling | 16000 | 16000, unchanged |
| Image preparation | Orientation only | Unchanged, no lossy resizing |

A historical authorized Qwen synthetic diagnostic completed in 44075ms; the user also requires preserving valid 90-second reads. A mocked 90000ms response passes the new default. This is limited evidence, not a latency percentile or production SLA. The upper override preserves the prior 180-second attempt allowance. Long pages may still need it.

Do not infer a smaller output budget from image dimensions or a short essay: the schema includes repeated transcript/segments, exclusions and uncertainty records. There is insufficient evidence to safely reduce the 16000 ceiling. Truncated responses remain rejected.

For PDFs, a fresh paid page is deferred when less than its full attempt allowance remains. Completed pages remain cached; an explicit retry resumes unchecked pages without buying accepted pages again. An in-flight provider receives an abort signal on the local deadline or browser disconnect. Local abort does not prove remote billing stopped.

## Production changes (workspace-relative paths and first relevant line)

| File | Line | Change |
|---|---:|---|
| backend/src/services/gptVisionExact/contract.js | 16 | Bounded Qwen attempt policy and shared preflight deadline |
| backend/src/services/gptVisionExact.service.js | 6 | Qwen deadline selection, native transient error mapping, cancellation classification, safe failure/success metrics |
| backend/src/services/aiGateway.service.js | 389 | Phase/elapsed/usage diagnostics, timeout origin; Qwen-only reasoning/routing at 429; HTTP errors before source identity validation |
| backend/src/services/aiRequestDiagnostics.service.js | 8 | Content-free timing, transport-phase and numeric usage allowlists |
| backend/src/services/gptVisionExact/preflight.js | 55 | Admission cleanup on failure; signal/deadline propagation and safe PDF deferral at 87 |
| backend/src/services/sourceVerificationPolicy.js | 8 | Cancelled source evidence can retry under existing cooldown/cap |
| backend/src/services/sourceVerificationCircuit.service.js | 25 | User cancellation releases resources without declaring provider failure/recovery |
| backend/src/middlewares/imagePreflight.middleware.js | 44 | Request abort/deadline propagation and listener/timer cleanup |
| backend/src/services/submissionProgress.service.js | 23 | Indeterminate source stage |
| backend/.env.example | 54 | Document optional bounded attempt setting; credential-bearing .env unchanged |
| RoznaComarker/src/app/services/image-preflight.service.ts | 32 | Coordinated browser margin and blocked service timeout result |
| RoznaComarker/src/app/components/analysis-progress/analysis-progress.ts | 7 | Indeterminate display/accessibility; hide legacy preflight percentages |

OCR prompt, schema, exact reconstruction, confidence gates, accepted-source binding/cache, page/hash/word mappings and image bytes remain unchanged. Gemini corrections, Astra scoring/credits and Claude teacher comments were not modified.

## Focused validation

297 distinct backend tests passed across focused runs in 14 suites. 34 distinct frontend tests passed; production Angular build passed with existing component-style-budget/CommonJS warnings. Node syntax, focused ESLint and diff whitespace checks passed.

New/updated tests:
- backend/tests/qwenPreflightDeadline.test.js: deterministic 90-second success, exact 120-second abort, pre-header/body stalls, timing separation, cancellation, capability failure, HTTP-200 provider error, truncation usage, failure persistence and native transient causes.
- backend/tests/sourcePreflightCancellation.test.js: overall deadline and browser-close propagation/listener cleanup.
- backend/tests/gptSourcePreflight.test.js: cancelled/deadline PDF evidence, slot release, cooldown/retry/cache reuse, persistence-failure release and deferral with insufficient remaining time.
- backend/tests/qwenSourceReader.test.js: strict Qwen routing/reasoning request.
- backend/tests/submissionProgress.test.js: indeterminate source status.
- backend/tests/aiRequestDiagnostics.test.js: stale mock endpoint/returned-model fixtures updated to satisfy existing strict authority checks; no validator relaxed.
- RoznaComarker/src/app/services/image-preflight.service.spec.ts: browser timeout abort and same-file retry.
- RoznaComarker/src/app/components/analysis-progress/analysis-progress.spec.ts: no percent or determinate ARIA value during preflight.
- RoznaComarker/src/app/pages/students/my-class-student-pages/detail-my-class-student-pages/upload-essay-form/upload-essay-form.spec.ts: legacy percentage expectation updated; blocking, retry, cancellation and duplicate-click coverage preserved.

Unmodified focused regression suites also passed: gptVisionUncertaintyV2, gptVisionExactVision, gptVisionExact, imagePreflight.routes, deepseekSourceReader, geminiCorrectionMigration, aiGateway and sourceFidelityTransport.

No real-traffic success or latency improvement is claimed. A separately authorized live source-verification test is still required to measure successful OCR latency, reasoning suppression, fidelity and actual cost. Queue versus connection delay is unobservable before headers without more provider telemetry; the new diagnostics report that uncertainty rather than guessing.
