# Production Smoke-Test Checklist

Run this checklist against the release candidate after deployment configuration is
validated. Use dedicated test accounts and test data. Do not run the live-AI steps
unless the operator has explicitly approved provider usage and cost.

## Platform and access

1. Confirm `/api/health` returns `200` without authentication.
2. Confirm the configured frontend origin passes CORS and an unapproved origin is rejected.
3. Sign in as a teacher and a student; confirm invalid and expired tokens return `401`.
4. Confirm a student cannot read or modify another student's submission.
5. Confirm a teacher cannot access a class they do not own.
6. Create a test class, join it as the student, and verify membership in both views.
7. Create a test assignment and attach a five-category rubric; verify both are readable by the class student.
8. Exercise an authentication endpoint until the documented sensitive-route limit returns `429`.
9. Confirm repeated health, result polling, static-file, and SSE reads are not throttled by the sensitive-route limiter.

## Submission and canonical evaluation

10. Upload a two-page handwritten submission and confirm both pages are ordered and represented in the canonical transcript.
11. Confirm the initial result response reports explicit processing state rather than a fabricated score.
12. Confirm LanguageTool and semantic corrections include one controlled global Content/Organization finding and are merged without duplicate/conflicting spans.
13. Confirm all correction offsets and quoted source text map to the canonical transcript.
14. Confirm correction statistics, detailed feedback, the persisted evaluation, and source hash all describe the same canonical result.
15. Confirm teacher and student result views show the same persisted overall and category scores.
16. Add a teacher comment and confirm it is visible only through the intended authorized views.
17. Refresh both result pages and confirm scores, corrections, statistics, and comments are unchanged.
18. Confirm a failed evaluation displays a clear unavailable/failed state and no numeric fallback.
19. Retry the failed evaluation and confirm it transitions to succeeded without creating a second canonical result.
20. Apply a teacher override, refresh, and confirm the override is preserved and audited.

## PDF, adaptive practice, and resilience

21. Generate teacher and student PDFs and confirm both use the persisted canonical score, including decimal and zero scores.
22. Generate adaptive practice, submit correct and incorrect answers, and confirm teacher monitoring sees the same deterministic progress.
23. Run one forced fallback through the safe test harness; then inspect PM2/reverse-proxy logs for bounded attempts, handle leaks, full student text, credentials, and other secret leakage.

## Live-AI opt-in

Only after explicit authorization, run one low-cost request for each enabled AI
feature through the central gateway. Record provider, model, latency, token usage,
fallback selection, and sanitized error metadata. Never record prompts containing
student personal data or provider credentials.
