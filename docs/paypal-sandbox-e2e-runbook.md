# PayPal Sandbox end-to-end runbook

This runbook is for human-controlled testing after PayPal Developer access is granted. It does not authorize Live use. The local frontend is `http://localhost:4200`, the backend is `http://localhost:5000`, and the webhook endpoint is `POST /api/webhooks/paypal`.

## 1. Access

Accept the PayPal Developer invitation, confirm that the expected merchant/business account is selected, and open its Developer Dashboard. Do not use a personal production account by mistake.

## 2. Sandbox REST app

Select or create the appropriate Sandbox REST app. Copy its Client ID and Client Secret into the local, ignored `.env`; never commit either value. Keep `PAYPAL_ENV=sandbox` and `PAYPAL_LIVE_ENABLED=false`.

## 3. Sandbox accounts

Confirm one Sandbox business/merchant account owns the REST app and one distinct Sandbox personal/buyer account can approve payments. Use only Sandbox account credentials in Sandbox checkout pages.

## 4. Product and plans

Use `npm run paypal:check` first. When IDs do not exist, review `npm run paypal:provision:sandbox -- --dry-run`, then deliberately run the existing provisioning command only with approval. Record the one Product ID and the four paid Billing Plan IDs in the `PAYPAL_SANDBOX_*` variables. Do not map `free` or `institution`. Run `npm run paypal:validate-resources` after the Mongo Plan records and IDs are ready.

## 5. Local application

Start MongoDB, then run `npm run dev` in `backend` and the existing Angular start command in `RoznaComarker`. Required payment settings are shown in `.env.example`: `PAYMENT_PROVIDER=paypal` only in this local test environment, `PAYPAL_ENABLED=true`, `PAYPAL_ENV=sandbox`, Sandbox credentials/resources, and `APP_PUBLIC_URL=http://localhost:4200`. Restart the backend after any environment change.

## 6. Public HTTPS tunnel

Run either tool separately; neither is an application dependency:

```text
ngrok http 5000
cloudflared tunnel --url http://localhost:5000
```

Treat the assigned HTTPS origin as `PUBLIC_BACKEND_URL`. Tunnel origins are temporary unless the provider reserves one.

## 7. Register the webhook

In the Sandbox REST app, register:

```text
${PUBLIC_BACKEND_URL}/api/webhooks/paypal
```

Select only the events in the table below. Copy the Webhook ID returned for this exact registration to `PAYPAL_SANDBOX_WEBHOOK_ID`, restart the backend, and rerun `npm run paypal:check:auth`. A simulator Webhook ID is not interchangeable with this registration's ID.

| Event | Purpose |
|---|---|
| `BILLING.SUBSCRIPTION.CREATED` | Reconcile a newly created subscription |
| `BILLING.SUBSCRIPTION.ACTIVATED` | Authoritatively activate plan/credits |
| `BILLING.SUBSCRIPTION.UPDATED` | Reconcile plan and status changes |
| `BILLING.SUBSCRIPTION.CANCELLED` | Reconcile cancellation |
| `BILLING.SUBSCRIPTION.SUSPENDED` | Record payment/access issue |
| `BILLING.SUBSCRIPTION.EXPIRED` | Reconcile expiry |
| `BILLING.SUBSCRIPTION.PAYMENT.FAILED` | Record payment issue and fetch current state |
| `PAYMENT.CAPTURE.COMPLETED` | Reconcile/credit an approved pack capture once |
| `PAYMENT.CAPTURE.REFUNDED` | Reverse credits when safe, otherwise flag review |
| `PAYMENT.CAPTURE.REVERSED` | Reverse credits when safe, otherwise flag review |

## 8. Subscription matrix

For A-D, the browser should reach the trusted PayPal approval page then the configured callback; `PaymentCheckoutAttempt` should move from `approval_pending` to `active` after authoritative reconciliation; the user should contain the matching PayPal subscription/plan; subscription credits should match the Mongo Plan only once. A: Essential monthly. B: Essential annual. C: Pro monthly. D: Pro annual.

E. Cancel at buyer approval: browser returns to `/billing/paypal/cancel`; no entitlement or credits activate; attempt remains non-active. F. Successful activation: UI refreshes backend state and shows active membership. G. Resend the same webhook: one `PaymentProviderEvent` exists for provider/event ID and no second credit grant occurs. H. Refresh success callback: status is fetched again without creating another subscription.

I. Cancel an active subscription: one management attempt is recorded and the fetched PayPal status becomes authoritative; do not expect a browser-only downgrade. J. Change plan: one revise call uses the selected mapped Plan ID; approval-required changes remain pending until reconciliation. K. Reject change consent: the matching authenticated management attempt becomes `cancelled` and the current plan remains unchanged. L. If Sandbox tooling permits payment-failure/suspension, verify payment-issue state without inventing entitlement. M. Repeat callbacks: results remain idempotent. N. Logged-out or wrong-role calls return 401/403 and create no payment attempt.

Record for every case: browser outcome, user subscription fields, subscription credit balance/limit, checkout or management attempt status, provider IDs, and whether a duplicate changed any balance.

## 9. Credit-pack matrix

A-C. Create a small eligible pack order, approve it, and capture it. The attempt progresses through `approval_pending`/`capturing` to `credited`. D. `CreditWallet.purchasedCredits` increases exactly once and a committed `CreditTransaction` exists. E-F. Refresh the callback and repeat capture: return the durable result with no second grant. G. Resend the completed-capture webhook: no second grant.

H-I. Issue a full Sandbox refund from PayPal and resend its webhook: purchased credits are removed at most once when safely available. J. A partial refund becomes `review_required`; it is not silently treated as a full reversal. K. Partial then cumulatively full refund must converge without double-removal. L. If refund/reversal overlap can be reproduced, only one economic reversal is applied; otherwise record it as not reproducible. Inspect the purchase, provider-event, transaction, and wallet records after each case.

## 10. Read-only database verification

Use `mongosh` against the test database. Collection names should be confirmed with `show collections`; typical Mongoose names are shown here. Never edit these records to make a test pass.

```javascript
db.paymentcheckoutattempts.find({ provider: "paypal" }).sort({ createdAt: -1 }).limit(20)
db.paymentproviderevents.find({ provider: "paypal" }).sort({ createdAt: -1 }).limit(30)
db.paymentmanagementattempts.find({ provider: "paypal" }).sort({ createdAt: -1 }).limit(20)
db.paymentpurchaseattempts.find({ provider: "paypal" }).sort({ createdAt: -1 }).limit(20)
db.credittransactions.find({ idempotencyKey: /^paypal:/ }).sort({ createdAt: -1 }).limit(30)
db.creditwallets.find({ userId: ObjectId("<USER_ID>") })
db.users.find({ _id: ObjectId("<USER_ID>") }, { plan: 1, paypalSubscriptionId: 1, paypalSubscriptionStatus: 1, paypalPlanId: 1, paypalPaymentIssueActive: 1 })
```

## 11. PayPal Dashboard verification

For each case, compare the Sandbox transaction/subscription ID with the internal attempt. Inspect webhook delivery status and response, and use PayPal's resend function for duplicate-delivery tests. A dashboard status alone is not sufficient: verify backend reconciliation and ledgers.

## 12. Pass/fail record

| Scenario | Expected | Observed | Result | Notes | PayPal ID | Internal attempt ID |
|---|---|---|---|---|---|---|
| Example: Essential monthly | Active once |  |  |  |  |  |

Do not proceed to Live until all applicable rows pass, non-applicable rows have a reason, automated tests pass, and every `review_required` record is explained.
