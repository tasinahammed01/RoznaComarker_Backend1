# PayPal production-readiness reference

## Runtime architecture

`src/config/paypal.js` is authoritative for `PAYPAL_ENV`, API hosts, selected credentials/resources, trusted redirects, and the Live guard. `NODE_ENV` does not select PayPal. Sandbox may use the legacy generic variables for compatibility; Live never does. Business code receives internal plan codes and resolves the selected environment's Plan ID on the backend.

`PAYMENT_PROVIDER` remains deterministic and defaults to Stripe. `PAYPAL_ENABLED=true` can validate/operate PayPal support independently (for example, already-active PayPal subscriptions) without changing which provider is offered for new checkout.

The frontend uses backend-generated approval URLs, filters them to HTTPS PayPal hosts, and then fetches backend status. It has no PayPal Client Secret or Plan ID selection and does not grant entitlement or credits.

## PayPal webhook events required by this application

The endpoint is `POST /api/webhooks/paypal`. `src/app.js` mounts it before generic `express.json`; `src/routes/paypalWebhook.routes.js` supplies the raw JSON body used by `src/controllers/paypalWebhook.controller.js` verification. Verification posts to the selected API host with the selected Webhook ID before any event claim or business-state mutation.

| Event type | Why | Handler/module | Internal behavior |
|---|---|---|---|
| `BILLING.SUBSCRIPTION.CREATED` | Initial lifecycle authority | webhook controller → `paypalSubscription.service.js` | Fetches subscription and reconciles attempt/user |
| `BILLING.SUBSCRIPTION.ACTIVATED` | Paid activation | same | Activates mapped plan and subscription credits idempotently |
| `BILLING.SUBSCRIPTION.UPDATED` | Plan/status change | same | Fetches and reconciles selected trusted plan/status |
| `BILLING.SUBSCRIPTION.CANCELLED` | Cancellation | same | Reconciles cancelled provider state |
| `BILLING.SUBSCRIPTION.SUSPENDED` | Payment/access issue | same | Records provider/payment issue through reconciliation |
| `BILLING.SUBSCRIPTION.EXPIRED` | End of lifecycle | same | Reconciles expiry |
| `BILLING.SUBSCRIPTION.PAYMENT.FAILED` | Failed recurring payment | same | Fetches state and records payment issue |
| `PAYMENT.CAPTURE.COMPLETED` | Pack capture | webhook controller → `paypalPurchase.service.js` | Fetches order/capture and grants purchased credits once |
| `PAYMENT.CAPTURE.REFUNDED` | Refund | same | Applies safe economic reversal once or marks review |
| `PAYMENT.CAPTURE.REVERSED` | Reversal | same | Applies safe economic reversal once or marks review |

Do not subscribe to `*`. Unknown well-formed non-capture events are acknowledged and ignored. Unknown capture events are retained as `review_required`. Malformed events return a safe client error. Duplicate IDs converge through the unique provider/event ledger and processing lease.

## HTTP reliability and logging

The PayPal client uses a 10-second request timeout. Mutations use stable `PayPal-Request-Id` identities supplied by durable attempts. It does not blindly retry monetary calls; Phase 2-4 fetch-back/reconciliation resolves ambiguous outcomes. PayPal errors retain sanitized status/code/debug ID while Authorization, Basic credentials, bearer tokens, secrets, and signature-like values are redacted. Raw webhook signatures and bodies are not logged.

## Operational signals

Alert on repeated `PAYPAL_AUTH_FAILED`, webhook verification failure responses, provider-event `failed`, any `review_required`, attempts whose processing lease has expired, `PAYPAL_PLAN_*` mapping/product/price/currency errors, capture amount/currency mismatch, and rising PayPal 5xx/timeouts. Correlate with environment, event type/ID, internal attempt ID, PayPal order/subscription/capture ID, result, and sanitized debug ID. Never add credentials, authorization headers, full signatures, Firebase tokens, or raw payment payloads.

Suggested database checks: count `PaymentProviderEvent` by status/updated age; count `PaymentPurchaseAttempt` in `capturing` past its lease; count `PaymentManagementAttempt` in `processing` past its lease; and page immediately on new `review_required` credit transactions or purchases.

## Index audit

The current schemas enforce provider-scoped event and attempt identities, partial provider-scoped order/capture uniqueness, global transaction idempotency keys whose PayPal values are provider-namespaced, and a partial unique active-operation lock. Supporting status/user indexes serve reconciliation. The global sparse provider-subscription identity is stronger than provider-scoped uniqueness; PayPal and Stripe IDs use distinct provider formats and a collision would represent ambiguous ownership rather than a legitimate coexistence case. Tests initialize Mongo indexes. No stable index required a Phase 5 migration.

## Commands

- `npm run paypal:check`: local validation only; prints presence and selected variable names, not values.
- `npm run paypal:check:auth`: additionally obtains an OAuth token and reports only success/failure; it creates nothing.
- `npm run paypal:validate-resources`: read-only GET validation of the selected Product/Plans against Mongo Plan interval, amount, currency, relationship, and status.

Official behavior references: [PayPal REST environments](https://developer.paypal.com/api/make-api-requests), [idempotency](https://developer.paypal.com/reference/guidelines/idempotency/), [webhook integration and verification](https://developer.paypal.com/api/rest/webhooks/rest/), [subscription webhook types](https://developer.paypal.com/docs/subscriptions/reference/webhooks/), [Sandbox testing](https://developer.paypal.com/sandbox-testing/overview/), and [production cutover](https://developer.paypal.com/api/rest/production).
