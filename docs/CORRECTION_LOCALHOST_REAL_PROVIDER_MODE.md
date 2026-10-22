# Localhost real-one provider preflight

Setup only. Do not upload or enable provider execution while implementing/testing this mode. The ordinary command remains provider-disabled.

## Commands

From the workspace root:

```powershell
# Safe read-only credential/image inspection plus unused-ledger initialization; no provider traffic:
node backend/scripts/local-shadow/start.cjs --preflight-real-one
# Existing provider-disabled inspection mode:
node backend/scripts/local-shadow/start.cjs
# FUTURE, only after the one real upload is separately authorized and the image is supplied:
node backend/scripts/local-shadow/start.cjs --real-one
```

The real-one launcher fails closed if the image is missing or its durable budget is consumed. It does not submit anything automatically. It starts the same localhost frontend/backend, local persistent Mongo replica set and isolated upload tree as before. The ordinary mode never imports provider credentials or registers a generator. The preflight command does not install a live adapter or unlock egress.

## Credential projection, never a full environment import

The existing Vision implementation prefers GOOGLE_CLOUD_KEY_FILE and falls back to GOOGLE_APPLICATION_CREDENTIALS. Relative paths resolve against backend, with the existing leading backend/ and ./ handling. The selected file must be an existing service_account JSON with client_email and a valid private_key. Existing googleapis.com universe and oauth2.googleapis.com/token values are accepted; alternate universe/token endpoints are rejected.

The existing OpenRouter gateway uses OPENROUTER_API_KEY. Its default endpoint is https://openrouter.ai/api/v1/chat/completions. Read the ignored backend/.env only to project these credential fields. No remote Mongo URI, production Firebase settings, SMTP/payment secrets, production origins, upload paths or unrelated provider credentials are copied. Google receives only its supported key filename in the process environment. The OpenRouter key remains exclusively in the injected generator closure/private gateway env argument; it is never placed in process.env, session.json, ledger or logs. No keys are copied to another file.

## Scoped provider transport

The exact external hosts are vision.googleapis.com, oauth2.googleapis.com and openrouter.ai, HTTPS port 443 only. The annotation request uses the installed Vision SDK's /v1/images:annotate mapping; auth may use /token; shadow may use /api/v1/chat/completions. Only POST is admitted. Other endpoints/hosts/protocols, plaintext remote sockets, insecure certificate settings, hostname substitution and redirects are denied. Hostnames are not a global Internet unlock: AsyncLocalStorage capabilities distinguish Google orientation/document work from the private shadow generation. Normal production AI has no credential/capability to use OpenRouter.

Vision retains the installed ImageAnnotatorClient and application's real documentTextDetection/image preprocessing pipeline. Only this local bootstrap selects the SDK-supported REST transport (fallback:true is the SDK transport option, not another OCR provider/model), restricts features to DOCUMENT_TEXT_DETECTION and forces retry:null. This makes each real annotation HTTP dispatch countable before transport without broadly permitting gRPC/DNS IP ranges. Google authentication uses the same service account and SDK; self-signed JWT authentication may require no OAuth HTTP call. At most two token HTTP dispatches are admitted and recorded separately. Extra auth/annotation traffic fails closed.

The local Angular dev server sends a restrictive CSP so browser resources/connect/frame requests remain local; the browser cannot call Google/OpenRouter directly. Only the backend's narrow capability scopes can use the approved hosts. Loopback is retained for Mongo, API, frontend and local test infrastructure. Remote Mongo/Firebase/SMTP/payment/provider hosts remain denied.

## One-image Google policy

The normal guest form does not issue an orientation request on file selection. Its one multipart submit reaches server image preflight, which can invoke Vision orientation, then successful persisted work invokes document OCR. Maximum annotation calls: one orientation/preflight and one document OCR. A resolution/exposure/orientation failure may result in fewer calls and consumes the upload budget; do not retry automatically. There is no promise of exactly one Google request. Other Google AI/source-reader calls are not allowed; OCR_SOURCE_MODE stays legacy.

Before preflight/OCR, the normal parsed multipart file must be the sole image and match the authorized local file's SHA-256. A persistent upload reservation is made before any Vision call. Existing form/name/email, file validation and credit rules still run. A second upload is blocked even after restart. The same original hash is required before document OCR and in the shadow source identity. Local fixture plan/credit behavior is unchanged.

Each logical Vision operation and each outgoing annotation HTTP attempt has its own durable reservation. HTTP retries cannot silently spend another allowance. Authentication requests have separate capped reservations. Do not interpret pre-transport reservations as provider receipt/billing confirmation: failed DNS/TLS/HTTP attempts remain consumed. Zero network probes/catalogue/model-list calls are used for readiness.

## One shadow generation, local production AI suppression

The injected generator uses correctionUniqueSource.buildRequest (v11 source-lines prompt, v15 code-owned-category schema) and the existing aiGateway.providerAttempt for openai/gpt-4.1-mini. It does not call gateway.generate or the production analyze/category-audit path. There are no loops, retry, fallback, repair, audit, chunk generations or second model. The existing Phase-5/6 saved-content analysis applies frozen normalization-v4 and Phase-4 operative/layered authority. AbortSignal and a 45-second deadline apply. No verifier or reviewer receipt is installed.

Only in this standalone local bootstrap, loaded canonicalCorrectionsPipeline.generateAndPersist, canonicalEvaluation.generate and autoRubricDesigner.autoGenerateRubricDesignerForSubmission exports are replaced by no-op LOCAL_ONLY_SUPPRESSED results. Their implementation files and production behavior are untouched. No score, correction array, feedback or rubric is synthesized. Pending local statuses are not authoritative production assessment results. The real OCR flow still persists and reaches the existing completed-page snapshot seam after the skipped local generation attempt. Entitlement/recovery polling workers stay off. Non-upload POST operations and local PDF/practice/draft routes are blocked in real-one mode.

The Phase-6 response-finish gate is preserved. A second check requires the durable successful HTTP_RESPONSE_FINISHED event before reserving/invoking the shadow adapter. The adapter/HTTP attempt each have a separate max-one reservation. The OpenRouter key is scoped to this adapter only. Semantic, public marker, score and PDF authority remain withheld by the frozen pipeline, and no public output writer receives shadow data.

## Durable private run evidence

backend/.local-shadow/private/real-one/ contains:

- run.json: stable run ID/time, initialized once, never reset on ordinary startup.
- upload.reserved.json and logical/HTTP reservation files: exclusive-create + fsync, created before work/transport, image-hash bound.
- shadow.reserved.json and shadow-http.reserved.json: separate adapter/HTTP max-one barriers.
- google-orientation-http.reserved.json, google-document-http.reserved.json and optional google-auth-1/2.reserved.json.
- events.jsonl: projected safe timestamps, request state, HTTP status/latency, usage token counts, provider-reported numeric cost when returned, finish reason, provider/model and operation type.

Ledger errors fail closed. A failed attempt stays consumed. Missing usage/cost remains unknown, never estimated. No credential/header/image base64/transcript/raw error is written to this ledger. Public artifacts remain in the unchanged normal local path; the experimental result stays in the private CorrectionShadowReview collection. Source polygons are preserved only if actually available; boxes do not become invented polygons and cannot supply independent semantic authority.

Future timeline records UPLOAD_ACCEPTED, HTTP_RESPONSE_FINISHED, OCR_COMPLETED, SHADOW_SCHEDULED, OPENROUTER_REQUEST_STARTED/COMPLETED/FAILED and PRIVATE_ARTIFACT_COMPLETED. A private failure record may also be the terminal artifact; inspect its actual status rather than infer success from a timestamp alone. Request reservations count attempted dispatches, not guaranteed billable provider completions.

## Future operator workflow

1. Supply one newly authorized image at staging-test-data/handwritten-page-01.jpg. Preflight checks existence, nonzero bytes, JPEG/PNG/WEBP signature, exact allowed path and absence of symlink/path escape; it does not transcribe or upload. Never use Golden001 or backend/uploads.
2. Run the safe --preflight-real-one command. It must report ready and unused budget.
3. After separate authorization for the actual single integration run, start --real-one, open assignmentUrl from backend/.local-shadow/private/session.json, fill normal guest name/email, select only the authorized image and submit once.
4. Wait for the private artifact/ledger; no automatic semantic approval or human gold is produced. Inspect current source/run/hash identity and all authority flags before review. Do not retry after any preflight/OCR/generation failure.
5. Ctrl+C: disable shadow mode/egress, abort pending OpenRouter work, stop local services and retain all consumed reservations/evidence. Already-sent Google transport cannot be unsent. Do not restart expecting fresh budget.

## Explicit reset after a finished run only

There is no reset flag or automatic cleanup. First finish the test and human/operator evidence review, stop all local services and confirm the exact real-one ledger directory is inside backend/.local-shadow/private. Archive that exact directory to a distinct verified child of the same private root, retaining all reservation/evidence files. Verify source and destination absolute paths and absence of junction/symlink redirection before any move. Do not delete .local-shadow to bypass a consumed budget. Only a separately authorized new run may create a new unused ledger afterward. Reset was not performed during setup.
