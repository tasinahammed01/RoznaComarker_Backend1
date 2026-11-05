# Go / No-go: Release Candidate 3

This is the decision sheet, not a record of results. RC3 is RC2 plus the Gemini reader and the line-by-line word boxes. The test and boot rehearsal results are in the verification report of the task that produced them, and must be read before deciding.

## Conditions to NOT ship

- The production commit is not known (DEPLOY_RUNBOOK step 0).
- The check in DEPLOY_RUNBOOK step 1 reports any fatal problem, for example `AI_PRIMARY_PROVIDER`, `AI_PRIMARY_MODEL`, `OPENROUTER_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, `PAYMENT_PROVIDER` not `paypal`, a missing `OCR_SOURCE_MODE` or `OCR_GPT_VISION_MODEL`, or a model and reader that do not belong together (Gemini needs `verbatim_json`; Qwen needs `json_contract` or `plain_text`): the server will not start.
- `.env` has a duplicate key the check lists: the last occurrence wins, which may not be the value you meant.
- The flashcard indexes (DEPLOY_RUNBOOK step 4) are missing or different and have not been migrated: the server will not start.
- The two guest indexes (step 4) are missing or different and guest submission must work: uploads answer 503.
- An `AI_FALLBACK_n_MODEL` on `openrouter` has no provider prefix: the server starts, and that fallback fails when needed.
- `HEALTH_DETAIL_TOKEN` is not set: the deploy cannot be verified.
- No Atlas snapshot was taken.
- The manual checklist finds a teacher or student flow broken, in particular highlights on the source image.
- The new backend fails to boot against the real Atlas.
- The client has not been told about the known issues in KNOWN_RISKS.md numbers 1 to 3.

## Not proven by any automated check

A real browser, a real device (iPad Safari, touch), real AI providers, real email delivery, real PayPal calls, real Firebase sign-in, the VPS and the real Atlas (data volume, timings, MongoDB version).
