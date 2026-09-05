# PayPal Sandbox subscriptions

PayPal remains opt-in. Stripe is used when `PAYMENT_PROVIDER` is absent or set to `stripe`.

## Local configuration

Set the PayPal Sandbox credentials, Product ID, the four Billing Plan IDs, `PAYPAL_WEBHOOK_ID`, and the checkout and plan-change return/cancel URLs shown in `.env.example`. Set `PAYMENT_PROVIDER=paypal` only in the environment being used for Sandbox testing.

The webhook endpoint is `POST /api/webhooks/paypal`. A local server must be exposed through an operator-controlled public HTTPS tunnel or deployed test URL; put that exact URL in `PAYPAL_WEBHOOK_URL`. No tunnel hostname is hard-coded.

Register or discover the webhook explicitly:

```powershell
npm run paypal:webhook:sandbox
```

The command refuses non-Sandbox environments, lists existing webhooks first, reuses an exact URL/event-set match, and stops on ambiguous/conflicting registrations. Copy the safely printed ID into `PAYPAL_WEBHOOK_ID`; registration is never performed during application startup.

## Authoritative lifecycle

The browser requests checkout using only an internal plan code and a UUID attempt ID. The backend resolves the internal Plan and configured PayPal Billing Plan ID, creates the subscription idempotently, and returns only its ID and a validated PayPal approval URL. Returning from PayPal only starts bounded polling; it never grants access.

The webhook handler verifies PayPal transmission metadata using PayPal's verification API and `PAYPAL_WEBHOOK_ID`, records the event idempotently, then fetches the current subscription from PayPal. Only an `ACTIVE` fetch-back state with a known configured Plan ID and checkout-attempt correlation activates the existing internal plan and credit lifecycle.

Event processing uses an atomic two-minute lease. Completed and review-required duplicates are acknowledged without reprocessing. A concurrent delivery with a live lease receives a retryable non-2xx response, an expired or legacy lease can be atomically reclaimed after interruption, and a failed transient attempt can be claimed again. Permanent mapping/correlation failures remain `review_required` and do not enter an infinite provider retry loop.

`paypalLastPaymentFailedAt` is retained as failure history, while `paypalPaymentIssueActive` represents current state. A verified payment-failed event or authoritative `SUSPENDED` state sets the current warning. A later verified event whose fetch-back subscription is `ACTIVE` clears the current warning without deleting the historical timestamp.

`CANCELLED`, `SUSPENDED`, and `EXPIRED` follow the existing immediate non-entitlement behavior and return the account to Free without deleting wallet history. `PAYMENT.FAILED` is recorded and the fetched authoritative status controls entitlement.

## Manage Plan (Phase 3)

Stripe subscribers continue to use the Stripe Billing Portal. A teacher with an authoritative manageable PayPal subscription opens CoMarker's native `/billing/paypal/manage` page. Free and terminal PayPal accounts see the normal upgrade path. The management page shows the current plan, billing period, next billing date, status, Assessment Credit allowance, configured alternatives, and any pending target.

### Cancellation

`POST /api/subscription/paypal/cancel` accepts no subscription ID or reason. The authenticated teacher record supplies the provider subscription ID, and the backend sends the fixed reason `Cancelled by subscriber from CoMarker account settings.` to `POST /v1/billing/subscriptions/{id}/cancel`. A successful 204 only records a provider-pending management attempt. It does not change the internal plan.

`BILLING.SUBSCRIPTION.CANCELLED` is signature-verified and ledger-idempotent. The handler then performs `GET /v1/billing/subscriptions/{id}`. Only authoritative `CANCELLED` (or the existing terminal `EXPIRED` lifecycle) applies the established Free transition, clears the current PayPal payment-issue flag, preserves all user data, and completes the management attempt.

### Change plan and billing interval

`POST /api/subscription/paypal/change-plan` accepts only an internal `targetPlanCode` and UUID `changeAttemptId`; PayPal Plan IDs and subscription IDs are rejected. The backend resolves source and target Billing Plan IDs from trusted configuration, fetches both PayPal plans, and requires both `product_id` values to equal `PAYPAL_PRODUCT_ID`. This permits configured tier and monthly/yearly changes only when PayPal accepts revision under the same Product.

The request to `POST /v1/billing/subscriptions/{id}/revise` contains the trusted `plan_id`, plan-change return/cancel URLs, and a stable `PayPal-Request-Id`. PayPal-wallet subscriptions require buyer login and re-consent through the validated HTTPS `approve` HATEOAS link. If the buyer cancels approval, the authenticated callback closes only the local management attempt; the existing subscription and plan remain unchanged. Browser closure does not lose an approved operation because webhook correlation uses the provider subscription and target plan.

PayPal documents revised pricing as starting on the next billing cycle and does not automatically support proration or one-time fees. CoMarker does not guess proration, grant credits, refund credits, or change entitlement when revision is requested. After a verified `BILLING.SUBSCRIPTION.UPDATED`, fetch-back must show `ACTIVE` and the configured target Plan ID before the existing plan assignment and Assessment Credit wallet lifecycle runs. Event and credit-transaction idempotency prevent duplicate allowance changes.

Downgrades never delete classes, students, files, reports, or submissions. Existing usage counters remain intact, so the current limit middleware prevents additional resource creation when usage exceeds a lower plan's allowance.

### Later Sandbox checklist

1. Configure all four client Billing Plan IDs under the single configured Product.
2. Configure public HTTPS webhook, checkout return/cancel, and plan-change return/cancel URLs.
3. Create one Essential Monthly subscription and confirm `ACTIVATED` fetch-back.
4. Revise Essential Monthly to Pro Monthly, complete buyer approval, and confirm `UPDATED` fetch-back and one allowance transition.
5. Exercise Pro Monthly to Essential Monthly and each configured Monthly/Annual transition; record any PayPal `UNPROCESSABLE_ENTITY` response as `PAYPAL_PLAN_CHANGE_UNSUPPORTED` if provider policy rejects it.
6. Cancel an active Sandbox subscription and confirm no browser-response downgrade occurs before `CANCELLED` fetch-back.
7. Retry each action and replay each webhook to confirm attempt/event/credit idempotency.
8. Cancel a revision at PayPal and confirm the original subscription remains active with no pending UI.

Known limitations: real Sandbox behavior still requires the client's final Plan IDs and public webhook configuration; PayPal plan-change approval timing can vary; no provider proration is invented; and no destructive over-limit cleanup exists. PayPal Orders for one-time credit packs are documented separately in `docs/paypal-orders-credit-packs.md`. Stripe migration, Institution/seat billing, production credentials, and production cutover remain deferred.

## Phase 3 reliability correction

Active management operations are serialized by the database, not by a check-then-create sequence. Each `processing`, `approval_pending`, or `provider_pending` attempt owns the unique partial-indexed key `paypal:<providerSubscriptionId>`. Completion, buyer cancellation, and definitive failure unset that key. Concurrent cancellation requests reuse the winning cancellation; concurrent revisions with different attempt IDs receive a controlled conflict, so only the database owner may call PayPal.

`processing` has a two-minute lease. A live lease returns the existing in-flight state without replay. An expired lease can be atomically reclaimed and increments `retryCount`. Retryable provider/network failures move to `failed`, release the active key, and retain the attempt's original `providerRequestId`; the same attempt ID atomically reclaims ownership and replays with the identical `PayPal-Request-Id`. Provider 4xx validation/business failures are permanent and cannot be replayed. Cancel retries use the same policy by reclaiming the newest retryable failed cancellation.

The partial-success strategy assumes PayPal request idempotency for safe replay: if PayPal accepts revise/cancel but persisting `approvalUrl` or the next local status fails, the attempt deliberately remains `processing` with its owner and original provider request ID. After its bounded lease expires, recovery replays the same request identity rather than creating another revision. A verified authoritative webhook may also finalize retryable/partial failures and always releases active ownership.

The PayPal Manage component generates a UUID when a target is selected and retains it across transient HTTP retries and double-click suppression. Selecting a different target or explicitly abandoning the dialog discards that UUID. No sensitive information is stored.

## Official contracts audited

- [Cancel subscription](https://developer.paypal.com/api/subscriptions/v1/subscriptions-cancel)
- [Revise subscription](https://developer.paypal.com/api/subscriptions/v1/subscriptions-revise)
- [Upgrade or downgrade a subscription](https://developer.paypal.com/platforms/subscriptions/customize/revise-subscriptions/)
- [Subscription webhook events](https://developer.paypal.com/subscriptions/webhooks/)
- [PayPal Orders credit-pack flow](paypal-orders-credit-packs.md)
