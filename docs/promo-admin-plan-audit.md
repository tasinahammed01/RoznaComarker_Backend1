# COMARKER PROMO + ADMIN PLAN FEATURES AUDIT

Date: 2026-09-29. Scope: prepaid PayPal promo pricing and confirmed manual entitlement overrides. No live payments, production migrations, external subscription changes, or historical data deletions were performed.

## 1. Executive Summary

Implemented server-priced promo checkout and audited admin plan assignment by email. The three confirmed decisions are enforced:

1. Higher paid upgrade: unused verified paid value is credited, promo applies afterward, and verified payment starts a new full calendar term immediately.
2. Admin override: conflicting active/scheduled entitlements are superseded, never deleted; payment history, credits, and content remain intact.
3. Active legacy recurring PayPal: manual assignment is blocked with the requested billing-review message. No automatic cancellation or external subscription modification occurs.

Automated checks support controlled QA, not a claim that the entire application is production-ready. Live sandbox checkout and production database readiness remain deployment gates.

## 2. Pre-Implementation Architecture Audit

- Catalog authority: MongoDB `Plan` documents (`price`, `annualPrice`, `currency`, active status). Canonical tiers are Free, Essential, Pro; legacy aliases exist.
- Entitlement authority: `PlanEntitlement`; `User.plan`, start, and expiry are compatibility/cache fields. The existing expiry worker and request resolver activate scheduled terms.
- Purchase authority: `PaymentPurchaseAttempt`, existing unique attempt/order/capture indexes, provider request IDs, and processing leases.
- Provider: PayPal Orders for prepaid purchases. Legacy PayPal recurring services remain separate. No Stripe integration was added.
- Before implementation, subsequent prepaid purchases were appended at the entitlement tail regardless of tier. That preserved renewal/downgrade timing but did not implement immediate higher-tier upgrades.
- The old admin operation only revoked prior admin-origin records and could conflict with a paid active entitlement. It lacked the new explicit preview/confirm contract and recurring-billing guard.
- Existing duplicate protection: provider request idempotency, capture correlation, unique capture/active-entitlement constraints, and entitlement leases. New multi-record promo/grant operations use replica-set transactions and per-user billing-account serialization.
- Credit authority: the existing wallet distinguishes monthly allowance/usage from purchased and bonus/referral buckets. No new plan operation deletes any bucket or resets consumed usage.

## 3. Feature 1 — Promo / Discount Codes

Implemented: YES. Percent and fixed amount: YES. Admin create/list/edit/disable: YES.

Normalization, bounded input, validity dates, active status, currency, plan and period restrictions, global limit, per-user limit, atomic reservation, and idempotent consumption: PASS in automated tests.

Codes are trimmed and uppercased. Percent values are stored as basis points; fixed values as minor units. Supported currencies are USD/EUR/GBP/CAD/AUD; other decimal scales require explicit support rather than guessed rounding. Existing codes cannot be renamed.

Validation alone does not reserve or consume usage. Order creation reserves atomically. Verified fulfillment consumes once. Safe cancellation/abandonment releases once. Uncertain capture keeps its reservation for reconciliation. Refunds do not restore a consumed promo use. Definition edits invalidate uncommitted quotes but never reprice an existing order.

## 4. Server Pricing Flow

Catalog → transition classification → verified historical-payment proration → promo on today's subtotal → immutable purchase snapshot / `expectedAmount` → exact PayPal amount → verified capture → transactional entitlement and redemption.

The snapshot retains target plan/period/currency, quote time, current term boundaries, historical payment/paid amount, credit, subtotal, promo revision/type/value, discount, final amount, and state fingerprint. Quotes last 10 minutes; created orders have a 30-minute local capture window. Proration is frozen at server quote time; approved orders are not repriced while payment is in progress. The new full term starts at successful fulfillment, not at quote time or the old expiry.

Angular requests and displays the quote; it does not calculate trusted money or proration. Old clients without a quote ID still receive a server-generated quote during create-order.

## 5. Money / Rounding Safety

PASS: strict decimal-to-minor-unit conversion and BigInt intermediates. Proportional credit rounds down to whole minor units; percentage discounts round half-up to minor units. Credit cannot exceed the target full-term price.

Zero/negative-payable purchases are rejected for billing review rather than sending an invalid zero PayPal order. Invalid precision, negative amounts, non-finite values, and unsupported currency are rejected. Calendar month/year boundaries use the existing UTC calendar utility, including month-end/leap-year handling; no fixed 30/365-day term approximation is used.

## 6. PayPal Safety

PASS in mocked-provider/integration tests: order amount equals persisted `expectedAmount`; capture validates environment, order ID, reference/custom IDs, single purchase unit/capture, amount, currency, and completion. Ownership checks remain in place.

Create/capture retries and webhook repeats cannot grant twice or consume twice. A create retry after ambiguous capture resumes the existing provider order. Expired ambiguous capture retries perform provider lookup only, never a new capture. Mismatched details and unsafe verified-payment fulfillment retain the account/payment for review.

No provider call is made to validate a promo. Legacy recurring management and credit-pack checkout retain their own flows. Actual PayPal sandbox interaction: NOT TESTED in this implementation pass.

## 7. Feature 2 — Admin Manual Assignment

Implemented: YES. Backend admin authorization: PASS. Exact normalized email lookup: PASS; missing, invalid, non-teacher, and ambiguous duplicate accounts are rejected. Uses `PlanEntitlement`: YES. Fake payment creation: NO.

The administrator previews target email, current effective plan/expiry, scheduled terms, selected plan/period, effective/expiry dates, reason, and supersession warning, then explicitly confirms. Manual terms use the displayed preview dates (preview valid for 10 minutes); Free is indefinite, paid assignments are one full monthly/annual calendar term. A reason is required.

Confirmation atomically supersedes all conflicting active/scheduled entitlements, writes the new admin-source record, updates compatibility fields, and writes before/after audit provenance. `supersededAt`, `supersededBy`, and reason preserve history. Superseded future terms do not reactivate. Operation replay returns the same grant/audit.

Purchased/bonus/referral credits and consumed usage are preserved. The existing wallet reconciles only the plan allowance. Historical content preservation is tested using class/assignment/submission/file markers. Pending or uncertain payments block assignment. The old `/api/subscription/set` and old unconfirmed service path now refuse writes.

ACTIVE recurring PayPal blocks both preview and confirmation with: "This user has an active legacy recurring PayPal subscription. Review or resolve the recurring billing before manually changing the plan."

SUSPENDED/APPROVAL_PENDING/APPROVED recurring states are also conservatively blocked. Already-cancelled recurring records remain intact; a subsequent manual override remains authoritative after its term expires, preventing old paid-through access from reappearing.

## 8. Plan Change Rules

- Immediate higher-tier upgrade/new full calendar term: PASS (monthly and annual).
- Server-side actual-paid proration: PASS. Missing reliable historical payment, incompatible currency, unknown cross-tier rank, or conflicting scheduled upgrade terms require review; no credit is invented.
- Downgrade keeps the higher plan until expiry, then schedules the lower term: PASS.
- Same-plan renewal appends a full term after existing prepaid coverage: PASS.
- Manual override and active-recurring block: PASS, including status change between preview and confirmation.

## 9. Promo + Proration

Tested example: September 1–October 1 term, quoted September 16; $10 actually paid, 50% remains. Target $20 − $5 unused value = $15; 20% promo = $3; expected/payment amount = $12. New entitlement starts on verified fulfillment for one new calendar month/year.

Also tested: $20 with $5 fixed promo → $15; $200 annual price with 20% promo → $160; 10% of $1.05 → $0.11 discount. Refund of the source payment during checkout prevents granting credit from refunded money. Refunds involving already-applied upgrade credit enter review.

## 10. Concurrency Review

Promo: allocation/usage/attempt creation share one transaction; competing final-slot writes retry and recheck. Unique promo and promo/user indexes prevent duplicate records.

Payment: existing conditional lease claims and provider idempotency keys remain; unique capture ownership and transactional replay prevent duplicate delivery. Cancellation conflicts with capture writes rather than freeing an uncertain slot.

Entitlement: per-user `BillingAccount` writes serialize new purchase/manual operations; one active entitlement and one capture are database constraints. Source-payment writes inside upgrade fulfillment conflict with concurrent refunds. Compatibility writes from the resolver use observed-state conditions to avoid overwriting a newer assignment.

Admin: quote ownership, expiry, account fingerprint, recurring guard, pending-payment guard, unique operation ID, and audit write are checked/committed together. Simultaneous and sequential retries are covered. Old instances must be drained before rollout; mixed-version billing writers are unsupported.

## 11. Security Review

Tested: anonymous/student/teacher admin denial; browser-supplied final-price rejection; malformed/operator promo values; missing/expired/disabled/wrong-plan/wrong-period/wrong-currency promos; foreign quote ownership; duplicate email; exhausted limits; stale/edited quotes; payment amount/currency mismatch; duplicate callbacks; legacy status changing after preview; old admin endpoint bypass; and source refund during upgrade.

Routes enforce authenticated DB-backed roles and strict allowed fields. No client-supplied discount or proration is authoritative. Quote/admin actions are rate-limited; lookups and pagination are bounded. Confirmation uses text rendering, not injected HTML. No credentials were added or exposed.

## 12. Performance Review

Static operation counts, excluding authentication, retry rounds and provider I/O (not a production latency benchmark):

| Path | Before | Added/current work |
| --- | --- | --- |
| Checkout price preview | No transition/promo quote | 3–4 indexed reads + 1 quote insert; promo adds 2 indexed reads |
| Promo reservation | None | 2 reads + 2 counter writes within the attempt transaction |
| Promo fulfillment/release | None | 2 counter writes within the existing billing transaction |
| Admin email preview | No equivalent | Email lookup (limit 2), user, bounded entitlements, current plan; no per-entitlement plan loop |
| Pricing page | Existing catalog | No promo validation or additional polling |
| Normal entitlement resolution | Existing resolver | No unconditional new billing query; ended-legacy/manual branch adds a bounded existence check |

Lookup/redemption keys use B-tree indexes, approximately O(log N) per indexed operation plus bounded result work. Entitlement quote context caps at 51 rows and requires review above 50. Admin promo pages contain 25 rows; offset pagination costs O(offset + 25), capped at page 10,000. Reservation cleanup handles at most 100 candidates per worker run. Existing expiry/reminder worker iteration was not redesigned; its older per-entitlement work remains.

No new per-row queries in promo/admin lists and no validation on each keystroke/render. Global promo counters serialize writes to the same heavily-used code by design. Production p95/p99 performance and high-volume contention still require controlled QA.

## 13. Files Changed

Backend integration: `src/app.js`, `src/controllers/paypalPlanPurchase.controller.js`, `src/routes/subscription.routes.js`, new `src/routes/billing.routes.js`, `src/middlewares/usage.middleware.js`, `src/services/paypal/paypalPlanPurchase.service.js`, `src/services/planEntitlement.service.js`, `src/services/planEntitlementWorker.service.js`.

New domain services: `src/services/billingMoney.service.js`, `src/services/promoCode.service.js`, `src/services/planBilling.service.js`.

Models: new `BillingAccount`, `BillingQuote`, `PromoCode`, `PromoUsage`; extended `PaymentPurchaseAttempt` and `PlanEntitlement`.

Frontend: `src/app/api/subscription-api.service.ts`, new `src/app/api/billing-admin-api.service.ts`, checkout TS/HTML, new admin-billing TS/HTML/CSS, `src/app/app.routes.ts`, `src/app/layouts/admin-layout/admin-layout.ts`.

Scripts/docs: `scripts/migratePromoBilling.js`, this audit.

Tests: new `tests/billingPromoAdmin.test.js`, `tests/promoBillingMigration.test.js`, frontend `admin-billing.spec.ts`; updated test DB helper, prepaid-plan tests, subscription-usage tests, checkout and checkout-success tests.

## 14. Database Changes

New collections: `billingaccounts`, `billingquotes`, `promocodes`, `promousages`. Existing attempt/entitlement documents gain additive snapshot/provenance fields and `superseded` status.

New indexes: unique billing user; quote expiry TTL; unique normalized promo code; unique promo/user usage; purpose/status/checkout-expiry scan; historical-payment/status lookup; unique partial admin operation. Existing order/capture, active-entitlement, period, email and audit indexes remain required.

Migration required: YES, additive indexes/collection readiness. No historical entitlement/payment rewrite, deletion, price update or invented paid amount. Existing attempts without snapshots retain legacy fulfillment handling; drain/review outstanding old orders before activation. TTL deletes only temporary quotes, never attempts, grants, or audit records. New attempts retain the complete quote snapshot after TTL expiry.

## 15. Tests Added

Money parsing/rounding; percent/fixed and annual promos; validity/restrictions; normalization/duplicates; validation without redemption; last-slot races; duplicate create/capture/webhooks; safe cancellation/expiry; frozen definition edits; no-promo checkout; monthly/annual immediate upgrades; missing historical money; downgrade/renewal; source refund; ownership/tampering; admin authorization/lookup/confirmation/idempotency; supersession/non-reactivation; credits/content preservation; legacy block and cancelled-legacy expiry; additive migration dry run/rerun; checkout quote rendering, explicit Apply/Remove and post-order locking; confirmation cancellation and ambiguous UI retry.

## 16. Test Results

- Backend focused: 2 suites / 76 tests PASS.
- Entitlement/prepaid/credit regression: 3 suites / 47 tests PASS in the final confirmation run.
- Billing/legacy/usage regression: 7 suites / 174 tests PASS.
- Assessment/OCR/adaptive/resubmission/notification/rubric/PDF contract checks: 7 suites / 48 tests PASS.
- Frontend: 31 tests PASS in Chrome Headless.
- Production Angular build: PASS; existing worksheet CSS budget and dependency CommonJS warnings remain.
- Application TypeScript check: PASS (`tsc --noEmit -p tsconfig.app.json`). Full repository spec typecheck was not used as an all-application certification.
- Backend build equivalent: syntax validation of 18 touched/new JS runtime/migration files PASS; this JS backend has no build script.
- New admin UI/API production lint: PASS. Touched existing checkout/subscription files still show 16 lint errors; running the same lint on their HEAD versions reproduces the same 10 + 6 errors. They are pre-existing constructor-injection/type-style/any issues, not newly suppressed errors.
- `git diff --check`: PASS in both repositories; line-ending notices are not whitespace errors.
- Migration dry-run/apply/rerun: PASS against the disposable replica set only. No production migration was executed.

Counts are grouped runs, not a claim of a single complete application test run. Some broader groups overlap. Tests use isolated MongoDB and mocked PayPal, not live provider transactions.

## 17. Manual Local QA

Promo: NOT TESTED manually. PayPal sandbox: NOT TESTED. Upgrade: NOT TESTED manually. Downgrade: NOT TESTED manually. Admin assignment: NOT TESTED manually. Automated integration/browser tests above cover these local contracts; they do not substitute for real sandbox approval, card eligibility, webhook delivery, or visual/mobile inspection.

## 18. Existing Feature Regression Check

Assessment: PASS (pipeline contract). OCR: PASS (normalization). Adaptive Practice: PASS (evidence grounding). Resubmission: PASS (lifecycle unit coverage). Credits: PASS. Classes/assignments: PASS (limits/resolution and content preservation). PDF: PASS (page-contract tests; rendered visual QA NOT TESTED). Notifications: PASS. Existing PayPal Orders: PASS with mocked provider. Legacy recurring: PASS with mocked provider. Unrelated scoring/OCR/adaptive/PDF production code was not changed by this feature.

## 19. Remaining Risks

Live PayPal sandbox, deployed replica-set/index readiness, real webhook recovery, visual/mobile accessibility review and production load/latency remain unverified. Known pre-existing lint/build warnings are disclosed above. No claim of zero defects or global production readiness is made.

Explicit review cases remain intentionally blocked: unreliable historical money, unsupported currency, upgrade with future prepaid terms, overlapping/gapped future coverage that would conflict with a new immediate purchase, zero-payable transition, active/potentially-live legacy recurring, ambiguous capture, or original-payment refund. Review does not automatically cancel/refund PayPal or clear payment guards. Support must correlate existing attempts/order/capture and audit any resolution; do not clear counters or create a second charge to bypass a review.

Prices/proration are fixed at quote time through the limited checkout window, whereas the new term begins at fulfillment. Promo usage remains consumed on refund. These implemented policies should be included in operator/QA sign-off.

## 20. Deployment Checklist

1. Back up the database; confirm replica-set/transaction support and canonical catalog/currency values.
2. Pause new plan checkouts/manual writes, drain old backend instances/workers, and resolve old pending/uncertain plan orders. Keep legacy recurring configuration and records intact. Do not use a mixed old/new rolling billing deployment.
3. From `backend`, run the read-only check: `node scripts/migratePromoBilling.js`. Inspect index conflicts, duplicates and legacy-pending counts. Do not blindly apply other historical migrations.
4. After operator backup approval, apply: `node scripts/migratePromoBilling.js --apply --backup-confirmed`. Rerun the dry run. This only creates missing compatible indexes; it never calls `syncIndexes` or deletes existing indexes/data.
5. Deploy all backend instances and the expiry worker first; verify worker operation and safe errors. Deploy the rebuilt frontend next. Cached old clients can create server-priced no-promo orders, but old admin shortcut calls intentionally receive 409.
6. In sandbox only, verify percent/fixed, wrong/expired/exhausted promo, no-promo purchase, exact order/capture amounts, upgrade/new term, downgrade/renewal, duplicate callbacks, abandoned/uncertain checkout, manual override including future terms, purchased/bonus balances, content availability, and active legacy block.
7. Monitor review-required payments, capture latency, quote conflicts, reservation age, worker failures, and API latency before enabling production checkout.

Reproduction commands:

```text
backend:
npm test -- --silent --runTestsByPath tests/billingPromoAdmin.test.js tests/promoBillingMigration.test.js
npm test -- --silent --runTestsByPath tests/paypal.prepaid-plans.test.js tests/planEntitlementResolution.test.js tests/creditService.test.js
npm test -- --silent --runTestsByPath tests/paypal.orders.phase4.test.js tests/paypal.subscription.management.test.js tests/paypal.cancellation.entitlement.test.js tests/paypal.subscription.phase2.test.js tests/subscription.usage.test.js tests/subscriptionStoragePersistence.test.js tests/billing.final-hardening.test.js

RoznaComarker:
npm test -- --watch=false --browsers=ChromeHeadlessCI --include=src/app/pages/checkout/checkout.spec.ts --include=src/app/pages/checkout/checkout-success.spec.ts --include=src/app/pages/admin/admin-billing.spec.ts
npm run build:prod
npx tsc --noEmit -p tsconfig.app.json
```

## 21. Rollback Plan

Pause new plan/admin writes at ingress and remove the new UI entry if needed. Retain the snapshot-aware backend/webhook path long enough to reconcile outstanding orders. Do not route new-snapshot attempts through an older backend that lacks their rules. Prefer a forward fix for settlement handling.

Keep all new collections, snapshots, superseded entitlements, counters, audit records and indexes. Never restore old User.plan values wholesale, reactivate superseded terms, erase grants, clear reservations or delete payments as a rollback. Resolve confirmed financial discrepancies through a separately authorized audited support process; preserve purchased/bonus credits and content.

## 22. Final Verdict

READY FOR CONTROLLED QA
