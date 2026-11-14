# Assignment report: deployment notes

The whole-assignment report (Report button on an essay assignment card), its PDF export and its optional AI summary.

- Report page: `GET /api/assignments/:id/report?tz=<IANA zone>` (teacher only, 404 to anyone else).
- PDF: `GET /api/pdf/assignment-report/:id?tz=` (shared PDF renderer; 10 per 10 minutes and one at a time per teacher).
- AI summary: `POST /api/assignments/:id/report/summary` (teacher only, on request, no credit charge).

No new index and no migration. The report reads submissions by `{ assignment, class }` without a database sort and with light,
inclusion-only projections. The summary is stored on `Assignment.reportSummary` (`select: false`, never copied by Duplicate, never
serialised to students or guests).

## Environment variables (AI summary)

| Variable | Default | Meaning |
|---|---|---|
| `ASSIGNMENT_REPORT_SUMMARY_ENABLED` | unset = **off** | Only the exact value `true` turns the summary on. Off: the page shows no summary card, `POST .../report/summary` answers 404, and no stored summary is ever shown or put into the PDF. |
| `ASSIGNMENT_REPORT_SUMMARY_AI_MODEL` | `anthropic/claude-haiku-5.5` | OpenRouter model slug. Anything that is not a well-formed `vendor/model` slug falls back to the default. Changing it marks existing summaries out of date (they are regenerated on request). |

The summary uses the existing `OPENROUTER_API_KEY`. If OpenRouter is not configured, every request returns the deterministic insights
("fallback"); nothing breaks.

Limits (code constants, not env): 6 requests per 15 minutes per teacher, one at a time per teacher, 5 generations per assignment per
day (UTC), at least 3 scored submissions. A cached summary (unchanged data) is returned without calling the model and without using the
daily allowance. The model gets 15 s per attempt, 20 s in total, no retries, no fallback model, reasoning off.

## Turn the AI summary on

On the server, in the backend's environment file (the one PM2 loads):

```
ASSIGNMENT_REPORT_SUMMARY_ENABLED=true
# optional, the default is anthropic/claude-haiku-5.5
# ASSIGNMENT_REPORT_SUMMARY_AI_MODEL=anthropic/claude-haiku-5.5
```

Then restart with the new environment:

```
pm2 restart RoznaComarker_Backend --update-env
```

Check: open a report with at least 3 scored submissions; the "AI summary" card shows a "Generate summary" button. Logs carry ids, codes
and token counts only:

```
pm2 logs RoznaComarker_Backend --lines 300 --nostream | grep -E 'assignment_report_summary'
```

`assignment_report_summary_generated` lines show `inputTokens` / `outputTokens` per call (cost tracking); `assignment_report_summary_fallback`
lines show the reason code (`AI_UNAVAILABLE` or `AI_INVALID_OUTPUT`).

## Rollback

Remove `ASSIGNMENT_REPORT_SUMMARY_ENABLED` (or set it to anything but `true`) and run `pm2 restart RoznaComarker_Backend --update-env`.
The card disappears, the endpoint answers 404, stored summaries stay in the database unused and never reach the page or the PDF.

## Production check: query plan of the report's submission query

In `mongosh` on the production database (read-only; replace both ids with a real assignment and its class):

```
db.submissions.find(
  { assignment: ObjectId("<assignmentId>"), class: ObjectId("<classId>") },
  { _id: 1, submittedAt: 1, evaluationStatus: 1 }
).limit(3001).explain("queryPlanner").queryPlanner.winningPlan
```

Expected: an `IXSCAN` on `assignment_1` (or on one of the `class_1_assignment_1_...` compound indexes; both match the two equality
fields), a `FETCH`, a `LIMIT`, and **no `SORT` stage**. A `COLLSCAN` would mean the index is missing on that server.
