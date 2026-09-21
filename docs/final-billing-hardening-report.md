# Final billing hardening report — 2026-09-20

This report distinguishes tested source changes from deployment readiness. No connected-database data, prices, indexes, PayPal resources, or production configuration were changed. Both repositories already contained uncommitted changes; those were preserved. Source changes were compared with a session-entry baseline as well as Git HEAD.

## 1. ROOT CAUSE — EMPTY CREDIT PACKS

The read-only audit reached the configured MongoDB and found **zero CreditPack records**: `EMPTY_CATALOG`, followed by `NO_FREE_ELIGIBILITY`. Its active plans are `pro_monthly`, `essential_annual`, `pro_annual`, `institution`, `free`, and `essential_monthly`. The database's production/staging identity has not been confirmed, so this is evidence about the configured database, not a claim that production was verified.

Source causes were conflicting commercial seed catalogs, insert-only seeding that did not repair existing eligibility, exact Mongo slug matching against potentially unnormalized values, and different admin/customer validation. Neither tests nor the empty database established an approved commercial price set. No price was guessed or changed. The frontend correctly distinguishes a successful empty catalog from an API failure.

## 2. P0 FIXES

Checkout and plan-change requests now carry `billingPeriod: monthly | annual`. The backend loads the Plan, validates its supported interval and price, resolves trusted environment mappings, and persists the selected interval. Combined records require an explicit period; separate monthly/annual records cannot alias the opposite interval. Attempt replay binds owner, tier, interval, and provider mapping. Browser prices and provider plan IDs cannot choose financial values.

Same-tier monthly/annual changes compare provider-plan identity rather than only Mongo slug. Reconciliation requires the exact subscription ID, target provider-plan ID, and ACTIVE status before completion. A backend-owned attempt exclusively claims either SDK transport or backend transport.

## 3. PAYPAL SUBSCRIPTION STATE MACHINE

| Stage | Result | Evidence / limitation |
|---|---|---|
| Create | FIXED | Per-user unique active-operation key, atomic claims, same-attempt recovery; missing deployed index fails closed. |
| Activate | PASS | Provider fetch-back and trusted mapping determine entitlement. Browser approval alone does not grant it. |
| Reconcile | FIXED | Exact expected target required; source-plan responses remain pending. |
| Change Plan | FIXED / REMAINING RISK | Prepared attempts proceed immediately under an atomic claim; SDK/backend cannot both own mutation. Ambiguous submitted SDK changes retain their lock and can require provider/operator reconciliation. |
| Cancel | PASS / REMAINING RISK | Provider-confirmed subscription cancellation preserves paid-through entitlement. Only unsubmitted prepared changes can be locally cancelled. Browser close is not proof of provider cancellation. |
| Expire | PASS / REMAINING RISK | Provider-confirmed terminal checkout releases the claim. Unknown creates older than the local 24-hour retry policy require review. No time-only automatic cancellation of provider resources. |
| Webhook | FIXED | Completed authorized revisions remain correlation evidence; exact fetched subscription ID checked; duplicate events remain idempotent. |

Abandoned checkout policy: reuse the existing provider subscription/approval flow for the same plan; reconcile provider truth before starting another subscription. Different-plan attempts conflict while approval remains outstanding. Time alone does not release a financial lock. `approvalExpiresAt` is informational; it does not establish that PayPal cancelled approval. The remaining operator-dependent abandonment paths must be exercised before release.

## 4. CREDIT PACK FIX

The existing database, maintained through Admin Pricing with business-approved values, is the commercial source of truth. The two scripts no longer silently seed conflicting prices. The dedicated seed helper requires an explicit catalog and preserves existing prices.

Admin writes normalize allowed slugs and apply the same active-pack purchasability rules used by customers. Invalid credit quantities, money precision, unsupported currencies, display order, and eligibility cannot be published as active personal packs. No Stripe configuration is required. Institution-only records are not converted into personal packs; existing institution credit routing is retained.

The explicit migration normalizes existing eligibility and adds Free to existing personal packs without changing prices or credit quantities. It cannot populate an empty catalog without approved commercial values. The indexed exact eligibility query remains in place.

## 5. CREDIT WALLET

Allowance refresh is calendar-month based for Free, monthly, and annual subscriptions, independent of historical Stripe dates. A persisted anchor clamps short months without drifting the original day. Legacy annual wallet end dates are shortened to the correct monthly boundary without erasing current usage. Anchor initialization reloads the wallet before deciding whether to reset.

Existing spend order remains monthly → purchased → bonus. Monthly reset preserves purchased and bonus balances. Durable debit and admin adjustment identities remain enforced. Admin retries require a client UUID, reused after response loss; reuse with a different owner, amount, reason, or admin actor conflicts.

The purchased-credit claim also checks the wallet mutation version and reloads finalized transaction state, preventing delayed workers from replaying a completed grant after its temporary receipt was cleared.

## 6. PAYPAL TOP-UP

Create order, capture validation, durable grant, webhook replay, refund, and reversal checks remain in the existing architecture. The server owns pack quantity, amount, currency, request IDs, and capture correlation. Concurrent browser/webhook processing grants once. Refunded/review states cannot be overwritten by a delayed successful-capture response. Full unused refunds reverse once; insufficient purchased balance and partial/ambiguous refunds go to review rather than negative balances.

SDK/capability failures expose the existing trusted redirect action. Capture uncertainty uses the same purchase attempt with bounded reconciliation and a Check payment control. A catalog refresh cannot discard an uncertain payment. Terminal outcomes do not trigger automatic repayment. Account wallet refresh follows confirmed success.

## 7. SECURITY FINDINGS

- **P0 fixed:** selected interval loss, premature plan-change completion, and competing provider mutation transports.
- **P1 fixed:** concurrent checkout claim, replay identity checks, durable purchase race, admin response-loss idempotency, inactive-plan recognition, Stripe-independent entitlement/reset, and active-pack publication validation.
- **P1 deployment blockers:** missing checkout lock and Plan slug indexes; unverified production catalog, production environment, and live resource mappings.
- **P2 fixed:** controlled account Plan DTO; PayPal redirect URLs reject credentials and nonstandard ports; SDK configuration ownership; safe observable pricing-publication errors.
- **P3 retained debt:** existing Mongoose deprecation warnings and frontend dependency/style-budget warnings. No new production severity claim is based solely on those warnings.

Existing authenticated ownership checks, teacher/admin role boundaries, rate limits, raw-body webhook handling, signature verification, event uniqueness/leases, and unknown-capture review behavior were preserved and covered by the selected suites. This was not a live penetration test. Historical Stripe fields remain historical compatibility data; execution stays disabled.

## 8. PERFORMANCE FINDINGS

Successful credit-idempotency and checkout-index checks are cached per database connection object instead of repeatedly querying index metadata. Failed checks are not cached. Normal server startup does not run the new migration.

Identical SDK configurations share a script/promise and reference count; incompatible active or still-loading scripts cannot be replaced. Failed loads can retry. Component retries/destruction close button instances. Existing AccountState request deduplication and pricing refresh coalescing are retained; Add Credits still fetches a fresh catalog.

Correctness adds transaction re-reads and a wallet compare-and-set to the grant path, and provider product compatibility reads to prepared changes. No latency benchmark was run. PayPal clients still commonly have request-local token caches; shared OAuth reuse is deferred because safely isolating credentials, environment, and test overrides is lower priority than the financial changes. No financial-value cache was introduced.

## 9. FILES CHANGED

The exact source/test/operator-document list for this pass is generated below. It excludes unrelated changes already present at entry and temporary logs/build output.

57 files:

```text
RoznaComarker/src/app/api/credits-api.service.spec.ts
RoznaComarker/src/app/api/credits-api.service.ts
RoznaComarker/src/app/api/plans-api.service.spec.ts
RoznaComarker/src/app/api/subscription-api.service.spec.ts
RoznaComarker/src/app/api/subscription-api.service.ts
RoznaComarker/src/app/components/credit-topup/credit-topup.html
RoznaComarker/src/app/components/credit-topup/credit-topup.spec.ts
RoznaComarker/src/app/components/credit-topup/credit-topup.ts
RoznaComarker/src/app/pages/admin/admin-credits.spec.ts
RoznaComarker/src/app/pages/admin/admin-credits.ts
RoznaComarker/src/app/pages/checkout/change-plan-checkout.spec.ts
RoznaComarker/src/app/pages/checkout/change-plan-checkout.ts
RoznaComarker/src/app/pages/checkout/checkout.spec.ts
RoznaComarker/src/app/pages/checkout/checkout.ts
RoznaComarker/src/app/pages/paypal-manage/paypal-manage.spec.ts
RoznaComarker/src/app/pages/paypal-manage/paypal-manage.ts
RoznaComarker/src/app/services/paypal-sdk-loader.service.spec.ts
RoznaComarker/src/app/services/paypal-sdk-loader.service.ts
RoznaComarker/src/app/utils/trusted-navigation.util.ts
backend/docs/final-billing-audit.md
backend/docs/final-billing-hardening-report.md
backend/package.json
backend/scripts/migrateBillingContracts.js
backend/scripts/paypal/checkConfiguration.js
backend/scripts/paypal/validateResources.js
backend/scripts/seedAssessmentCreditPacks.js
backend/scripts/seedPhase1bPricing.js
backend/scripts/verifyCreditPacks.js
backend/src/controllers/credit.controller.js
backend/src/controllers/paypalSubscription.controller.js
backend/src/controllers/paypalWebhook.controller.js
backend/src/controllers/pricingAdmin.controller.js
backend/src/controllers/subscription.controller.js
backend/src/middlewares/usage.middleware.js
backend/src/models/CreditPack.js
backend/src/models/CreditWallet.js
backend/src/models/PaymentCheckoutAttempt.js
backend/src/models/PaymentManagementAttempt.js
backend/src/models/Plan.js
backend/src/routes/credit.routes.js
backend/src/routes/subscription.routes.js
backend/src/services/credit.service.js
backend/src/services/creditPackPolicy.js
backend/src/services/durableCreditMutation.service.js
backend/src/services/paymentIndexContract.service.js
backend/src/services/paypal/paypalPlanMapping.service.js
backend/src/services/paypal/paypalPurchase.service.js
backend/src/services/paypal/paypalSubscription.service.js
backend/src/services/paypal/paypalSubscriptionManagement.service.js
backend/src/services/topup.service.js
backend/tests/assessmentCreditPackCatalog.test.js
backend/tests/billing.final-hardening.test.js
backend/tests/creditApi.test.js
backend/tests/paypal.subscription.management.test.js
backend/tests/paypal.subscription.phase2.test.js
backend/tests/planEntitlementResolution.test.js
backend/tests/pricingAdmin.test.js
```

## 10. DATABASE / INDEX CHANGES

The connected read-only audit found these required unique indexes **missing**: Plan `slug`, and PaymentCheckoutAttempt `activeOperationKey` with a string partial filter. It found the other eleven audited uniqueness contracts present: CreditPack code; CreditWallet userId; CreditTransaction idempotencyKey; checkout provider+attemptId; management provider+attemptId and activeOperationKey; purchase provider+attemptId, provider+orderId, provider+captureId; event provider+eventId; User paypalSubscriptionId. Production identity remains unverified.

`scripts/migrateBillingContracts.js` defaults to dry-run, requires `--apply --backup-confirmed` to write, and must run with billing writers stopped. Preflight rejects missing/duplicate normalized Plan slugs, unknown pack slugs, overlapping active checkout owners, duplicate index keys, and incompatible index definitions. It does not merge/delete plans or drop indexes. It accepts the existing supported sparse User subscription index.

Apply normalizes Plan/pack slugs, adds Free eligibility only to existing personal packs, backfills checkout claims, installs missing unique contracts, and adds `{active:1, allowedPlans:1, displayOrder:1}`. Existing commercial values stay unchanged. Repeated apply was tested in isolated MongoDB. Schema fields added: wallet allowance anchor; checkout claim/lease/approval timestamp; management interval, transport, and prepared state. Wallet anchors are initialized lazily.

Operator commands from `backend`:

```powershell
npm.cmd run verify:credit-packs
npm.cmd run pricing:migrate-billing
# Only after target confirmation, backup, clean preflight, and stopping billing writers:
npm.cmd run pricing:migrate-billing -- --apply --backup-confirmed
npm.cmd run verify:credit-packs
# Optional, only with an explicitly supplied teacher identifier:
npm.cmd run verify:credit-packs -- --teacher=<MongoObjectId>
```

No apply command was executed against the connected database. Both catalog diagnostics and PayPal resource diagnostics explicitly disable Mongoose index/collection creation.

## 11. PRODUCTION DATA REQUIREMENTS

Confirm which database was audited. Supply approved pack codes, names, credit quantities, prices, currencies, display ordering, and eligibility. Publish those through Admin Pricing in the intended environment. The current empty catalog cannot become purchasable through eligibility-only migration. Verify actual Free and paid teachers, and keep institution-managed teachers on their separate credit rules. Resolve duplicate/ambiguous Plan representations manually if preflight reports them.

## 12. CONFIG REQUIREMENTS

Local `npm.cmd run paypal:check` reported explicit PayPal provider, sandbox environment, sandbox client ID/secret, webhook/product IDs, all four Essential/Pro monthly/annual mappings, and trusted frontend return URL present. `PAYPAL_LIVE_ENABLED` was not enabled. Authentication was explicitly skipped. This is inventory evidence, not live production verification.

Production must explicitly select PayPal and the intended environment, supply matching-environment credentials/webhook/product/monthly and annual plan IDs, trusted HTTPS return URLs, and deliberately enable live monetary operations when ready. Use `paypal:check`, `paypal:check:auth`, and `paypal:validate-resources` with the intended environment to verify provider product, interval, currency, and price matches. No secret values are included here. No Stripe keys are required.

## 13. TEST RESULTS

Broad backend: **21 suites, 326 tests passed**. Log: `../../tmp/billing-backend-verified.log`. Run from `backend`:
```powershell
$env:PAYMENT_PROVIDER='paypal'; npm.cmd test -- --runTestsByPath tests/paypal.foundation.test.js tests/paypal.subscription.phase2.test.js tests/paypal.subscription.management.test.js tests/paypal.orders.phase4.test.js tests/paypal.production-readiness.phase5.test.js tests/paypal.cancellation.entitlement.test.js tests/paypal.bootstrap-validation.test.js tests/billing.final-hardening.test.js tests/creditService.test.js tests/creditApi.test.js tests/creditUsageNudge.test.js tests/assessmentCreditPackCatalog.test.js tests/pricingAdmin.test.js tests/pricingRealtime.test.js tests/planEntitlementResolution.test.js tests/subscription.usage.test.js tests/subscriptionStoragePersistence.test.js tests/institutionCredit.test.js tests/institutionCreditTopUp.test.js tests/phase1.entitlement.test.js tests/phase1.provider.test.js --setupFilesAfterEnv ./tests/helpers/phase1Setup.js --silent
```

After the last wallet and read-only resource-diagnostic changes: **5 suites, 121 tests passed**, including the new legacy annual-wallet regression. This overlaps the broad suite and is not an additional 121 unique tests. Log: `../../tmp/billing-latest-wallet.log`:
```powershell
$env:PAYMENT_PROVIDER='paypal'; npm.cmd test -- --runTestsByPath tests/billing.final-hardening.test.js tests/creditService.test.js tests/creditUsageNudge.test.js tests/paypal.foundation.test.js tests/paypal.production-readiness.phase5.test.js --setupFilesAfterEnv ./tests/helpers/phase1Setup.js --silent
```

Angular: **223 tests passed, zero skipped**. Run from `RoznaComarker`. Log: `../../tmp/billing-frontend-final.log`:
```powershell
npm.cmd test -- --watch=false --browsers=ChromeHeadlessCI --include='src/app/pages/checkout/*.spec.ts' --include='src/app/pages/paypal-manage/*.spec.ts' --include='src/app/components/credit-topup/*.spec.ts' --include='src/app/pages/pricing/*.spec.ts' --include='src/app/services/paypal-sdk-loader.service.spec.ts' --include='src/app/services/account-state.service.spec.ts' --include='src/app/services/pricing-catalog-state.service.spec.ts' --include='src/app/api/*-api.service.spec.ts' --include='src/app/pages/admin/admin-pricing.spec.ts' --include='src/app/pages/admin/admin-credits.spec.ts' --include='src/app/utils/trusted-navigation.util.spec.ts' --include='src/app/utils/billing-price.util.spec.ts' --include='src/app/utils/pricing-catalog-view.util.spec.ts'
```

Syntax: `node --check <file>` passed for all 35 changed backend JavaScript files, individually listed in `../../tmp/billing-syntax.log`.

Both repositories passed `git diff --check`; `git diff --stat`, `git diff --name-only`, and `git diff` were executed and inspected. Commands used per repository:
```powershell
git -c safe.directory='<absolute repository path>' -C <repository> diff --check
git -c safe.directory='<absolute repository path>' -C <repository> diff --stat
git -c safe.directory='<absolute repository path>' -C <repository> diff --name-only
git -c safe.directory='<absolute repository path>' -C <repository> diff
```

The full Git diffs include pre-existing unrelated changes. Comparison with the entry baseline separates the billing work listed above. No scoring, OCR, rubric, class, or other unrelated feature changes were made in this pass.

The backend setup file mocks the unrelated OCR client; payment/storage/state-machine code and isolated MongoDB remain exercised. No tests were newly skipped or focused. Three existing pending Angular cases were enabled using a navigation stub. Old Stripe/cancellation/catalog assertions were updated only where they contradicted the requested PayPal-only or provider-truth contract.

Earlier failures are retained in temporary logs: old-contract expectations, the corrected wallet receipt race, the corrected sparse-index preflight, and a five-second 30-purchase test timeout during simultaneous build load. The final verification result supersedes those runs without suppressing tests.

## 14. BUILD RESULT

`npm.cmd run build:prod` in `RoznaComarker` generated the production application in `dist/rozna-comarker-fe`. Existing warnings: worksheet-viewer CSS is 41.09 kB against a 32 kB warning budget; CommonJS dependencies cause optimization warnings. No theme/layout work was performed. The final native command exit code was **0**, recorded in `../../tmp/billing-build-exit.txt`; full output is `../../tmp/billing-build-verified.log`.

## 15. MANUAL QA

Not executed against real PayPal accounts. Required staging acceptance:

| Scenario | Expected result |
|---|---|
| Free teacher → Add Credits | Approved eligible catalog appears; API failure has a different message from empty catalog. |
| Paid teacher → Add Credits | Only eligible active valid packs appear. |
| Institution teacher | Existing institution balance and purchase rules remain separate. |
| Monthly signup | Provider agreement shows approved monthly price/interval. |
| Annual signup | Provider agreement shows approved annual price/interval. |
| Monthly → annual same tier, and reverse | One revision; period changes only after exact provider confirmation. |
| Upgrade / downgrade | Correct target, preserved balances, correct allowance, no premature success. |
| Cancel / cancelled paid-through | Provider cancellation confirmed; entitlement persists until paid-through then becomes Free. |
| Top-up / duplicate click | One order identity and one grant; wallet updates without reload. |
| Network interruption during capture | Existing attempt reconciles; no second payment encouraged. |
| Refresh/back/close during approval | Existing provider operation resumes or enters explicit reconciliation; no independent duplicate subscription. |
| SDK failure / configuration change | Redirect or explicit retry is usable; no stale currency/client SDK. |
| Refund / duplicate refund / partial refund | Full unused reversal once; used/partial cases review; balance never negative. |

## 16. DEPLOYMENT STEPS

1. Confirm the target environment/database and approved commercial catalog. Keep new financial traffic disabled until the release gates pass.
2. Back up affected collections and index definitions, retain the current deployable application artifact, and record counts/checksums. Rehearse restore and migration against a staging copy.
3. Run read-only catalog/index and PayPal configuration/resource diagnostics. Resolve all preflight conflicts. Do not run old commercial seed defaults.
4. Stop all billing writers, webhook workers, and old application instances that could bypass the new checkout claim. Reconcile existing ambiguous/overlapping attempts with provider truth.
5. Run the explicit migration dry-run, then its backup-confirmed apply. Rerun diagnostics; create approved missing CreditPack records through Admin Pricing. Verify actual eligible teachers.
6. Deploy matching backend/frontend artifacts together. Verify the required indexes before reopening financial operations. Run the staging manual matrix and signed webhook replay checks.
7. Enable production monetary traffic only after production resource mappings, live credentials, webhook delivery, actual catalog, and operator recovery procedures pass. Monitor review-required events, pending ages, index failures, duplicate-key conflicts, and capture/grant reconciliation.
8. Rollback: pause financial traffic first. Keep additive indexes/fields and operation ledgers. Do not roll back wallet balances or erase payment history after external money has moved. An old application that ignores new locks is unsafe under traffic; reconcile outstanding operations, then restore an explicitly compatible artifact. Data restore requires payment-ledger reconciliation and an operator-reviewed recovery plan.

## 17. REMAINING RISKS

Production database identity/catalog/indexes and production PayPal authentication/resources remain unverified. Commercial pack values are unresolved. The configured database is still empty of CreditPack records and lacks two required indexes.

Ambiguous submitted SDK revisions and aged unknown subscription creates deliberately retain their financial lock. Provider/operator reconciliation is still needed when approval cannot be safely resumed or confirmed terminal; automatic expiry must not be mistaken for provider cancellation. This is a release acceptance gap, not a claimed fully automatic recovery solution.

No live-money checkout, refund, webhook delivery, or browser manual matrix was executed. Shared OAuth token reuse remains a P2 optimization. Existing unrelated work in the repositories requires its own release review; this pass did not certify the entire application.

## 18. FINAL VERDICT

FINAL VERDICT: NO-GO
