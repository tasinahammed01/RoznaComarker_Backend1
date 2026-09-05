# PayPal Sandbox provisioning

This phase provisions only the shared PayPal Catalog Product and fixed recurring Billing Plans. It does not create customer subscriptions, process PayPal webhooks, grant memberships, sell Assessment Credit packs, or switch the active provider from Stripe.

## Prerequisites

- The intended environment's MongoDB `Plan` records are reviewed and authoritative.
- `PAYPAL_ENV=sandbox`.
- A PayPal Sandbox REST app Client ID and Client Secret are configured in the backend environment only.
- Run the utility manually from `backend`; it is not part of install, startup, tests, or deployment.

Required/provisioned backend variables:

```dotenv
PAYMENT_PROVIDER=stripe
PAYPAL_ENV=sandbox
PAYPAL_CLIENT_ID=
PAYPAL_CLIENT_SECRET=
PAYPAL_PRODUCT_ID=
PAYPAL_ESSENTIAL_MONTHLY_PLAN_ID=
PAYPAL_ESSENTIAL_ANNUAL_PLAN_ID=
PAYPAL_PRO_MONTHLY_PLAN_ID=
PAYPAL_PRO_ANNUAL_PLAN_ID=
PAYPAL_WEBHOOK_ID=
```

The plan variable names are derived from active paid MongoDB `Plan.slug` values. If those values differ in a deployment, the command prints the exact derived names. Keep `PAYMENT_PROVIDER=stripe` for this phase.

## Review without creating anything

```bash
npm run paypal:provision:sandbox -- --dry-run
# or: pnpm paypal:provision:sandbox --dry-run
```

Dry-run loads active MongoDB plans and prints their plan keys, intervals, prices, currencies, and whether IDs would be reused or created/discovered. It performs no PayPal requests and writes no manifest.

## Provision explicitly

```bash
npm run paypal:provision:sandbox
# or: pnpm paypal:provision:sandbox
```

The command:

1. refuses to run unless `PAYPAL_ENV=sandbox`;
2. uses an explicitly configured `PAYPAL_PRODUCT_ID` first;
3. otherwise reuses the Product ID in the ignored `.paypal/paypal-sandbox-manifest.json`;
4. otherwise considers exact-name candidates, fetches each Product, and reuses it only when name, description, `SERVICE` type, and `SOFTWARE` category all match;
5. stops on multiple verified discovery matches and requires an explicit ID;
6. otherwise creates a Product using only documented Catalog Products fields (`name`, `description`, `type`, and `category`) and lets PayPal generate its `PROD-...` ID;
7. discovers deterministic plan names only underneath that verified Product, then creates only missing resources;
8. treats list results and create responses only as sources of candidate IDs, then fetches each Plan with `GET /v1/billing/plans/{id}` before validation;
9. verifies every reused plan's ID, Product, status, REGULAR cycle, fixed price, currency, total cycles, and monthly/yearly frequency;
10. prints only safe Product/Plan IDs and the environment variable names to copy.

Catalog Products does not define `custom_id`; the provisioner neither sends nor relies on it. A merchant-specified Product `id` is also not used because PayPal disallows the system `PROD-` prefix for merchant input while Subscription Plans require a PayPal `PROD-...` Product ID.

The generated manifest contains only Sandbox resource IDs and pricing snapshots. It is ignored by Git. Put the printed IDs in the deployment secret/environment manager; do not commit merchant-specific IDs unless deployment policy explicitly calls for that.

If an existing ID differs from current MongoDB pricing, provisioning stops with `PAYPAL_PLAN_PRICE_MISMATCH`. Do not delete, edit, or silently replace the plan. Review the admin price change, decide whether a versioned PayPal plan is intended, and provision it through a separately reviewed action.

If a previous run created resources but stopped before the manifest was written, place the returned safe Product/Plan IDs in the corresponding backend environment variables before retrying. The provisioner also discovers same-name Plan candidates under the verified Product and validates their full GET representation. Missing fixed pricing is reported as `PAYPAL_PLAN_PRICING_MISSING`, separately from a genuine price or currency mismatch.

## Verify in PayPal Sandbox

Open the PayPal Developer Dashboard for the Sandbox business account and confirm:

- one `RoznaHub / CoMarker Subscription` SERVICE product;
- one ACTIVE fixed recurring plan for every printed paid plan/interval;
- amount and currency exactly match MongoDB pricing;
- monthly plans recur every month and yearly plans recur every year.

Do not create a PayPal plan for Free or for Assessment Credit packs. Packs are one-time purchases handled by the separate PayPal Orders flow.

## Webhook event separation

PayPal handling preserves required headers and verifies each notification using `PAYPAL_WEBHOOK_ID` before any state change. Subscription events include:

- `BILLING.SUBSCRIPTION.CREATED`, `ACTIVATED`, `UPDATED`, `CANCELLED`, `SUSPENDED`, and `EXPIRED`;
- `BILLING.SUBSCRIPTION.PAYMENT.FAILED`;
- `PAYMENT.SALE.COMPLETED`, `REFUNDED`, and `REVERSED`.

One-time Orders use the separate documented `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`, and `PAYMENT.CAPTURE.REVERSED` events described in `paypal-orders-credit-packs.md`; they never use Billing Plans.

Verified provider event IDs must be processed idempotently. A browser success redirect must never grant a Membership, plan entitlement, or credits.

Production requires separate live credentials, Product, Plans, webhook registration, validation, and an explicitly reviewed production provisioning/cutover process. This command intentionally cannot provision live resources.
