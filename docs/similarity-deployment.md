# Similarity Reporting: deployment and operation

Teacher-only "Match Overview" for essays: an overall similarity percentage, numbered sources with their own percentages, highlighted
passages, and exclude/restore. Students and guests never see a report, a source or a provider name.

## What it compares

- **Internal (always, no third party):** other marked essays in Rubrilo, by hashes of 5-word sequences (no text is stored in the index).
  Never the essay itself, or the same student's (or guest email's) essay for the same assignment. Words of the assignment brief, of its
  active reference files, inside quotes (`SIMILARITY_EXCLUDE_QUOTES`, default on), and phrasing found in 30% or more of the assignment's
  essays (with at least 5 essays) never count. A match needs `SIMILARITY_MIN_MATCH_WORDS` (8) words in a row.
- **External (optional):** an internet/repository search by the provider in `SIMILARITY_PROVIDER`, only for essays that carry the
  notice (`essay-similarity-2026-11`) or that the teacher uploaded and confirms permission for.

The overall percentage is always computed by Rubrilo: the union of matched words of the sources that are not excluded, divided by the
essay's words. Provider percentages are never used.

Who sees what for an internal match: a submission in the teacher's own class shows "Another submission in Rubrilo", its matched passages
and an Open link; any other submission shows only that label and its percentage.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `SIMILARITY_ENABLED` | off | `true` turns everything on (routes, worker, indexing). Off: every route answers 404. |
| `SIMILARITY_PROVIDER` | `none` | `copyscape`, `copyleaks`, `stub` (local QA only) or `none` (internal only). |
| `SIMILARITY_DAILY_CHECKS_PER_TEACHER` | 20 | Checks per teacher per UTC day. |
| `SIMILARITY_CHECKS_PER_SUBMISSION` | 3 | Checks per essay (a retry of a failed external check does not count). |
| `SIMILARITY_MAX_WORDS` | 2500 | Longer essays cannot be checked. |
| `SIMILARITY_DAILY_SPEND_USD` | 5 | Global stop on the estimated provider spend per UTC day; past it the external check is skipped. |
| `SIMILARITY_MIN_MATCH_WORDS` | 8 | Shortest match. |
| `SIMILARITY_EXCLUDE_QUOTES` | true | Quoted text never counts. |
| `SIMILARITY_INTERNAL_SCOPE` | `all` | `all`, `institution` or `own` (the teacher's own classes). |
| `SIMILARITY_COMMON_SHARE_PERCENT`, `SIMILARITY_COMMON_MIN_ESSAYS` | 30, 5 | Common phrasing rule. |
| `SIMILARITY_PROVIDER_TIMEOUT_MS` | 30000 | Per provider request. |
| `SIMILARITY_PROVIDER_DEADLINE_MINUTES` | 60 | An asynchronous check waits this long, asks for the webhook again once, then is marked expired (the internal result stays). |
| `COPYSCAPE_USERNAME`, `COPYSCAPE_API_KEY` | none | Copyscape Premium API. |
| `COPYSCAPE_TEST_MODE` | false | `true`: free test searches (x=1) that return Copyscape's example results. |
| `SIMILARITY_FULL_COMPARISONS` | 10 | Copyscape `c`: how many results get their matched text (needed for highlights). |
| `COPYLEAKS_EMAIL`, `COPYLEAKS_API_KEY` | none | Copyleaks API account. |
| `COPYLEAKS_SANDBOX` | false | `true`: Copyleaks sandbox (mock results, no credits). |
| `SIMILARITY_COPYLEAKS_USD_PER_CREDIT` | none | Your plan's price per credit (1 credit = 250 words). Copyleaks does not run without it. |
| `SIMILARITY_COPYLEAKS_RETENTION_HOURS` | 24 | Copyleaks keeps a scan this long (we also delete it after its export). |
| `SIMILARITY_WEBHOOK_BASE_URL` | none | Public HTTPS base of this API, e.g. `https://api.example.com` (Copyleaks only). |
| `SIMILARITY_WEBHOOK_SECRET` | none | 32+ random characters (Copyleaks only). |
| `SIMILARITY_WEBHOOK_BODY_LIMIT` | 10mb | JSON limit of the webhook routes (export files can be large). |

Invalid values are ignored (the default is used) and reported by variable name only.

## Steps to turn it on (production)

1. `npm run migrate:similarity-indexes` (production runs with autoIndex off; idempotent).
2. Optional: index existing marked essays for the internal comparison:
   `node scripts/backfillSimilarityFingerprints.js --dry-run`, then without `--dry-run` (add `--limit=N` to go in batches). Counts only.
3. Set `SIMILARITY_ENABLED=true` and the provider settings, then restart (PM2). With `SIMILARITY_PROVIDER=none` only the internal
   comparison runs.
4. Frontend: deployed with the backend; the panel and the notice appear only when the API answers (404 while off).

Rollback: `SIMILARITY_ENABLED=false` and restart. Data stays in `similarityreports`, `similarityfingerprints`, `similarityusages`.

## Copyscape

Synchronous: one POST per check (`o=csearch`, `f=json`, `c=SIMILARITY_FULL_COMPARISONS`, a hard spend limit `l` of the estimate + 2 cents).
Price: 3 cents for the first 200 words, 1 cent per extra 100 words or part. Copyscape returns no positions: the matched text (`textmatched`)
is located on the essay. Results without a full comparison are listed as "Found but not compared" (no highlight, no percentage).
Not documented by Copyscape: text length limits, whether `c` costs extra, data retention, rate limits. Get a written answer on retention
before real use.

**Cost trial (your own key, at most $0.10):**

    SIMILARITY_TRIAL=call-copyscape node scripts/similarityCostTrial.js --max-usd 0.10

It sends only a synthetic 200-word text and prints counts, field names and dollar amounts: a free test-mode call, the balance, one
check with `c=0`, the same with `c=5`, and the balance again (about 6 cents). Send me the printed lines.

## Copyleaks (built from the documentation; NOT verified against the live service)

Asynchronous, webhooks only (Copyleaks has no polling endpoint for results). Flow: login (token cached 48 h; login is limited to 12 per
15 minutes) -> `PUT /v3/scans/submit/file/{scanId}` (text as base64, internet only, never the Shared Data Hub, quotes excluded, minimum
words) -> `completed` webhook -> one export of the results and the crawled text -> Copyleaks uploads them to our webhook routes ->
export-completed webhook -> the report is completed and the scan deleted (`PATCH /v3.1/scans/delete`, purge).

What it needs before it can run:

- A **public HTTPS endpoint** reaching this API: `SIMILARITY_WEBHOOK_BASE_URL` + `/api/similarity/webhooks/copyleaks/...`.
  Nginx: allow request bodies up to 10 MB on that location, for example
  `location /api/similarity/webhooks/ { client_max_body_size 10m; proxy_pass ...; }` (the default 1 MB would refuse large export files).
- A **shared secret** `SIMILARITY_WEBHOOK_SECRET` (32+ characters). Every callback must carry it in `X-Similarity-Webhook-Secret`
  (we set it on the status webhook, every export upload and the export-completed webhook); status events must also carry the signed
  `developerPayload` (HMAC of the scan id). Anything else gets 404. Optional extra hardening: Copyleaks client certificates or, on
  Enterprise, its static IP list in the firewall.
- `SIMILARITY_COPYLEAKS_USD_PER_CREDIT` from your plan.

Until all of these are set, the provider reports "not configured" and the webhook routes answer 404.

**Copyleaks sandbox check (once the webhook is public):** set `COPYLEAKS_SANDBOX=true`, `SIMILARITY_PROVIDER=copyleaks`, run one check on a
synthetic essay, and confirm the report completes. Sandbox results are mock data; then one real check on a synthetic essay to confirm
credits and highlights. Repositories (Private Cloud Hubs, paid) and the Shared Data Hub are not used; both would store student essays at
Copyleaks and need a separate consent decision.

## Privacy

- Notice shown on the essay upload page (students and guests) while the feature is on; its version is stored on the submission. Essays
  submitted before it (no notice) get the internal comparison only. A teacher upload needs the teacher's confirmation for the external check.
- The report records which checks sent the essay out (`checks[].permitted`, provider audit). Provider names, scan ids and costs stay in a
  teacher-only audit block; the PDF never names the provider.
- The internal index holds hashes only. Another teacher's essay never shows its text, id, student or teacher.

## Caps and costs per check (estimates)

Copyscape: 300 words 4 cents, 500 words 6 cents, 1,000 words 11 cents. Copyleaks: 1 credit per 250 words at your plan's price. The daily
caps bound one teacher to `SIMILARITY_DAILY_CHECKS_PER_TEACHER` checks; the global stop bounds everyone together.
