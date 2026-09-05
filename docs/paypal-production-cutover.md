# PayPal production cutover runbook

This is a human-controlled checklist. It must not be used to infer approval, perform provider migration, or run a Live transaction automatically.

## Pre-cutover

- Complete and sign off the entire Sandbox matrix; retain PayPal and internal attempt IDs.
- Pass all automated PayPal tests and the Angular production build.
- Verify the PayPal Business account and obtain a Live REST app and its credentials securely.
- Create/validate a distinct Live Catalog Product, four Live Billing Plans, and a Live webhook registration.
- Verify exact production callback routes and the production HTTPS certificate.
- Confirm database backup and restore procedures and assign a rollback owner.
- Prepare alerts for authentication/verification failures, failed or stale processing, mapping mismatches, and `review_required` records.

## Configuration

Set `PAYPAL_ENV=live`, the complete `PAYPAL_LIVE_*` credential/resource matrix, and the production `APP_PUBLIC_URL`. Start with `PAYPAL_LIVE_ENABLED=false`. Keep Sandbox and Live values distinct and stored in the deployment secret manager. Leave `PAYMENT_PROVIDER=stripe` unless a separately approved provider migration is scheduled. `PAYPAL_ENABLED=true` may keep PayPal management/webhooks available without making it the default new checkout provider.

## Dry run

With Live selected but disabled, run `npm run paypal:check`, then the read-only `npm run paypal:check:auth` and `npm run paypal:validate-resources`. Confirm all Product/Plan relationships, intervals, Mongo prices/currencies, and ACTIVE statuses. Confirm logs name only selected variable names, never values. Verify no Sandbox resource ID is reused and Stripe remains the selected/default provider.

## Enable

Only after recorded approval, set `PAYPAL_LIVE_ENABLED=true` and restart with configuration validation passing. If and only if new checkout migration is also approved, set `PAYMENT_PROVIDER=paypal` in a separate controlled configuration change. Do not alter historical Stripe subscriptions or ledger records.

## Controlled Live smoke test

Use a designated account and the smallest legitimate configured purchase. Verify browser checkout and approval, backend fetch-back reconciliation, verified webhook delivery, database attempt/event/transaction records, exactly-once entitlement or credits, and the receipt/dashboard. Do not perform this test from this runbook without business approval and a refund/accounting plan.

## Rollback

Set `PAYMENT_PROVIDER=stripe` to stop offering PayPal for new checkout and set `PAYPAL_LIVE_ENABLED=false` to block further Live mutations. Keep the PayPal webhook/configuration available as operational policy permits so already-active PayPal users can still be reconciled; if mutations are disabled, cancellations/changes require an explicit incident process. Do not delete PayPal attempts, provider-event ledgers, transactions, wallets, or subscription ownership fields. Do not downgrade users in bulk. Existing PayPal subscribers remain identified by their PayPal subscription fields and are managed/reconciled according to provider state; Stripe users remain untouched.

After rollback, preserve evidence, reconcile in-flight `processing`/`capturing` operations by fetch-back, resolve `review_required` records, and document the trigger before considering re-enable.
