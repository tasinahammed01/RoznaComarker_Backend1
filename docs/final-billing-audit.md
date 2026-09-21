# Final billing hardening audit

Read-only source audit completed before implementation. Both repositories contained
uncommitted work at entry; a source-only baseline is retained in workspace tmp.

Confirmed root causes:

- Subscription creation discards the browser billing period and derives it from the
  Plan record. Combined monthly/annual records therefore always choose monthly.
- Change-plan context repeats that derivation; equality compares slugs and blocks
  same-tier interval changes. Prepared operations hold a fresh processing lease.
- Browser SDK revise and backend revise lack an exclusive transport claim.
- Reconcile controller unconditionally completes an attempt after fetching any
  correlated subscription. Completed revisions are excluded from webhook lookup.
- Checkout has unique attempt IDs but no per-user active-operation uniqueness.
- Credit cycles use historical Stripe dates and yearly increments; month arithmetic
  can drift at month end. Legacy Stripe status independently changes entitlement.
- Reverse provider mapping excludes inactive plans and combined annual mappings.
- Exact allowedPlans catalog queries disagree with case-insensitive purchase checks.
  Seeds define conflicting prices and one only inserts, so rerunning cannot repair
  eligibility. No production catalog evidence has yet established current prices.
- Active pack admin validation permits values rejected by customer policy.
- Admin adjustments generate new server keys on response-loss retries.
- Credit index metadata is checked on each mutation; SDK namespace cache can retain
  another configuration; checkout retries retain old buttons and replace attempt IDs.
- Top-up capability failure leaves no rendered payment action; capture errors lack
  a dedicated same-attempt recovery action.

Preserve existing durable purchase receipts, spend ordering, institution routing,
signature verification, provider fetch-back, and server-owned order values.
Production data, actual indexes and live provider resources require explicit
read-only verification; source declarations alone are not deployment evidence.
