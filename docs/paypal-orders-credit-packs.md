# PayPal Orders for Assessment Credit packs (Phase 4)

This phase adds mocked and Sandbox-ready one-time PayPal Orders. It does not perform live or Sandbox purchases automatically, change subscription billing, remove Stripe, migrate Stripe users, or change Assessment Credit consumption.

## Existing top-up architecture audit

`CreditPack` is the authoritative catalog. Admin-managed records contain the canonical code, integer credit quantity, price, currency, plan eligibility, display order, active flag, and Stripe Price ID. `GET /api/credits/packs` exposes only active public pack fields plus the configured payment provider. The browser never supplies a trusted amount, currency, credit count, entitlement, PayPal Order ID, or PayPal Capture ID.

The existing Stripe path remains `POST /api/credits/topups/checkout-session`. It resolves the active eligible pack, fetches the Stripe Price, verifies mode/type/amount/currency, creates Checkout, and waits for the verified Stripe webhook. `checkout.session.completed` grants `purchasedCredits` exactly once through a unique `CreditTransaction`; `charge.refunded` removes the full pack only when sufficient purchased inventory remains, otherwise it records `review_required`. No Stripe webhook behavior was replaced.

`CreditWallet` stores monthly, purchased, and bonus buckets independently. Monthly reset changes only monthly allowance/usage. Assessment charging remains monthly, then purchased, then bonus.

## PayPal create and approval flow

`POST /api/credits/paypal/create-order` accepts exactly `packCode` and UUID-v4 `checkoutAttemptId`. The backend resolves the authenticated teacher, active pack, eligibility, integer credits, canonical two-decimal amount string, and currency. `PaymentPurchaseAttempt` snapshots those trusted values and has unique indexes for `provider + attemptId`, provider Order ID, and provider Capture ID.

The first database insert owns Order creation. Concurrent duplicate requests cannot both own the same attempt. `POST /v2/checkout/orders` uses `intent: CAPTURE`, one purchase unit, exact backend amount/currency, the attempt UUID as `reference_id`, a namespaced `custom_id`, `NO_SHIPPING`, and server-created return/cancel URLs. The stable `PayPal-Request-Id` is `topup-create:<attemptId>`. Only an HTTPS PayPal-hosted `payer-action`/legacy `approve` link is returned.

The browser return does not grant credits. It displays “Payment approved. Confirming your credit purchase...” and calls the authenticated capture endpoint with only the stored attempt UUID.

## Capture authority and exactly-once grant

`POST /api/credits/paypal/capture` resolves the stored Order ID and calls `POST /v2/checkout/orders/{id}/capture` with the stable `topup-capture:<attemptId>` request ID. A timeout/error triggers authoritative `GET /v2/checkout/orders/{id}` recovery.

Credit grant requires all of the following from the authoritative Order representation:

- expected Order ID and final Order status `COMPLETED`;
- exactly one purchase unit with expected `reference_id` and `custom_id`;
- exact two-decimal amount string and currency at purchase-unit and capture levels;
- exactly one capture with an ID and status `COMPLETED`.

`CREATED`, `APPROVED`, `PAYER_ACTION_REQUIRED`, `PENDING`, declined/non-final captures, missing IDs, and any amount/currency/correlation mismatch grant nothing. Correlation mismatches become `review_required`.

The unique credit key is `paypal-topup:capture:<captureId>` on `CreditTransaction`. `CreditWallet` does not retain historical provider keys. It has at most one bounded, hidden `pendingPurchaseOperation`, used only while a grant or reversal is being coordinated. The wallet balance change and marker transition from `claimed` to `applied` happen in one atomic single-document update. A crash before that update retries the claim; a crash after it finalizes the durable transaction without changing the balance again. The marker is removed after finalization. The resulting audit transaction is `TOPUP_PURCHASE_COMPLETED`, reason “PayPal Assessment Credit purchase”, with non-sensitive Order/Capture references.

PayPal request IDs remain stable for provider retries, but they are not the permanent accounting authority. Once PayPal's request-ID retention window has elapsed, the local unique capture transaction, purchase attempt, and provider-event ledger still prevent duplicate credit delivery.

## Attempt state and recovery

States are `creating`, `approval_pending`, `capturing`, `captured`, `credited`, `failed`, `cancelled`, `refunded`, and `review_required`. `creating` and `capturing` have two-minute leases. Retryable network/provider failures retain their stable request IDs and can be reclaimed. Provider validation failures are permanent. Buyer cancellation marks only an uncaptured attempt cancelled and requires a new UUID for a later purchase.

If Order creation succeeds but local persistence fails, the attempt stays `creating`; after lease expiry it replays the same create request ID. If capture succeeds but local persistence fails, retry reuses the capture request ID or fetches the Order, then resumes the capture-ID-based grant. If the durable transaction is created before the wallet update, the bounded operation resumes it. If the wallet update succeeds before transaction finalization, the atomic `applied` state proves that the balance must not be changed again. No replica-set transaction is required, so the protocol also works with a standalone MongoDB deployment.

## Verified webhook recovery and refunds

The existing `POST /api/webhooks/paypal` verification, `PaymentProviderEvent` unique event ledger, processing lease, and retry behavior are reused. Phase 4 registers only the documented payment events needed here:

- `PAYMENT.CAPTURE.COMPLETED` — fetch the Order, validate it, and perform duplicate-safe recovery/grant;
- `PAYMENT.CAPTURE.REFUNDED` — fetch the capture and reconcile the refund;
- `PAYMENT.CAPTURE.REVERSED` — fetch the capture and apply the same conservative reversal policy.

Synchronous capture and webhook completion can race safely because both converge on the same provider Capture ID and credit idempotency key. An unknown capture event is retained as `review_required` and never mutates a wallet.

A provable full refund/reversal removes exactly the original pack credits only when enough purchased credits remain. It never touches monthly or bonus inventory and never makes purchased inventory negative. If credits were consumed, the transaction and attempt become `review_required`. A partial refund also becomes `review_required`; this phase does not invent fractional credits or a monetary-to-credit allocation rule. A later cumulative full-refund event performs the full-pack reversal once. Duplicate refund events use the same cumulative refund key, and a reversal arriving after a completed refund reuses the already-refunded transaction without a second wallet mutation. Refund events arriving before local capture reconciliation first recover the authoritative Order/capture grant, then apply the same reversal policy.

## Frontend and accessibility

The existing Usage → Add Credits dialog loads active packs from the backend and displays their actual credits, price, and currency. `PAYMENT_PROVIDER=stripe` retains existing Stripe Checkout. `PAYMENT_PROVIDER=paypal` creates an Order and redirects only after PayPal-host validation. A component-memory UUID is stable across transient retries for the same pack, changes with the selected pack, and is discarded when the dialog is explicitly abandoned.

The modal keeps dialog semantics, an accessible label, live loading/error announcements, Escape handling, a keyboard focus loop, at least 44px controls, bounded viewport height, one-column layout at 430px and below, and overflow-safe content for 320–430px widths.

## Later Sandbox checklist

1. Keep `PAYPAL_ENV=sandbox`; configure Sandbox credentials, verified public HTTPS webhook, and `FRONTEND_URL`.
2. Run `npm run paypal:webhook:sandbox` and confirm the three payment capture events are present alongside subscription events.
3. Create each active eligible pack Order and verify the PayPal approval amount/currency against MongoDB.
4. Return from approval and confirm exactly one `TOPUP_PURCHASE_COMPLETED` transaction and purchased-credit increment.
5. Replay capture and `PAYMENT.CAPTURE.COMPLETED`; confirm no duplicate increment.
6. Exercise browser cancellation; confirm the attempt is cancelled and no credit transaction exists.
7. Exercise full refund with unused credits, full refund after consumption, partial refund, and reversal; confirm refund/review behavior.
8. Simulate capture/create timeouts and local persistence failures; confirm stable provider request IDs and recovery.
9. Confirm Stripe mode still uses the existing Checkout/webhook path.

Official contracts reviewed: [Orders v2](https://developer.paypal.com/api/orders/v2), [Payments v2](https://developer.paypal.com/api/payments/v2), and [PayPal webhook event names](https://developer.paypal.com/api/rest/webhooks/event-names/).
