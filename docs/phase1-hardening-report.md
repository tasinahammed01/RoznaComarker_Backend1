# CoMarker Phase 1 production hardening

Verified 2026-09-19. Scope: local implementation and regression verification. No deployment, live payment operation, or production migration was performed.

## 1. ROOT CAUSES

The pre-edit audit confirmed these execution paths:

- backend/src/config/env.js and services/payments/paymentProvider.service.js defaulted missing PAYMENT_PROVIDER to Stripe. PayPal purchase/subscription guards also contained Stripe defaults.
- app.js mounted the raw Stripe webhook router; subscription.routes.js mounted checkout-session and customer-portal. The subscription controller exposed historical Stripe billing capabilities, and usage.middleware.js granted entitlement from Stripe status/price fields.
- checkout.ts imported the Stripe loader, initialized the provider as Stripe, and used plan.paymentProvider || 'stripe'. The development environment contained a Stripe publishable key. The loader and compatibility/admin billing fields remain historical code/data; checkout no longer imports the loader.
- jwtAuth.middleware.js repaired plans for every authenticated request. Firebase login also repaired plans and shared a broad catch across provider verification and Mongo operations.
- user.controller.js finalized roles with read-then-save and marked submission feedback pending while its submission became stale after a policy change.
- connectDB dropped/created indexes and updated flashcard documents on startup. Morgan's combined access format included query-bearing URLs and Referer. Development routes were insufficiently restricted. Shutdown lacked Mongo closure, a once-only guard, and a forced deadline.

Before editing, the ensureActivePlan/req.plan search covered all backend/src. req.plan was only assigned in quota/storage middleware; no controller consumed it. Required plan resolution remains in subscription, membership, submission, credit and class-lifecycle operations and quota/storage/feature middleware. Mock-sync retains its explicit initialization only in development.

## 2. SECURITY FIXES

JWT authentication now verifies the token, loads the user, checks activity, sets req.user/req.jwt and continues. Existing invalid/expired JWT codes remain intact.

Firebase login returns:

| Boundary | HTTP | Code |
| --- | --- | --- |
| Invalid, expired or revoked token | 401 | AUTH_INVALID |
| Required email unverified | 403 | EMAIL_NOT_VERIFIED |
| Inactive local account | 403 | ACCOUNT_INACTIVE |
| Firebase Admin initialization/provider outage | 503 | AUTH_PROVIDER_UNAVAILABLE |
| Mongo lookup/create outage | 503 | AUTH_UNAVAILABLE |

Login no longer needs plan bootstrap. Client errors do not contain database/provider exception messages. Main login diagnostics record stage/event and safe error classification. Revocation checks remain enabled.

Role finalization uses findOneAndUpdate with {_id, role: null, isActive: true}; Mongo null matching includes an unset role. Only teacher/student are accepted. The winner returns a JWT signed from the persisted document and invokes the existing onboarding bonus once. Concurrent losers receive ROLE_ALREADY_FINALIZED. Existing finalized roles cannot switch. Tests exercise a real Mongo race and assert one winner/one bonus invocation.

Policy propagation uses class/submission cursors and batches of at most 200 submission records. Both records become stale. Existing evaluation hashes, scores, detailed feedback, OCR and corrections are retained. Teacher overrides are excluded, and current-policy results are guarded against stale propagation. Existing canonical result reads still determine freshness, detailed-feedback staleness and evaluation-only retry. Profile save launches no OCR, correction or grade recalculation.

Mock-sync, jwt-test and Swagger are mounted only in development. Shutdown runs once, stops new HTTP acceptance, drains requests for up to 5 seconds, closes remaining ordinary HTTP/SSE connections, then closes browser/Mongo. A 10-second overall forced deadline bounds hung cleanup. Fatal errors/rejections use a failure exit status.

## 3. AUTH PERFORMANCE BEFORE/AFTER

Counts below are source-derived database operations for the authentication stage, supported by the JWT regression's single User.findById and zero plan-resolver calls. They are not a production latency benchmark.

| Typical authenticated request | Before | After |
| --- | --- | --- |
| Existing Free teacher, valid stored plan | 1 User + 2 Plan reads | 1 User read |
| Paid PayPal teacher, matching plan | 1 User + 2 Plan reads | 1 User read |
| Teacher missing a plan | 1 User + 1 Free Plan read + 1 repair write | 1 User read, 0 repair writes |

The first two cases remove 2 of 3 authentication reads (67%). Legacy Free-plan name fallback can add another old read. A plan-limited request still resolves/enforces its plan; it avoids the formerly duplicated authentication-side resolution. Ordinary class-list reads no longer mutate expired plans; subscription/limited operations enforce expiry when required.

## 4. PAYMENT PROVIDER CONTRACT

PAYMENT_PROVIDER must explicitly resolve to paypal (trimmed, case-normalized). Missing, empty, Stripe and unknown values fail closed. Production startup retains the existing PayPal configuration checks.

Stripe webhook, checkout-session and customer-portal routes are unmounted. The exported Stripe client and legacy provider adapter throw controlled disabled errors. Subscription capabilities report PayPal only. Legacy Stripe status cannot grant a paid plan; valid PayPal entitlement retains precedence.

Frontend checkout requires explicit paypal metadata. Missing/unknown/Stripe metadata produces the existing sanitized checkout-unavailable state, without loading Stripe or creating a session. The unused development Stripe key is empty. User/Plan historical Stripe fields, payment history and admin compatibility fields were not deleted. No billing-data migration occurred. PayPal creation, change-plan, cancellation, paid-through entitlement and top-ups passed relevant regression suites.

## 5. DATABASE STARTUP/MIGRATION CHANGE

connectDB connects with autoIndex:false and autoCreate:false and reads index definitions. Missing/incompatible required flashcard indexes fail startup with the migration command. Startup performs no schema/index/data mutations.

The explicit migration preflights duplicate keys, inspects existing shapes, replaces incompatible indexes of the expected key shape, creates missing required indexes, unsets only null shareToken fields, and verifies the result. An unexpected index name/key collision fails for review. Re-running does not recreate already-correct indexes. A real isolated Mongo test runs it twice, retains document contents, and checks both self-study and assignment uniqueness scopes.

Exact command, from backend:

~~~sh
npm run migrate:flashcard-indexes
~~~

On this Windows workstation the equivalent launcher is npm.cmd. It uses MONGO_URI from the selected process environment/backend .env. The script was tested only against isolated in-memory MongoDB; it was not run against the configured deployment database.

## 6. SSE SECURITY

Application access logs include method, path, status, size and duration. They omit the entire query string, Authorization and Referer. Tests prove sseToken and long-lived tokens cannot enter that access format while the handler still receives the unchanged URL/query.

The existing SSE token remains 60-second, one-time, in-memory storage. This is a single-instance design: token issuance and stream connection must reach the same process. Restarts invalidate outstanding tokens. No Redis/dependency was added.

Reverse-proxy access logs are outside Express and must use a query-free format too. Example Nginx http-level format and API server-level access log:

~~~nginx
log_format comarker_safe '$remote_addr [$time_local] "$request_method $uri $server_protocol" $status $body_bytes_sent $request_time';
access_log /var/log/nginx/comarker.access.log comarker_safe;
~~~

Do not include $request, $request_uri, $args, $http_authorization or $http_referer in that access format. Inspect the deployed proxy/CDN configuration; no deployed proxy configuration was available or changed in this workspace.

## 7. FILES CHANGED

29 existing files changed; 15 source/test files added, plus this report. No assessment/rubric/draft-comparison algorithm or credit-business-rule file was modified.

### Modified

- backend/package.json
- backend/src/app.js
- backend/src/config/db.js
- backend/src/config/env.js
- backend/src/controllers/subscription.controller.js
- backend/src/controllers/user.controller.js
- backend/src/middlewares/firebaseAuth.middleware.js
- backend/src/middlewares/jwtAuth.middleware.js
- backend/src/middlewares/usage.middleware.js
- backend/src/routes/auth.routes.js
- backend/src/routes/subscription.routes.js
- backend/src/routes/user.routes.js
- backend/src/server.js
- backend/src/services/payments/paymentProvider.service.js
- backend/src/services/paypal/paypalPurchase.service.js
- backend/src/services/paypal/paypalSubscription.service.js
- backend/src/services/stripe.service.js
- backend/tests/paypal.foundation.test.js
- backend/tests/paypal.subscription.management.test.js
- backend/tests/paypal.subscription.phase2.test.js
- backend/tests/planEntitlementResolution.test.js
- backend/tests/security.phase4.auth.test.js
- backend/tests/security.phase4.env.test.js
- backend/tests/security.phase4.firebase.test.js
- backend/tests/subscription.usage.test.js
- backend/tests/user.profile.test.js
- RoznaComarker/src/app/pages/checkout/checkout.spec.ts
- RoznaComarker/src/app/pages/checkout/checkout.ts
- RoznaComarker/src/environments/environment.ts

### Added

- backend/src/services/flashcardIndexContract.service.js
- backend/src/services/shutdown.service.js
- backend/src/middlewares/accessLog.middleware.js
- backend/scripts/migrateFlashcardIndexes.js
- backend/tests/helpers/phase1Setup.js
- backend/tests/phase1.accessLog.test.js
- backend/tests/phase1.dbStartup.test.js
- backend/tests/phase1.entitlement.test.js
- backend/tests/phase1.firebaseInit.test.js
- backend/tests/phase1.migration.test.js
- backend/tests/phase1.migrationMongo.test.js
- backend/tests/phase1.provider.test.js
- backend/tests/phase1.role.test.js
- backend/tests/phase1.routes.test.js
- backend/tests/phase1.shutdown.test.js
- backend/docs/phase1-hardening-report.md

Saved pre-edit copies and review artifacts are under tmp/phase1-baseline, tmp/phase1.diff, tmp/phase1-stat.txt and tmp/phase1-files.json. These are local review evidence, not deployment files.

## 8. TEST COMMANDS + EXACT RESULTS

Final combined backend command, run from backend:

~~~powershell
npm.cmd test -- --setupFilesAfterEnv ./tests/helpers/phase1Setup.js --runTestsByPath tests/security.phase4.firebase.test.js tests/security.phase4.auth.test.js tests/security.phase4.env.test.js tests/phase1.shutdown.test.js tests/phase1.migration.test.js tests/phase1.role.test.js tests/phase1.entitlement.test.js tests/phase1.accessLog.test.js tests/phase1.provider.test.js tests/phase1.dbStartup.test.js tests/phase1.firebaseInit.test.js tests/phase1.routes.test.js tests/user.profile.test.js tests/subscription.usage.test.js tests/paypal.subscription.phase2.test.js tests/paypal.subscription.management.test.js tests/paypal.orders.phase4.test.js tests/paypal.cancellation.entitlement.test.js tests/canonicalResultState.test.js tests/paypal.foundation.test.js tests/paypal.bootstrap-validation.test.js tests/phase1.migrationMongo.test.js tests/authorization.phase1.test.js tests/firebaseUserLifecycle.test.js tests/paypal.production-readiness.phase5.test.js tests/roleOnboarding.test.js tests/planEntitlementResolution.test.js
~~~

Result: 27 suites passed; 336 tests passed; 0 failed; 0 snapshots. Time: 80.74 seconds. Confirmed npm/Jest exit code: 0 (tmp/phase1-backend-exit.txt). Log: ../../tmp/phase1-backend-final.log relative to this report's directory.

The final PowerShell wrapper explicitly captured $LASTEXITCODE and exited with that value; Jest writes routine output to stderr, which otherwise made the earlier wrapper report a NativeCommandError despite passing tests.

Focused suites ran before the combined run. Initial failures exposed old assertions about authentication plan repair, Firebase response shapes, Stripe entitlement, PayPal checkoutAttemptId, and cancellation's preserved history. Assertions were updated to the requested/current verified behavior; no tests were disabled. A missing local Vision credential initially blocked app imports. The scoped phase1Setup helper mocks only the unrelated Vision OCR module for these non-OCR suites; it does not mock authentication, PayPal entitlement, profile propagation or Mongo atomic updates.

Frontend command, run from RoznaComarker:

~~~powershell
npm.cmd test -- --watch=false --browsers=ChromeHeadlessCI --include=src/app/pages/checkout/*.spec.ts --include=src/app/auth/*.spec.ts --include=src/app/api/subscription-api.service.spec.ts
~~~

Result: 95 successful, 3 pre-existing pending/skipped change-plan tests, 0 failed (98 discovered). Log: tmp/phase1-frontend-ci.log at workspace root. Standard ChromeHeadless initially failed to launch its GPU process; the repository's existing ChromeHeadlessCI launcher succeeded. No skip was added.

node --check was run individually on all 40 changed/new backend JavaScript files: all passed. Evidence: tmp/phase1-syntax.json.

Requested git diff --check, git diff --stat and git diff --name-only could not operate because .git is empty and this workspace has no valid Git repository metadata. No repository was initialized or history invented. As a substitute, git diff --no-index reviewed every saved baseline/current pair and every new file. Whitespace checks passed, accepting the repository's existing CRLF line endings. Evidence: tmp/phase1-diff-check.txt and tmp/phase1-stat.txt. This cannot establish differences against a remote branch or pre-session commits.

Required regression coverage:

| Requirement | Evidence |
| --- | --- |
| Missing provider cannot become Stripe; explicit PayPal production works | phase1.provider, security.phase4.env |
| Stripe webhook/checkout/portal unavailable | phase1.routes, phase1.provider |
| Frontend has no Stripe fallback | checkout.spec (missing, Stripe, unknown metadata) |
| Ordinary auth performs no plan repair | security.phase4.auth, subscription.usage |
| Free/paid PayPal and quota enforcement | phase1.entitlement, planEntitlementResolution, paypal.cancellation.entitlement |
| Invalid/revoked Firebase token returns 401 | security.phase4.firebase |
| Valid token followed by Mongo failure returns 503 | security.phase4.firebase |
| Firebase initialization outage returns 503 | phase1.firebaseInit |
| Inactive account returns 403 | security.phase4.auth, security.phase4.firebase |
| Atomic role winner, persisted JWT role, one bonus invocation | phase1.role, roleOnboarding |
| Canonical stale state and manual-override preservation | user.profile, canonicalResultState |
| No startup mutation; idempotent migration and real unique-index behavior | phase1.dbStartup, phase1.migration, phase1.migrationMongo |
| Access logs omit SSE/JWT credentials | phase1.accessLog |
| Production mock-sync and jwt-test unavailable | phase1.routes |
| Server/browser/database closure, draining and forced deadline | phase1.shutdown |

## 9. BUILD RESULT

~~~powershell
npm.cmd run build:prod
~~~

Production Angular build passed (71.383 seconds). Output: RoznaComarker/dist/rozna-comarker-fe. Existing worksheet-viewer CSS budget and CommonJS optimization warnings remain. The frontend source did not change after this successful build. Log: tmp/phase1-build.log.

## 10. DEPLOYMENT/MIGRATION STEPS

1. Review this patch against the real source-controlled deployment revision; this workspace's Git metadata is missing.
2. Set PAYMENT_PROVIDER=paypal explicitly in the deployment environment. Retain the existing selected PayPal credentials, product/plan mappings, redirect and webhook settings. No secret values belong in this report.
3. Back up the target database and stop application writers for the index-maintenance window. First exercise the command against a staging copy. Duplicate-data preflight failures require review; the migration never deletes duplicate documents.
4. From backend, explicitly run npm run migrate:flashcard-indexes against the intended target. This is a manual deployment step, never an application startup hook. If interrupted, inspect the error/index state and rerun during the maintenance window.
5. Verify that other existing application indexes (including billing/bonus idempotency indexes) are already provisioned; autoIndex/autoCreate are now disabled. The migration covers the flashcard indexes previously repaired by connectDB, not provisioning a new empty application database.
6. Apply and validate query-free proxy/CDN access logging. Keep SSE issuance/consumption on the same application process.
7. Deploy backend and the verified Angular artifact, start the API, and confirm startup read-only index verification passes. Smoke-test login, role selection, subscription/limits, PayPal sandbox workflows, profile policy staleness and a shutdown with an open SSE stream.

## 11. REMAINING RISKS

- Deployment proxy logs and actual target indexes/configuration were not accessible for verification. Follow the deployment steps before release.
- Full Git baseline/branch verification is unavailable in this copied workspace. The report covers observed files and saved pre-edit copies.
- Three existing frontend change-plan specs remain pending. No real Firebase/PayPal or production smoke test was performed; provider interactions in backend tests use existing mocks.
- Policy propagation has bounded Node memory but still scans relevant teacher history during profile save. On propagation failure, the saved policy hash and existing canonical reads remain authoritative; no new background propagation worker was added.
- Bonus invocation is once for competing role requests. Existing bonus idempotency/error handling is preserved; the role update and bonus service are not a new cross-service transaction, so process-crash recovery of a failed reward remains an operational concern.
- Legacy Stripe source/schema compatibility remains intentionally. Its application execution paths are disabled; historical Stripe-only users no longer gain paid entitlement from those fields.
- Existing build warnings remain; no unrelated UI/performance refactor was included.

## 12. FINAL VERDICT

GO for the Phase 1 implementation and tested local behavior. This is not a claim that the live deployment has been verified. Production rollout requires the explicit migration, target configuration/index checks, source-control review and proxy-log verification above.
