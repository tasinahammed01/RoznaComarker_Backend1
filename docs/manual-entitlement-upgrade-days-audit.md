# COMARKER MANUAL-ENTITLEMENT UPGRADE + DAYS-REMAINING AUDIT

## 1. Executive Summary

The existing admin-granted Essential term now produces a read-only Pro Monthly quote of **19.99 USD, with zero proration credit**. Upgrade verification now distinguishes the authoritative `admin` source from paid/unknown provenance. Only verified fulfillment supersedes current access. Calendar terms and the existing rounded-up 24-hour days calculation are preserved; the Account & Plan status now shows Expired for a retained DTO at/after its exact expiry.

## 2. Upgrade Failure Exact Root Cause

Error: `PRORATION_REVIEW_REQUIRED`, HTTP 409, in `planBilling.service.js:createQuote`. The upgrade branch previously required `historicalPayment.providerCaptureId` and `current.source === 'paypal'` for every current entitlement, including admin grants. The real admin record had no payment attempt or capture, so it threw the existing “amount paid ... could not be verified” error before persisting a quote or initializing PayPal.

Read-only actual-record reproduction ran before changing runtime code. Its after-check used the same entitlement/account and unchanged catalog, substituting only final quote persistence in the diagnostic process. No database data or provider payment was changed.

## 3. Current Manual Entitlement Provenance

Actual inspected entitlement: `6ac0cef4d79423b4d3416c5d`, plan `essential_monthly`, source `admin`. It has `assignedBy` and `adminOperationId`; `sourceType` is absent. Payment attempt, provider capture and paid amount are absent. Stored start: `2026-10-03T09:46:09.577Z`; end: `2026-11-03T09:46:09.577Z`. No account identifier, email, token or name is printed.

The model permits source `paypal` or `admin`. Legacy recurring subscriptions use existing User PayPal subscription fields and remain blocked from prepaid checkout while active/paid through. Default Free is resolver fallback. Unknown/imported source values are not treated as admin; tests insert such legacy raw records only into a disposable database to verify rejection.

## 4. Paid vs Manual Billing Rule

Paid: retain existing indexed historical payment verification and integer/BigInt unused-value proration. Missing evidence, wrong currency, unrecognized source or non-PayPal provenance still fail safe.

Manual: only `ctx.current.source === 'admin'`, loaded by the backend, skips historical paid-value lookup. Initialized credit remains zero and historicalPayment remains null. Catalog value is never substituted for money paid. Existing future-term review checks still apply.

## 5. Pricing Before

Actual target `pro_monthly`, raw catalog price 19.99 USD. Transition upgrade. Quote rejected because the source-admin Essential grant has no verified paid purchase. The error did not indicate a malformed grant; it came from applying paid-term validation to unpaid access.

## 6. Pricing After

```text
Target Pro Monthly             USD 19.99
Verified unused paid credit   -USD  0.00
Subtotal                       USD 19.99
Promo (none)                  -USD  0.00
Amount due today               USD 19.99
```

Actual read-only service result: baseAmount 19.99, prorationCredit 0.00, subtotalBeforeDiscount 19.99, finalAmount 19.99, transition upgrade, historicalPaymentId null. Promo ordering remains subtotal minus discount. Tests cover fixed 5.00 → 14.99 and 20% → 15.99 on this target; promo code was not modified.

## 7. Payment Failure Safety

Quote/order creation leaves manual access active. Cancellation, decline and ambiguous network/capture failures retain the manual term. Cancellation releases the existing promo reservation. Payment and reservation lifecycle code was not changed.

## 8. Fulfillment / Supersession

Existing verified fulfillment transaction creates the immediate paid upgrade, supersedes the manual entitlement, and preserves its history/admin reason. New term ends through `addCalendarPeriod`. Repeated capture and webhook callbacks produce one paid entitlement. Manual same-plan purchase is scheduled renewal; manual Pro → Essential is scheduled downgrade at the current term's end, matching existing policy.

## 9. Days Remaining Audit

The subscription controller returns current entitlement startsAt/endsAt directly. Account & Plan prefers these over compatibility/User dates. The frontend getter computes:

```text
max(0, ceil((endsAt instant - Date.now()) / 86400000))
```

No expiry returns Not applicable. This already matches the requested whole/partial 24-hour semantics. One second before expiry → 1; exact expiry and afterwards → 0. A retained stale DTO now displays Expired when this value reaches zero, on Angular change detection. No timer or polling was added.

## 10. Calendar Month Semantics

`addCalendarPeriod` increments UTC month/year, clamps the day to the last day of the target month, and preserves the time of day. Oct 3 → Nov 3 is one calendar month with 31 elapsed days. Nov 3 → Dec 3 has 30. Jan 31 clamps to Feb 28/29. Annual terms may span 365 or 366 days. No fixed 30-day or 365-day replacement was introduced.

## 11. Timezone Review

Stored dates remain UTC instants. UI date labels use the existing `Intl.DateTimeFormat` local display convention. Remaining time subtracts instants, without parsing formatted labels or adding timezone offsets. Calendar utility uses UTC operations, so local DST does not change the stored calendar rule; local rendering can naturally vary by timezone.

## 12. Files Changed

- Backend `src/services/planBilling.service.js`: narrow source-admin zero-credit exception.
- Backend `tests/billingPromoAdmin.test.js`: 15 manual/paid upgrade, failure, scheduling and expiry regressions.
- Backend `tests/billingCalendar.test.js`: eight calendar-duration/UTC tests.
- Frontend `src/app/pages/paypal-manage/paypal-manage.html`: expired status from authoritative end time.
- Frontend `src/app/pages/paypal-manage/paypal-manage.spec.ts`: authoritative date, local display and boundary tests.
- Frontend `src/app/pages/checkout/checkout.spec.ts`: full-price upgrade quote and paid-history error display tests.
- This report; local read-only trace/lint scripts and logs under workspace `tmp/`.

## 13. Tests

Frontend: **139 passed, 0 failed** across checkout, change-plan, Account & Plan and admin billing confirmation.

Backend: **193 distinct tests passed across seven suites**, combining 75 tests from six suites in the initial run and all 118 billingPromoAdmin tests in its isolated rerun. The initial billingPromoAdmin run could not initialize its MongoMemoryServer within its 10-second process-start timeout. No application behavior or unrelated test infrastructure was changed to address that environment failure.

Quality gates: backend syntax PASS; TypeScript PASS; Angular production build PASS; both repositories git diff --check PASS. Backend ESLint recommended rules with Node/Jest globals PASS. Full changed-frontend-file lint retains 28 pre-existing diagnostics, with zero new diagnostics against HEAD; unrelated lint debt was not repaired.

Logs: `manual-upgrade-backend.log`, `manual-upgrade-backend-retry.log`, `manual-upgrade-frontend.log` under workspace tmp.

## 14. Billing Regression

Paid upgrade: PASS. Manual upgrade: PASS. Proration: PASS. Promo: PASS. PayPal: PASS. Entitlements: PASS. Regression cases cover paid upgrade/proration, admin zero-credit upgrade, fixed/percent promo, failed/cancelled payments, PayPal expected amount, duplicate capture/webhook, entitlement history and current scheduling rules.

## 15. Date Regression

Calendar monthly: PASS. Leap year/month-end: PASS. Expiry boundary: frontend and backend worker/resolver PASS. Local timezone display: PASS. Eight calendar utility tests passed in the combined backend run.

## 16. Security

Frontend cannot choose entitlement source, paid amount or credit. The exception checks an existing database entitlement, not request parameters. No global payment verification bypass or missing-payment fallback was added. Non-admin sources keep the original safety error. Capture amount/currency/correlation validation and entitlement activation remain unchanged.

## 17. Performance

Additional runtime DB queries: **0**; admin upgrades avoid the old historical payment lookup (one fewer read). Paid upgrades retain their existing lookup. Additional provider requests: **0**. No history scans, dependencies, timers or polling added.

## 18. Database Changes

Migration: **NO**. Production/configured application data modified: **NO**. Isolated test databases contain test grants and payment fixtures; actual-record diagnosis was read-only with autoIndex/autoCreate disabled and quote persistence suppressed. TTT records, catalog prices, credits and live entitlement/payment history were not modified.

## 19. Remaining Risks

Actual authenticated browser PayPal approval and sandbox capture were not performed. Actual account pricing was verified read-only; capture/cancel/decline/idempotency use mocked provider responses and real disposable transactional persistence. Existing frontend lint debt remains: 12 checkout-spec, 14 Account & Plan spec, and two Account & Plan HTML diagnostics; baseline comparison proves no new diagnostics. Existing production build CommonJS/style warnings remain.

## 20. Final Verdict

**READY FOR CONTROLLED QA.** Actual-record quote, frontend, backend regression and build checks pass. Controlled sandbox approval/capture remains manual QA; no real payment was made.
